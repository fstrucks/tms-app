// Load page map + calculated truck miles (PR B). Server only: ORS_API_KEY never reaches the browser.
// GET  → cached pins/route/miles (never calls OpenRouteService).
// POST → ONE short step when stale (geocode one stop, or fetch the route); the page calls again while `next` is set.
// Auth like the fields API (Bearer token; database-verified fallback when Supabase Auth can't answer). Scoping like
// the Truck tab: every query is filtered by user_id = ownerId. Drivers are read-only (POST returns the cache).
// Every path answers JSON, including unexpected errors (QA #83: the browser saw ERR_CONNECTION_CLOSED).
import { json } from '../../../../lib/truckServer';
import { serviceClient } from '../../../../lib/packetServer';
import { mapCtx, getRoute, ensureRoute, withDeadline, HANDLER_DEADLINE_MS } from '../../../../lib/loadRouteServer';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30; // every request answers by HANDLER_DEADLINE_MS (20 s); ORS work per step ≤ 15 s

const SETUP = { setupNeeded: true, state: 'setup', message: 'The map needs a database update that hasn’t been applied yet.' };

function respond(r, canEdit) {
  if (r.notFound) return json({ error: 'Load not found.', state: 'failed' }, 404);
  if (r.setupNeeded) return json(SETUP);
  if (r.error) return json({ error: r.error, state: 'failed', retry: true }, 500);
  return json({ ...r.view, canEdit });
}
const crashed = (where, e) => {
  console.error(`[map] ${where}`, String(e?.name || ''), String(e?.message || e).slice(0, 200));
  return json({ error: 'Couldn’t load the map. Try again.', state: 'failed', retry: true }, 500);
};

// QA #83 r2: always reply before maxDuration, even if something below hangs.
const late = () => json({ error: 'The map service didn’t answer. The route will be tried again in a few minutes.', state: 'failed', retry: true, late: true }, 503);
const deadlineOf = (deps) => deps?.deadlineMs ?? HANDLER_DEADLINE_MS;

export async function GET(req, { params, deps } = {}) {
  return withDeadline((async () => {
    try {
      const c = await mapCtx(req, deps); if (c.res) return c.res;
      return respond(await getRoute(c.db, c.ownerId, params?.id, deps?.route), c.canEdit);
    } catch (e) { return crashed('GET', e); }
  })(), deadlineOf(deps), late);
}

export async function POST(req, { params, deps } = {}) {
  return withDeadline((async () => {
    try {
      const c = await mapCtx(req, deps); if (c.res) return c.res;
      if (!c.canEdit) return respond(await getRoute(c.db, c.ownerId, params?.id, deps?.route), false);
      let shared = deps?.shared;
      if (shared === undefined) { try { shared = serviceClient(); } catch { shared = null; } }
      return respond(await ensureRoute(c.db, c.ownerId, params?.id, { ...(deps?.route || {}), shared }), true);
    } catch (e) { return crashed('POST', e); }
  })(), deadlineOf(deps), late);
}
