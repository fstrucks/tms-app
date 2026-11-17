// POST { share_id }: the until-off daily nudge was shown (or the user chose Keep sharing). In-app only; no email.
import { locationShareCtx, markReminded, json, SETUP } from '../../../lib/locationShareServer';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req, { deps } = {}) {
  const x = await locationShareCtx(req, deps); if (x.res) return x.res;
  let body; try { body = await req.json(); } catch { return json({ error: 'Bad request.' }, 400); }
  const r = await markReminded(x.db, { userId: x.user.id }, body?.share_id, x.now());
  if (r.setupNeeded || r.error === SETUP.error) return json(SETUP, 409);
  if (r.error) return json({ error: r.error }, r.status || 400);
  return json({ ok: true, remind: r.remind === true, share: r.share || null });
}
