// Server side of the load map (PR B). Calls OpenRouteService (HeiGIT) with ORS_API_KEY; the key never leaves the
// server and is never logged. Results are cached on stops/loads (see loadRoute.js), so ORS is only called when
// stop addresses change (or after a cool-down for a temporary failure).
import {
  ORS_BASE, ORS_DIRECTIONS_PATH, ERROR_TEXT, PERMANENT_ERRORS, LIMITS,
  routeStops, routeFreshness, needsGeocode, stopAddressText, geocodeAttempts, pickGeocode,
  parseDirections, classifyOrsError, calculatedMilesPatch, hasRouteColumns, hasStopGeoColumns, createLimiter,
} from './loadRoute.js';
import { isMissing, UUID } from './truckServer.js';

export const ORS_TIMEOUT_MS = 10_000;          // geocoding
export const ORS_ROUTE_TIMEOUT_MS = 25_000;    // directions (long truck routes can take 10s+); maxDuration is 60
const limiter = createLimiter();
const inflight = new Map(); // loadId → Promise (one compute per load per instance at a time)

export const orsKey = (env = process.env) => (env.ORS_API_KEY || '').trim() || null;

async function orsFetch(fetchImpl, url, init, timeoutMs) {
  try {
    const res = await fetchImpl(url, { ...init, cache: 'no-store', signal: AbortSignal.timeout(timeoutMs) });
    let body = null; try { body = await res.json(); } catch {}
    return { ok: res.ok, status: res.status, body };
  } catch (e) {
    return { ok: false, status: null, body: null, timedOut: e?.name === 'TimeoutError' || e?.name === 'AbortError' };
  }
}

// One stop → { lat, lng, precision } | { error } | null (not found). Street address first, then city/state/zip.
export async function geocodeStop(stop, { key, fetchImpl = fetch, take = (k) => limiter.take(k), timeoutMs = ORS_TIMEOUT_MS } = {}) {
  for (const a of geocodeAttempts(stop)) {
    if (!take('geocode')) return { error: 'rate_limited' };
    const qs = new URLSearchParams(a.params).toString();
    const r = await orsFetch(fetchImpl, `${ORS_BASE}${a.path}?${qs}`, { headers: { Authorization: key, Accept: 'application/json' } }, timeoutMs);
    if (!r.ok) {
      const code = classifyOrsError(r);
      if (code === 'no_route') continue; // a 400/404 for this query: try the next, broader one
      return { error: code };
    }
    const hit = pickGeocode(r.body, stop, a.precision);
    if (hit) return hit;
  }
  return null;
}

export async function fetchRoute(points, { key, fetchImpl = fetch, take = (k) => limiter.take(k), timeoutMs = ORS_ROUTE_TIMEOUT_MS } = {}) {
  if (!take('directions')) return { error: 'rate_limited' };
  const r = await orsFetch(fetchImpl, `${ORS_BASE}${ORS_DIRECTIONS_PATH}`, {
    method: 'POST',
    headers: { Authorization: key, 'Content-Type': 'application/json', Accept: 'application/json' },
    // radiuses: a city-level point may be off the road network; allow snapping up to 5 km.
    body: JSON.stringify({ coordinates: points.map((p) => [p.lng, p.lat]), units: 'mi', instructions: false, radiuses: points.map(() => 5000) }),
  }, timeoutMs);
  if (!r.ok) return { error: classifyOrsError(r) };
  const parsed = parseDirections(r.body);
  return parsed || { error: 'no_route' };
}

// Database-wide guard (all companies share one ORS key): route attempts in the last minute / UTC day,
// counted on loads.route_computed_at. Best effort: returns true when it can't count.
export async function underSharedLimit(db, now = Date.now()) {
  if (!db) return true;
  try {
    const minAgo = new Date(now - 60_000).toISOString();
    const day = new Date(now).toISOString().slice(0, 10) + 'T00:00:00.000Z';
    const [m, d] = await Promise.all([
      db.from('loads').select('id', { count: 'exact', head: true }).gte('route_computed_at', minAgo),
      db.from('loads').select('id', { count: 'exact', head: true }).gte('route_computed_at', day),
    ]);
    if (m.error || d.error) return true;
    return (m.count ?? 0) < LIMITS.directions.perMinute && (d.count ?? 0) < LIMITS.directions.perDay;
  } catch { return true; }
}

// What the map card needs. Never includes the key.
export function viewOf(load, stops, extra = {}) {
  const rs = routeStops(stops);
  const fr = routeFreshness(load, rs);
  const missed = rs.filter((s) => s.lat == null || s.lng == null);
  let state = 'ready', message = null;
  if (fr.reason === 'too_few') { state = 'too_few'; message = ERROR_TEXT.too_few; }
  else if (load.route_error) {
    state = 'error';
    message = load.route_error === 'geocode_miss'
      ? ERROR_TEXT.geocode_miss.replace('{stops}', missed.map((s) => `the ${s.stop_type || 'stop'} address`).join(' and ') || 'a stop address')
      : ERROR_TEXT[load.route_error] || ERROR_TEXT.upstream;
  }
  return {
    state, message, stale: !fr.fresh, retryInMs: fr.retryInMs ?? null,
    stops: rs.map((s) => ({ id: s.id, stop_type: s.stop_type, sequence: s.sequence, city: s.city, state: s.state, lat: s.lat ?? null, lng: s.lng ?? null, precision: s.geocode_precision ?? null })),
    geometry: PERMANENT_ERRORS.has(load.route_error) ? null : load.route_geometry || null,
    calculated_miles: load.calculated_miles ?? null,
    load: { total_miles: load.total_miles ?? null, rate_per_mile: load.rate_per_mile ?? null, calculated_miles: load.calculated_miles ?? null, ...(Object.prototype.hasOwnProperty.call(load, 'miles_source') ? { miles_source: load.miles_source } : {}) },
    ...extra,
  };
}

