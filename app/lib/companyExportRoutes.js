// Route handlers for the company export (E2). Owner only, signed-in user from auth.getUser(token).
// The export_jobs row (requested_by, trigger, created_at) is the audit record of each request.
import { bearer, userClient, serviceClient, isAuthRejection, isAuthUnavailable } from './packetServer.js';
import { cronAuthorized } from './accountDeletion.js';
import { startExport, exportStatus, ownerNewLink, runAndChain, cleanupExports, runExportJob, kickNextRun, OPEN_JOB_MAX_MS } from './companyExportServer.js';

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
  const body = await req.json().catch(() => ({}));
  if (body?.action === 'link') { const l = await ownerNewLink(admin, c.user, { now: deps.now || new Date(), env: deps.env || process.env }); return json(l.body, l.status); }
  const r = await startExport(admin, c.user, { now: deps.now || new Date() });
  if (r.jobId) await later(deps, () => runAndChain(admin, r.jobId, deps).catch((e) => console.error('[company-export] run', r.jobId, e?.code || e?.message)));
  return json(r.body, r.status);
}

// Vercel Cron (daily) and the self-kick between runs. Same secret check as the account deletion cron.
export async function cronCompanyExport(req, deps = {}) {
  const env = deps.env || process.env;
  if (!String(env.CRON_SECRET || env.ACCOUNT_DELETION_CRON_SECRET || '')) return json({ error: 'Export worker is not configured.' }, 503);
  if (!cronAuthorized(req.headers.get('authorization'), req.headers.get('x-account-deletion-secret'), env)) return json({ error: 'Not allowed.' }, 401);
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
  // Retry link emails that did not go out (at most 3 tries each; see companyExportLink).
  const { deliverExport } = await import('./companyExportLink.js');
  const unsent = await admin.from('export_jobs').select('id, cursor').eq('status', 'ready').is('cleaned_at', null).gte('expires_at', now.toISOString()).limit(20);
  const mailed = [];
  for (const j of unsent.data || []) {
    if (j.cursor?.mail_sent_at || j.cursor?.mail_unknown) continue;
    try { mailed.push({ id: j.id, ...(await (deps.deliver || deliverExport)(admin, j.id, { now, env, ...(deps.mailDeps || {}) })) }); } catch (e) { mailed.push({ id: j.id, error: String(e?.code || e?.message || 'error').slice(0, 80) }); }
  }
  return json({ ok: true, cleaned, continued, mailed });
}
