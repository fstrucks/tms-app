// Server side of the home card's map panel (Panel 2). Calls OpenRouteService (HeiGIT) driving-hgv with ORS_API_KEY;
// the key never leaves the server and is never logged.
// PRIVACY: nothing here stores or logs driver location. The origin arrives in the POST body (never the URL, so it
// isn't in request logs), is rounded to ORIGIN_DECIMALS before it goes to HeiGIT, lives only in a 10-minute
// in-memory cache key, and every log line carries error codes only. No SQL, no database writes.
// Access: public.visible_loads(p_load) as the caller, so a driver only reaches loads assigned to them.
import { mapCtx, fetchRoute, takeDirections, orsKey } from './loadRouteServer.js';
import { userClient } from './packetServer.js';
import { createLimiter, routeKey, routeStops, PERMANENT_ERRORS, decodePolyline } from './loadRoute.js';
import { isMissingFunction } from './homeCurrentLoad.js';
import { isMissing, UUID } from './truckServer.js';
import {
  parseOrigin, roundCoord, ETA_LIMITS, SERVER_CACHE_TTL_MS, SERVER_CACHE_MAX, USER_MIN_GAP_MS, USER_PER_DAY,
  ORS_ETA_TIMEOUT_MS, ERROR_RETRY_MS,
} from './loadEta.js';

export const ETA_RADIUSES = [2000, 5000]; // origin may be in a yard / truck stop lot; stop pins may be city-level

const etaLimiter = createLimiter(ETA_LIMITS);

// Small TTL cache (per serverless instance). Values hold miles/seconds/geometry only.
export function createEtaCache({ ttlMs = SERVER_CACHE_TTL_MS, max = SERVER_CACHE_MAX } = {}) {
  const m = new Map();
  return {
    get(k, now = Date.now()) { const v = m.get(k); if (!v) return null; if (now - v.at > ttlMs) { m.delete(k); return null; } return v.value; },
    set(k, value, now = Date.now()) { if (m.size >= max) m.delete(m.keys().next().value); m.set(k, { at: now, value }); },
    size: () => m.size,
  };
}

// Per-user floor: ≤ 1 ORS call every USER_MIN_GAP_MS and ≤ USER_PER_DAY a UTC day.
export function createUserGate({ gapMs = USER_MIN_GAP_MS, perDay = USER_PER_DAY } = {}) {
  const u = new Map();
  return {
    check(id, now = Date.now()) {
      const day = new Date(now).toISOString().slice(0, 10);
      const r = u.get(id);
      if (!r) return { ok: true };
      if (r.day === day && r.count >= perDay) return { ok: false, retryInMs: Date.parse(`${day}T00:00:00Z`) + 86_400_000 - now };
      if (now - r.last < gapMs) return { ok: false, retryInMs: gapMs - (now - r.last) };
      return { ok: true };
    },
    record(id, now = Date.now()) {
      const day = new Date(now).toISOString().slice(0, 10);
      const r = u.get(id);
      if (!r || r.day !== day) u.set(id, { day, count: 1, last: now });
      else { r.count += 1; r.last = now; }
    },
  };
}

const defaultCache = createEtaCache();
const defaultGate = createUserGate();

export const cacheKey = (loadId, stopId, o) => `${loadId}:${stopId}:${o.lat.toFixed(2)}:${o.lng.toFixed(2)}`;

// → { c } with c = mapCtx result + visible load, or { res }-style objects for the route to answer.
export async function etaCtx(req, loadId, deps = {}) {
  const mk = deps.mkUserClient || userClient;
  let uc = null;
  const c = await mapCtx(req, { ...deps, mkUserClient: (t) => (uc = mk(t)) });
  if (c.res) return c;
  if (!UUID.test(loadId || '')) return { notFound: true };
  const v = await uc.rpc('visible_loads', { p_statuses: null, p_load: loadId });
  let load = null;
  if (!v.error) {
    const rows = (v.data || []).map((r) => (r && r.visible_loads) || r);
    load = rows.find((r) => r && r.id === loadId) || null;
  } else if (isMissingFunction(v.error) && c.ownerId === c.user.id) {
    // Before 20261018000600: owner only, own rows.
    const l = await c.db.from('loads').select('id, status, total_miles, stops(*)').eq('id', loadId).eq('user_id', c.ownerId).maybeSingle();
    if (l.error && !isMissing(l.error)) return { error: 'Could not load the load.' };
    load = l.data || null;
  } else if (!isMissingFunction(v.error)) {
    return { error: 'Could not load the load.' };
  }
  if (!load) return { notFound: true };
  return { ...c, load, stops: load.stops || [] };
}

