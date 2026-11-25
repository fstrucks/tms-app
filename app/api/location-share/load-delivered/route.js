// POST { load_id }: the browser tells us it just moved a load to delivered (load page, Home, dispatch editor). If the load
// is delivered in the database and belongs to the caller's company, shares tied to it with auto-stop on end (reason 'delivered').
import { locationShareCtx, notifyLoadDelivered, json, SETUP } from '../../../lib/locationShareServer';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req, { deps } = {}) {
  const x = await locationShareCtx(req, deps); if (x.res) return x.res;
  let body; try { body = await req.json(); } catch { return json({ error: 'Bad request.' }, 400); }
  const r = await notifyLoadDelivered(x.db, { userId: x.user.id, role: x.role, ownerId: x.ownerId, companyId: x.companyId }, body?.load_id, x.now());
  if (r.setupNeeded) return json(SETUP, 409);
  if (r.error) return json({ error: r.error }, r.status || 400);
  return json({ ok: true, stopped: r.stopped });
}
