// POST → save a tester bug report (own row, user's own token, RLS insert auth.uid() = user_id).
// If the bug_reports migration isn't applied yet → 503 { setupNeeded } and the form keeps the text.
import { userClient, bearer, isAuthRejection } from '../../lib/packetServer';
import { buildBugRow, SETUP_MSG } from '../../lib/bugReport';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const json = (b, s = 200) => Response.json(b, { status: s, headers: { 'Cache-Control': 'no-store' } });
const isMissing = (e) => !!e && (e.code === '42P01' || e.code === 'PGRST205' || e.code === 'PGRST204' || /does not exist|Could not find the/i.test(e.message || ''));

export async function POST(req, { deps: { mkUserClient = userClient } = {} } = {}) {
  const token = bearer(req);
  if (!token) return json({ error: 'Sign in first.' }, 401);
  const uc = mkUserClient(token);
  const { data: u, error: uErr } = await uc.auth.getUser(token);
  if (uErr && !isAuthRejection(uErr)) return json({ error: 'Couldn’t check your sign-in just now. Try again.' }, 503);
  if (!u?.user) return json({ error: 'Your sign-in expired. Please sign in again.' }, 401);
  let body; try { body = await req.json(); } catch { return json({ error: 'Bad request.' }, 400); }
  const b = buildBugRow(body, u.user);
  if (b.error) return json({ error: b.error }, 400);
  const { data, error } = await uc.from('bug_reports').insert(b.row).select('id, created_at').single();
  if (error) {
    if (isMissing(error)) return json({ error: SETUP_MSG, setupNeeded: true }, 503);
    console.error('[bug-reports] insert', error);
    return json({ error: 'Couldn’t send your report. Please try again.' }, 500);
  }
  return json({ ok: true, id: data?.id ?? null, created_at: data?.created_at ?? null });
}
