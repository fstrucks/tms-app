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

function respond(r, canEdit, gate = {}) {
  if (r.notFound || gate.hidden) return json({ error: 'Load not found.', state: 'failed' }, 404);
  if (r.setupNeeded) return json(SETUP);
  if (r.error) return json({ error: r.error, state: 'failed', retry: true }, 500);
  const view = gate.canSeeRate === false ? redactRate(r.view) : r.view;
  return json({ ...view, canEdit });
}

// PR #110 QA (rate leak): the map view carried load.rate_per_mile from the service client, so a driver got the RPM
// even with "Show rate to driver" off (the load page then showed Rate/mile + RPM). Same rule as visible_loads():
// owner / management / dispatcher see the rate; a driver only on a load assigned to him with show_rate_to_driver on.
// A driver who isn't assigned to the load gets 404 (visible_loads() wouldn't show it to him either).
export const RATE_ROLES = new Set(['owner', 'management', 'dispatcher']);
export function redactRate(view) {
  if (!view?.load) return view;
  const { rate_per_mile, rate, ...load } = view.load; // eslint-disable-line no-unused-vars
  return { ...view, load };
}
async function rateGate(c, loadId) {
  if (RATE_ROLES.has(c.role)) return { canSeeRate: true };
  const { data } = await c.db.from('loads').select('assigned_driver_user_id,show_rate_to_driver').eq('id', loadId).eq('user_id', c.ownerId).maybeSingle();
  if (!data || data.assigned_driver_user_id !== c.user.id) return { hidden: true, canSeeRate: false };
  return { canSeeRate: data.show_rate_to_driver === true };
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
      const gate = await rateGate(c, params?.id);
      if (gate.hidden) return respond({}, false, gate);
      return respond(await getRoute(c.db, c.ownerId, params?.id, deps?.route), c.canEdit, gate);
    } catch (e) { return crashed('GET', e); }
  })(), deadlineOf(deps), late);
}

export async function POST(req, { params, deps } = {}) {
  return withDeadline((async () => {
    try {
      const c = await mapCtx(req, deps); if (c.res) return c.res;
      const gate = await rateGate(c, params?.id);
      if (gate.hidden) return respond({}, false, gate);
      if (!c.canEdit) return respond(await getRoute(c.db, c.ownerId, params?.id, deps?.route), false, gate);
      let shared = deps?.shared;
      if (shared === undefined) { try { shared = serviceClient(); } catch { shared = null; } }
      return respond(await ensureRoute(c.db, c.ownerId, params?.id, { ...(deps?.route || {}), shared }), true, gate);
    } catch (e) { return crashed('POST', e); }
  })(), deadlineOf(deps), late);
}
