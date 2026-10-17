// GET → scale tickets linked to this load, with net cargo and the same weight warnings as /truck.
// Read-only endpoint (any company role may view; drivers are read-only everywhere). Scoping: app/lib/truckServer.js.
import { truckCtx, loadTicketsForLoad, json } from '../../../../lib/truckServer';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req, { params, deps } = {}) {
  const c = await truckCtx(req, deps); if (c.res) return c.res;
  const r = await loadTicketsForLoad(c.db, c.ownerId, params?.id);
  if (r.notFound) return json({ error: 'Load not found.' }, 404);
  if (r.setupNeeded) return json({ tickets: [], setupNeeded: true, canEdit: c.canEdit });
  if (r.error) return json({ error: r.error }, 500);
  return json({ tickets: r.tickets, loadWeight: r.load.weight ?? null, canEdit: c.canEdit });
}
