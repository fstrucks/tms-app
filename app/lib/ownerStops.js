// Owner's load page: + Add stop (Marc approved Nov 27, 2026, via Sam). The owner edits the load's stops with the
// shared StopsEditor and saves through the SAME database function Dispatch uses, public.dispatch_save_stops
// (migration 20261018000700): SECURITY DEFINER, checks load_viewer_role() = owner / management / dispatcher on every
// call (drivers get not_allowed), 2–20 stops, at least one pickup and one delivery, one transaction. Kept stops are
// updated in place by id, so their check-off (completed_at / arrived_at), map pins and facility link stay; new stops
// are inserted and linked to the facility directory by the stops_link_facility trigger. No SQL change needed.
// Pure helpers + one thin RPC wrapper, unit-tested in tests/js/ownerAddStop.test.mjs.
import { stopsToForm, formToStops, addStop, saveStops, MAX_STOPS } from './dispatch.js';
import { isMissingFunction } from './homeCurrentLoad.js';

export { MAX_STOPS };
export const MIN_STOPS = 2;

// The + Add stop button: the load's owner only (not a driver / dispatcher / management viewer), once stops loaded.
export const canOwnerEditStops = (load) => !!load && (load.viewer_role == null || load.viewer_role === 'owner') && Array.isArray(load.stops);

// Open the editor with one new stop already in place: a delivery just before the final delivery (the load still
// ends where it did), or a pickup before the first delivery. Full (20 stops) → no new row.
export function openWithNewStop(stops, type = 'delivery', tz = '') {
  const list = stopsToForm(stops || []);
  return addStop(list, type === 'pickup' ? 'pickup' : 'delivery', tz, { beforeLastDelivery: true });
}

// Stops that were checked off may be moved or edited but never removed here (their check-off record would go).
export function removedDoneStops(original, list) {
  const keep = new Set((list || []).filter((x) => x.id != null).map((x) => String(x.id)));
  return (original || []).filter((x) => x.completed_at && !keep.has(String(x.id)));
}

const OWNER_ERRORS = {
  not_allowed: 'Only the load owner can change stops here.',
  load_not_found: 'Load not found. It may have been deleted.',
};
export const OWNER_STOPS_SETUP_MSG = 'Adding stops needs a database update that hasn’t been applied yet.';

// → { ok: true, stops } | { ok: false, errors?, error? }
export async function saveOwnerStops(supabase, loadId, original, list, { browserTz = null } = {}) {
  const { errors, payload } = formToStops(list, { browserTz });
  if (!payload) return { ok: false, errors };
  if (removedDoneStops(original, list).length) return { ok: false, error: 'A checked-off stop can’t be removed.' };
  const r = await saveStops(supabase, loadId, payload);
  if (r.ok) return r;
  if (isMissingFunction(r.cause)) return { ok: false, setup: true, error: OWNER_STOPS_SETUP_MSG };
  const k = Object.keys(OWNER_ERRORS).find((c) => String(r.cause?.message || '').includes(c));
  return { ok: false, error: k ? OWNER_ERRORS[k] : r.error };
}