async function readLoad(db, ownerId, loadId) {
  if (!UUID.test(loadId || '')) return { notFound: true };
  const l = await db.from('loads').select('*').eq('id', loadId).eq('user_id', ownerId).maybeSingle();
  if (l.error) return { error: 'Could not load the load.' };
  if (!l.data) return { notFound: true };
  if (!hasRouteColumns(l.data)) return { setupNeeded: true };
  const s = await db.from('stops').select('*').eq('load_id', loadId).order('sequence');
  if (s.error) return isMissing(s.error) ? { setupNeeded: true } : { error: 'Could not load the stops.' };
  const stops = s.data || [];
  if (stops.length && !hasStopGeoColumns(stops[0])) return { setupNeeded: true };
  return { load: l.data, stops };
}

// GET: cached view only, never calls ORS.
export async function getRoute(db, ownerId, loadId, { env = process.env } = {}) {
  const r = await readLoad(db, ownerId, loadId);
  if (!r.load) return r;
  if (!orsKey(env)) return { view: { ...viewOf(r.load, r.stops), state: 'no_key', message: ERROR_TEXT.no_key, stale: false } };
  return { view: viewOf(r.load, r.stops) };
}

// POST: compute when stale (addresses changed / never done / cool-down over), else return the cache.
export async function ensureRoute(db, ownerId, loadId, opts = {}) {
  const k = `${ownerId}:${loadId}`;
  if (inflight.has(k)) return inflight.get(k);
  const p = ensureRouteNow(db, ownerId, loadId, opts).finally(() => inflight.delete(k));
  inflight.set(k, p);
  return p;
}

async function ensureRouteNow(db, ownerId, loadId, { env = process.env, fetchImpl = fetch, take, shared = null, now = () => Date.now() } = {}) {
  const r = await readLoad(db, ownerId, loadId);
  if (!r.load) return r;
  const key = orsKey(env);
  if (!key) return { view: { ...viewOf(r.load, r.stops), state: 'no_key', message: ERROR_TEXT.no_key, stale: false } };
  let { load, stops } = r;
  const rs = routeStops(stops);
  const fr = routeFreshness(load, rs, now());
  if (fr.fresh) return { view: viewOf(load, stops), computed: false };
  if (!(await underSharedLimit(shared, now()))) return { view: { ...viewOf(load, stops), state: 'error', message: ERROR_TEXT.rate_limited, stale: true }, computed: false };

  const o = { key, fetchImpl, ...(take ? { take } : {}) };
  const stamp = new Date(now()).toISOString();
  let failure = null;
  const updatedStops = new Map();
  for (const s of rs) {
    if (!needsGeocode(s)) continue;
    const g = await geocodeStop(s, o);
    if (g?.error) { failure = g.error; break; }
    const patch = g
      ? { lat: g.lat, lng: g.lng, geocoded_at: stamp, geocode_address: stopAddressText(s), geocode_precision: g.precision }
      : { lat: null, lng: null, geocoded_at: stamp, geocode_address: stopAddressText(s), geocode_precision: null };
    const u = await db.from('stops').update(patch).eq('id', s.id).eq('load_id', loadId);
    if (u.error) return isMissing(u.error) ? { setupNeeded: true } : { error: 'Could not save the stop location.' };
    updatedStops.set(s.id, patch);
    if (!g) failure = failure || 'geocode_miss';
  }
  stops = stops.map((s) => (updatedStops.has(s.id) ? { ...s, ...updatedStops.get(s.id) } : s));
  const pts = routeStops(stops);

  let patch;
  if (failure) patch = { route_key: fr.key, route_computed_at: stamp, route_error: failure, ...(failure === 'geocode_miss' ? { route_geometry: null } : {}) };
  else {
    const route = await fetchRoute(pts.map((s) => ({ lat: s.lat, lng: s.lng })), o);
    if (route.error) patch = { route_key: fr.key, route_computed_at: stamp, route_error: route.error, ...(route.error === 'no_route' ? { route_geometry: null } : {}) };
    else patch = { route_key: fr.key, route_computed_at: stamp, route_error: null, route_geometry: route.geometry, calculated_miles: route.miles };
  }
  // A permanent failure, or any failure for changed addresses, clears the old route, so a stale number isn't offered.
  if (patch.route_error && (PERMANENT_ERRORS.has(patch.route_error) || load.route_key !== fr.key)) { patch.calculated_miles = null; patch.route_geometry = null; }

  const u = await db.from('loads').update(patch).eq('id', loadId).eq('user_id', ownerId).select('*');
  if (u.error) return isMissing(u.error) ? { setupNeeded: true } : { error: 'Could not save the route.' };
  load = { ...load, ...(u.data?.[0] || patch) };

  // Planned miles: fill only when empty or already calculated (typed > rate con > calculated). Conditional
  // updates, so a value typed meanwhile is never replaced.
  if (!patch.route_error && patch.calculated_miles) {
    const mp = calculatedMilesPatch(load, patch.calculated_miles);
    if (mp.total_miles != null) {
      const fill = { total_miles: mp.total_miles, miles_source: 'calculated' };
      let f = await db.from('loads').update(fill).eq('id', loadId).eq('user_id', ownerId).is('total_miles', null).select('*');
      if (!f.error && !f.data?.length && load.miles_source === 'calculated' && load.total_miles !== mp.total_miles)
        f = await db.from('loads').update(fill).eq('id', loadId).eq('user_id', ownerId).eq('miles_source', 'calculated').select('*');
      if (!f.error && f.data?.[0]) load = { ...load, ...f.data[0] };
    }
  }
  return { view: viewOf(load, stops), computed: true };
}
