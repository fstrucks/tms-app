// Route handlers for the company export (E2). Owner only, signed-in user from auth.getUser(token).
// The export_jobs row (requested_by, trigger, created_at) is the audit record of each request.
import { bearer, userClient, serviceClient, isAuthRejection, isAuthUnavailable } from './packetServer.js';
import { timingSafeEqual, createHash } from 'node:crypto';
import { startExport, exportStatus, runAndChain, cleanupExports, runExportJob, kickNextRun, OPEN_JOB_MAX_MS } from './companyExportServer.js';

const json = (body, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
const BUSY = 'Couldn’t check your sign-in just now. Try again.';

async function caller(req, deps) {
  const token = bearer(req);
  if (!token) return { error: json({ error: 'Sign in first.' }, 401) };
  const uc = (deps.mkUserClient || userClient)(token);
  let data, error;
  try { ({ data, error } = await uc.auth.getUser(token)); } catch { return { error: json({ error: BUSY }, 503) }; }
  if (error && (isAuthUnavailable(error) || !isAuthRejection(error))) return { error: json({ error: BUSY }, 503) };
  if (error || !data?.user?.id) return { error: json({ error: 'Your sign-in expired. Please sign in again.' }, 401) };
  return { user: data.user };
}
const adminOf = (deps) => deps.admin || (deps.mkService ? deps.mkService() : serviceClient());
const SETUP = 'Exporting company data isn’t available yet.';
// Runs after the response when the platform allows it (Vercel waitUntil), else inline.
async function later(deps, fn) {
  if (deps.waitUntil) return deps.waitUntil(fn());
  try { const { waitUntil } = await import('@vercel/functions'); return waitUntil(fn()); } catch { return fn(); }
}

export async function getCompanyExport(req, deps = {}) {
  const c = await caller(req, deps); if (c.error) return c.error;
  const admin = adminOf(deps); if (!admin) return json({ error: SETUP, setupNeeded: true }, 503);
  const r = await exportStatus(admin, c.user);
  return json(r.body, r.status);
}

export async function postCompanyExport(req, deps = {}) {
  const c = await caller(req, deps); if (c.error) return c.error;
  const admin = adminOf(deps); if (!admin) return json({ error: SETUP, setupNeeded: true }, 503);
  const r = await startExport(admin, c.user, { now: deps.now || new Date(), env: deps.env || process.env });
  // Asking again while a job is open continues it (one run at a time; the lease keeps runs apart).
  // This is how a job moves on when CRON_SECRET is not set and the worker cannot call itself.
  const openId = r.jobId || (r.body?.already ? r.body.job_id : null);
  if (openId) await later(deps, () => runAndChain(admin, openId, deps).catch((e) => console.error('[company-export] run', openId, e?.code || e?.message)));
  return json(r.body, r.status);
}

const sha = (v) => createHash('sha256').update(String(v)).digest();
const bearerMatches = (h, secret) => { const m = /^Bearer\s+(.+)$/i.exec(String(h || '')); return !!m && timingSafeEqual(sha(m[1].trim()), sha(secret)); };

// Vercel Cron (daily) and the self-kick between runs. Same secret check as the account deletion cron.
export async function cronCompanyExport(req, deps = {}) {
  const env = deps.env || process.env;
  const secret = String(env.CRON_SECRET || '').trim();
  if (!secret) return json({ error: 'Export worker is off: CRON_SECRET is not set. Nothing was run.', code: 'no_cron_secret' }, 503);
  if (!bearerMatches(req.headers.get('authorization'), secret)) return json({ error: 'Not allowed.' }, 401);
  const admin = adminOf(deps); if (!admin) return json({ error: SETUP, setupNeeded: true }, 503);
  const jobId = new URL(req.url).searchParams.get('job');
  const chain = { ...deps, kick: deps.kick || ((id) => kickNextRun(id, env)) };
  if (jobId) {
    await later(deps, () => runAndChain(admin, jobId, chain).catch((e) => console.error('[company-export] run', jobId, e?.code || e?.message)));
    return json({ ok: true, accepted: jobId }, 202);
  }
  const now = deps.now || new Date();
  const cleaned = await cleanupExports(admin, { now });
  const open = await admin.from('export_jobs').select('id, created_at').in('status', ['queued', 'running']).gte('created_at', new Date(+now - OPEN_JOB_MAX_MS).toISOString()).order('created_at', { ascending: true }).limit(5);
  const continued = [];
  for (const j of open.data || []) {
    try { const r = await runExportJob(admin, j.id, deps); continued.push({ id: j.id, done: !!r.done, busy: !!r.busy, failed: r.failed || null }); if (!r.done && !r.busy && !r.failed) await chain.kick(j.id); }
    catch (e) { continued.push({ id: j.id, error: String(e?.code || e?.message || 'error').slice(0, 80) }); }
  }
  return json({ ok: true, cleaned, continued });
}
