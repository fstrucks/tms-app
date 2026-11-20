// POST { share_id, lat, lng, accuracy_m?, speed_mps?, heading? }: one point from the person sharing.
// Rate-limited; never logs coordinates. Rejected after the share has ended (including expiry-on-read).
import { locationShareCtx, recordPing, json, SETUP } from '../../../lib/locationShareServer';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req, { deps } = {}) {
  const x = await locationShareCtx(req, deps); if (x.res) return x.res;
  let body; try { body = await req.json(); } catch { return json({ error: 'Bad request.' }, 400); }
  const r = await recordPing(x.db, { userId: x.user.id, companyId: x.companyId }, body, x.now());
  if (r.setupNeeded || r.error === SETUP.error) return json(SETUP, 409);
  if (r.error) return json({ error: r.error, code: r.code }, r.status || 400);
  return json({ ok: true, skipped: r.skipped || null, recorded_at: r.recorded_at || null });
}