const pubStop = (s) => ({ id: s.id, stop_type: s.stop_type, sequence: s.sequence, city: s.city, state: s.state, lat: s.lat ?? null, lng: s.lng ?? null, timezone: s.timezone ?? null });

// GET: stored route (no ORS call): pins + the cached load route when it matches these stops.
export async function storedRoute(ctx, { env = process.env } = {}) {
  const { db, ownerId, load, stops } = ctx;
  let geometry = null, calculated = null, total = load.total_miles ?? null;
  const r = await db.from('loads').select('route_geometry, route_key, route_error, calculated_miles, total_miles').eq('id', load.id).eq('user_id', ownerId).maybeSingle();
  if (!r.error && r.data) {
    const key = routeKey(routeStops(stops));
    const current = key && r.data.route_key === key;
    if (current && !PERMANENT_ERRORS.has(r.data.route_error)) geometry = r.data.route_geometry || null;
    if (current && !r.data.route_error && Number(r.data.calculated_miles) > 0) calculated = Number(r.data.calculated_miles);
    if (total == null) total = r.data.total_miles ?? null;
  }
  return { state: 'ready', live: !!orsKey(env), stops: [...stops].sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0)).map(pubStop), geometry, calculated_miles: calculated, total_miles: total };
}

// POST: live miles + drive time from the (rounded) current position to one stop of this load.
export async function liveEta(ctx, body, { env = process.env, fetchImpl = fetch, now = () => Date.now(), cache = defaultCache, gate = defaultGate, take } = {}) {
  const origin = parseOrigin(body);
  if (!origin) return { status: 400, body: { state: 'error', code: 'bad_origin', error: 'Location missing or invalid.' } };
  const stop = ctx.stops.find((s) => s.id === body?.stop_id);
  if (!stop) return { status: 400, body: { state: 'error', code: 'bad_stop', error: 'That stop isn’t on this load.' } };
  if (stop.lat == null || stop.lng == null) return { body: { state: 'error', code: 'no_stop_location', stop_id: stop.id } };
  const key = orsKey(env);
  if (!key) return { body: { state: 'no_key', stop_id: stop.id } };
  const o = { lat: roundCoord(origin.lat), lng: roundCoord(origin.lng) };
  const ck = cacheKey(ctx.load.id, stop.id, o);
  const t = now();
  const hit = cache.get(ck, t);
  if (hit) return { body: { ...hit, cached: true } };
  const g = gate.check(ctx.user.id, t);
  if (!g.ok) return { body: { state: 'error', code: 'user_limit', retryInMs: g.retryInMs, stop_id: stop.id } };
  const takeBoth = take || ((k) => etaLimiter.take('eta') && takeDirections(k));
  gate.record(ctx.user.id, t);
  const r = await fetchRoute([o, { lat: Number(stop.lat), lng: Number(stop.lng) }], { key, fetchImpl, take: takeBoth, timeoutMs: ORS_ETA_TIMEOUT_MS, radiuses: ETA_RADIUSES });
  if (r.error) {
    return { body: { state: 'error', code: r.error, retryInMs: r.error === 'no_route' ? null : ERROR_RETRY_MS, stop_id: stop.id } };
  }
  const value = { state: 'ready', miles: r.miles, seconds: r.seconds ?? null, geometry: r.geometry || null, computed_at: new Date(t).toISOString(), stop_id: stop.id };
  cache.set(ck, value, t);
  return { body: value };
}

export { decodePolyline };
