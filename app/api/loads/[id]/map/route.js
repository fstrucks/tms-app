// Load page map + calculated truck miles (PR B). Server only: ORS_API_KEY never reaches the browser.
// GET  → cached pins/route/miles (never calls OpenRouteService).
// POST → compute only when the stop addresses changed, it was never done, or a temporary failure's cool-down is over.
// Scoping like the Truck tab (truckCtx): every query is filtered by user_id = ownerId. Drivers are read-only (GET only).
import { truckCtx, json } from '../../../../lib/truckServer';
import { serviceClient } from '../../../../lib/packetServer';
import { getRoute, ensureRoute } from '../../../../lib/loadRouteServer';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const SETUP = { setupNeeded: true, state: 'setup', message: 'The map needs a database update that hasn’t been applied yet.' };

function respond(r, canEdit) {
  if (r.notFound) return json({ error: 'Load not found.' }, 404);
  if (r.setupNeeded) return json(SETUP);
  if (r.error) return json({ error: r.error }, 500);
  return json({ ...r.view, canEdit });
}

export async function GET(req, { params, deps } = {}) {
  const c = await truckCtx(req, deps); if (c.res) return c.res;
  return respond(await getRoute(c.db, c.ownerId, params?.id, deps?.route), c.canEdit);
}

export async function POST(req, { params, deps } = {}) {
  const c = await truckCtx(req, deps); if (c.res) return c.res;
  if (!c.canEdit) return respond(await getRoute(c.db, c.ownerId, params?.id, deps?.route), false);
  let shared = deps?.shared;
  if (shared === undefined) { try { shared = serviceClient(); } catch { shared = null; } }
  return respond(await ensureRoute(c.db, c.ownerId, params?.id, { ...(deps?.route || {}), shared }), true);
}
