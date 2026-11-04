// Route options, Phase 1 (display only, no database writes). Fastest = the stored route on the load; Shortest and
// No tolls = two parallel ORS calls with all stops, no truck dimensions sent. Results live in memory for 24 h per
// load + stop addresses (route_key); a failed variant isn't asked again for 10 min (no_route: until the stops change).
import { createLimiter, routeKey, routeStops, isPinned, RETRY_AFTER_MS } from './loadRoute.js';
import { readLoad, fetchRoute, orsKey } from './loadRouteServer.js';
import { VARIANTS, mergeOptions } from './routeOptions.js';

export const OPTIONS_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
export const OPTIONS_FAIL_RETRY_MS = 10 * 60 * 1000;
export const OPTIONS_LIMITS = { options: { perMinute: 10, perDay: 300 } }; // per instance, counted per computed open
export const OPTIONS_USER_PER_DAY = 30;
export const OPTIONS_TIMEOUT_MS = 12_000;

export function createOptionsCache({ ttlMs = OPTIONS_CACHE_TTL_MS, max = 500, now = () => Date.now() } = {}) {
  const m = new Map();
  return {
    get(k) {
      const e = m.get(k); if (!e) return null;
      if (now() - e.at > ttlMs) { m.delete(k); return null; }
      m.delete(k); m.set(k, e); return e;
    },
    set(k, v) { m.delete(k); m.set(k, { ...v, at: v.at ?? now() }); while (m.size > max) m.delete(m.keys().next().value); },
    size: () => m.size,
  };
}

function userDayLimiter(perDay = OPTIONS_USER_PER_DAY, now = () => Date.now()) {
  const m = new Map();
  return (userId) => {
    const day = new Date(now()).toISOString().slice(0, 10), k = `${day}|${userId}`;
    for (const key of m.keys()) if (!key.startsWith(day)) m.delete(key);
    const n = m.get(k) || 0; if (n >= perDay) return false;
    m.set(k, n + 1); return true;
  };
}

const defaultState = { cache: createOptionsCache(), limiter: createLimiter(OPTIONS_LIMITS), userOk: userDayLimiter() };
export const newOptionsState = ({ now = () => Date.now() } = {}) => ({ cache: createOptionsCache({ now }), limiter: createLimiter(OPTIONS_LIMITS, now), userOk: userDayLimiter(OPTIONS_USER_PER_DAY, now) });

const BUSY = (retryInMs = OPTIONS_FAIL_RETRY_MS) => ({ state: 'busy', message: 'Route options are busy right now. Try again in a few minutes.', retryInMs });

// A cached failure is still fresh (don't ask ORS again yet)?
const failFresh = (v, t) => v && v.error && (v.error === 'no_route' || t - v.at < Math.max(OPTIONS_FAIL_RETRY_MS, RETRY_AFTER_MS[v.error] || 0));

// → reply body for POST /api/loads/[id]/map/options (never includes rate or keys).
export async function computeOptions(db, ownerId, loadId, userId, { env = process.env, fetchImpl = fetch, state = defaultState, now = () => Date.now(), deadline = null, total } = {}) {
  const key = orsKey(env);
  if (!key) return { state: 'no_key' };
  const r = await readLoad(db, ownerId, loadId);
  if (r.notFound) return { state: 'not_found' };
  if (r.setupNeeded || r.error) return { state: 'not_ready' };
  const { load, stops } = r;
  const rs = routeStops(stops);
  const rk = routeKey(rs);
  const fastestOk = rk && load.route_key === rk && !load.route_error && Number(load.calculated_miles) > 0 && load.route_geometry;
  if (!fastestOk || !rs.every(isPinned)) return { state: 'not_ready' };
  const fastest = { id: 'fastest', miles: Number(load.calculated_miles), seconds: null, geometry: load.route_geometry };

  const ck = `${loadId}|${rk}`, t = now();
  const prev = state.cache.get(ck)?.variants || {};
  const todo = VARIANTS.filter((v) => v.body && !(prev[v.id] && (!prev[v.id].error || failFresh(prev[v.id], t))));
  let variants = prev;
  if (todo.length) {
    if (!state.userOk(userId) || !state.limiter.take('options')) {
      if (!Object.keys(prev).length) return BUSY();
    } else {
      const points = rs.map((s) => ({ lat: Number(s.lat), lng: Number(s.lng) }));
      const got = await Promise.allSettled(todo.map((v) => fetchRoute(points, { key, fetchImpl, take: () => true, timeoutMs: OPTIONS_TIMEOUT_MS, deadline, extra: v.body, ...(total !== undefined ? { total } : {}) })));
      variants = { ...prev };
      todo.forEach((v, i) => {
        const g = got[i];
        const val = g.status === 'fulfilled' ? g.value : { error: 'upstream' };
        variants[v.id] = val && !val.error && val.miles > 0 && val.geometry ? { miles: val.miles, seconds: val.seconds, geometry: val.geometry, at: t } : { error: val?.error || 'upstream', at: t };
      });
      state.cache.set(ck, { variants, at: Object.keys(prev).length ? state.cache.get(ck)?.at : t });
    }
  }
  const ok = VARIANTS.filter((v) => v.body && variants[v.id] && !variants[v.id].error).map((v) => ({ id: v.id, ...variants[v.id] }));
  const failed = VARIANTS.filter((v) => v.body && (!variants[v.id] || variants[v.id].error)).map((v) => ({ id: v.id, code: variants[v.id]?.error || 'busy' }));
  if (!ok.length && failed.every((f) => f.code === 'rate_limited' || f.code === 'busy')) return BUSY();
  const options = mergeOptions([fastest, ...ok]).map(({ id, ids, label, miles, seconds, geometry }) => ({ id, ids, label, miles, seconds, geometry }));
  return { state: 'ready', default: 'fastest', options, failed, only_one: options.length === 1 && !failed.length };
}
