// GET: the caller's live share (if any), plus loads they can tie a new share to.
// POST: start sharing from this device only (never for someone else).
import { locationShareCtx, myShareState, startShare, json, SETUP } from '../../lib/locationShareServer';
import { isMissing } from '../../lib/truckServer';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req, { deps } = {}) {
  const x = await locationShareCtx(req, deps); if (x.res) return x.res;
  const r = await myShareState(x.db, { userId: x.user.id, ownerId: x.ownerId, companyId: x.companyId, role: x.role }, x.now());
  if (r.error) return isMissing(r.error) ? json(SETUP, 409) : json({ error: 'Couldn’t load location sharing.' }, 500);
  return json({ share: r.share, stopped_notice: r.stopped_notice || null, remind: r.remind, loads: r.loads, isOffice: r.isOffice, server_now: new Date(x.now()).toISOString() });
}

export async function POST(req, { deps } = {}) {
  const x = await locationShareCtx(req, deps); if (x.res) return x.res;
  let body; try { body = await req.json(); } catch { return json({ error: 'Bad request.' }, 400); }
  const r = await startShare(x.db, { userId: x.user.id, ownerId: x.ownerId, companyId: x.companyId, role: x.role }, body, x.now());
  if (r.setupNeeded) return json(SETUP, 409);
  if (r.error) return json({ error: r.error, code: r.code }, r.status || 400);
  return json({ ok: true, share: r.share });
}
