// POST { share_id }: stop your own share, or (owner / dispatch / management) stop a company share remotely.
// Records stopped_by and stopped_reason ('user' or 'office'). Never starts a share.
import { locationShareCtx, stopShare, json, SETUP } from '../../../lib/locationShareServer';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req, { deps } = {}) {
  const x = await locationShareCtx(req, deps); if (x.res) return x.res;
  let body; try { body = await req.json(); } catch { return json({ error: 'Bad request.' }, 400); }
  const r = await stopShare(x.db, { userId: x.user.id, role: x.role, companyId: x.companyId }, { shareId: body?.share_id, reason: body?.reason }, x.now());
  if (r.setupNeeded || r.error === SETUP.error) return json(SETUP, 409);
  if (r.error) return json({ error: r.error, code: r.code }, r.status || 400);
  return json({ ok: true, share: r.share, already: !!r.already });
}
