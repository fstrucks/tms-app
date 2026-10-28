// POST → save a tester bug report (own row, user's own token, RLS insert auth.uid() = user_id, status 'new').
//        profile_id = the reporter's active company, resolved here on the server (never from the body).
// GET  → owner-only list of their testers' reports (404 for everyone else). See app/lib/bugReportsAdmin.js.
// If the bug_reports migration isn't applied yet → 503 { setupNeeded } and the form keeps the text.
import { userClient, serviceClient, bearer, isAuthRejection } from '../../lib/packetServer';
import { ownerProfile, listBugReports } from '../../lib/bugReportsAdmin';
import { buildBugRow, SETUP_MSG } from '../../lib/bugReport';
import { loadMyCompanies, resolveActive, readActiveCookie } from '../../lib/activeCompany';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const json = (b, s = 200) => Response.json(b, { status: s, headers: { 'Cache-Control': 'no-store' } });
const isMissing = (e) => !!e && (e.code === '42P01' || e.code === 'PGRST205' || e.code === 'PGRST204' || /does not exist|Could not find the/i.test(e.message || ''));

// The company the report is filed under: same rule as /api/account/active-company (cookie choice, checked
// against the caller's memberships, else owned, else most recently joined). null if none or the lookup fails;
// the report still saves, it just shows to no owner.
export async function reportProfileId(svc, uid, req) {
  if (!svc) return null;
  try {
    const r = await loadMyCompanies(svc, uid);
    if (r.error) { console.error('[bug-reports] companies', r.error?.code || 'error'); return null; }
    return resolveActive(r.companies, uid, readActiveCookie(req, uid))?.profile_id || null;
  } catch { return null; }
}

export async function POST(req, { deps: { mkUserClient = userClient, sb, mkService = serviceClient } = {} } = {}) {
  const token = bearer(req);
  if (!token) return json({ error: 'Sign in first.' }, 401);
  const uc = mkUserClient(token);
  const { data: u, error: uErr } = await uc.auth.getUser(token);
  if (uErr && !isAuthRejection(uErr)) return json({ error: 'Couldn’t check your sign-in just now. Try again.' }, 503);
  if (!u?.user) return json({ error: 'Your sign-in expired. Please sign in again.' }, 401);
  let body; try { body = await req.json(); } catch { return json({ error: 'Bad request.' }, 400); }
  const b = buildBugRow(body, u.user);
  if (b.error) return json({ error: b.error }, 400);
  const profile_id = await reportProfileId(sb === undefined ? mkService() : sb, u.user.id, req);
  const ins = (row) => uc.from('bug_reports').insert(row).select('id, created_at').single();
  let { data, error } = await ins({ ...b.row, status: 'new', profile_id });
  // Only the first bug_reports migration applied (no profile_id column yet): save without it.
  if (error && /profile_id/.test(error.message || '')) ({ data, error } = await ins({ ...b.row, status: 'new' }));
  if (error) {
    if (isMissing(error)) return json({ error: SETUP_MSG, setupNeeded: true }, 503);
    console.error('[bug-reports] insert', error);
    return json({ error: 'Couldn’t send your report. Please try again.' }, 500);
  }
  return json({ ok: true, id: data?.id ?? null, created_at: data?.created_at ?? null });
}

export async function GET(req, { deps: { mkUserClient = userClient, sb, mkService = serviceClient } = {} } = {}) {
  const token = bearer(req);
  if (!token) return json({ error: 'Sign in first.' }, 401);
  const uc = mkUserClient(token);
  const { data: u, error: uErr } = await uc.auth.getUser(token);
  if (uErr && !isAuthRejection(uErr)) return json({ error: 'Couldn’t check your sign-in just now. Try again.' }, 503);
  if (!u?.user) return json({ error: 'Your sign-in expired. Please sign in again.' }, 401);
  const o = await ownerProfile(uc, u.user.id);
  if (o.error) return json({ error: o.error }, 500);
  if (o.notOwner) return json({ error: 'Not found.' }, 404);
  const svc = sb || mkService();
  if (!svc) return json({ error: 'Bug reports aren’t set up on the server yet.' }, 503);
  const r = await listBugReports(svc, o.profile);
  if (r.setupNeeded) return json({ reports: [], setupNeeded: true, error: 'Bug reports aren’t switched on yet (the database update hasn’t been applied).' });
  if (r.error) return json({ error: r.error }, 500);
  return json({ reports: r.reports });
}
