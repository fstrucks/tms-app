// GET: live shares for this company. Owner, management, and dispatchers only. Other drivers get 403 and see nothing.
import { locationShareCtx, officeShares, json, SETUP } from '../../../lib/locationShareServer';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req, { deps } = {}) {
  const x = await locationShareCtx(req, deps); if (x.res) return x.res;
  const r = await officeShares(x.db, { userId: x.user.id, role: x.role, companyId: x.companyId, ownerId: x.ownerId }, x.now());
  if (r.setupNeeded || r.error === SETUP.error) return json(SETUP, 409);
  if (r.error) return json({ error: r.error }, r.status || 400);
  return json({ shares: r.shares, server_now: new Date(x.now()).toISOString() });
}
