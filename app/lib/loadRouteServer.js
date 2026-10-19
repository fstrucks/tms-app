// Server side of the load map (PR B). Calls OpenRouteService (HeiGIT) with ORS_API_KEY; the key never leaves the
// server and is never logged. Results are cached on stops/loads (see loadRoute.js), so ORS is only called when
// stop addresses change (or after a cool-down for a temporary failure).
// QA #83: each POST does ONE short step (geocode one stop, or fetch the route) inside a time budget well under the
// function's maxDuration, and returns JSON; the page calls again while there's a next step.
import {
  ORS_BASE, ORS_DIRECTIONS_PATH, ERROR_TEXT, PERMANENT_ERRORS, LIMITS,
  routeStops, routeKey, routeFreshness, needsGeocode, isPinned, stopAddressText, geocodeAttempts, pickGeocode,
  parseDirections, classifyOrsError, calculatedMilesPatch, hasRouteColumns, hasStopGeoColumns, createLimiter,
} from './loadRoute.js';
import { isMissing, UUID, json } from './truckServer.js';
import { userClient, serviceClient, bearer, checkUser, jwtClaims, isAuthRejection } from './packetServer.js';
import { isRole } from './companyRoles.js';
import { extractedMiles, hasMilesSourceColumn } from './loadMiles.js';
import { canEditTruck } from './truckFields.js';

export const MAX_DURATION_S = 30;              // route.js maxDuration
export const STEP_BUDGET_MS = 15_000;          // ORS work in one POST step (QA #83 r2: was 22 s)
export const ORS_GEOCODE_TIMEOUT_MS = 5_000;   // per geocode call (at most 2 per step)
export const ORS_ROUTE_TIMEOUT_MS = 12_000;    // directions call (was 18 s)
export const HANDLER_DEADLINE_MS = 20_000;     // the whole request (auth + DB + ORS) always answers by then; < maxDuration
export const MAX_STEPS = 8;                    // the page stops asking after this many steps
const limiter = createLimiter();
const inflight = new Map(); // `${ownerId}:${loadId}` → Promise (one step per load per instance at a time)

export const orsKey = (env = process.env) => (env.ORS_API_KEY || '').trim() || null;

const PGRST_JWT = new Set(['PGRST301', 'PGRST302', 'PGRST303']);
// Like truckCtx, plus the fields-API fallback: when Supabase Auth can't answer, the token is still verified by the
// database (PostgREST checks the JWT on the packet_role call). → { db, user, ownerId, role, canEdit } | { res }
export async function mapCtx(req, { mkUserClient = userClient, sb: svc, mkService = serviceClient, authRetryMs } = {}) {
  const token = bearer(req);
  if (!token) return { res: json({ error: 'Sign in first. Open the load page; this address only answers the app.', state: 'failed' }, 401) };
  const uc = mkUserClient(token);
  const who = await checkUser(uc, token, authRetryMs != null ? { retryMs: authRetryMs } : {});
  if (who.rejected) return { res: json({ error: 'Your sign-in expired. Please sign in again.', state: 'failed', auth: true }, 401) };
  let user = who.user || null;
  if (who.unavailable) {
    const c = jwtClaims(token);
    if (!c?.sub) return { res: json({ error: 'Couldn’t check your sign-in just now. Try again.', state: 'failed', retry: true }, 503) };
    if ((c.exp && c.exp * 1000 < Date.now()) || (c.role && c.role !== 'authenticated')) return { res: json({ error: 'Your sign-in expired. Please sign in again.', state: 'failed', auth: true }, 401) };
    console.error('[map] auth check unavailable, verifying via database');
    user = { id: c.sub, verified: 'database' };
  }
  const { data: profiles, error } = await uc.from('company_profiles').select('*').limit(1);
  if (error && (PGRST_JWT.has(error.code) || isAuthRejection(error))) return { res: json({ error: 'Your sign-in expired. Please sign in again.', state: 'failed', auth: true }, 401) };
  if (error && !isMissing(error)) return { res: json({ error: 'Could not load your company.', state: 'failed' }, 500) };
  const ownerId = profiles?.[0]?.owner_id || user.id;
  const { data: role, error: rErr } = await uc.rpc('packet_role', { p_owner: ownerId });
  if (rErr && (PGRST_JWT.has(rErr.code) || isAuthRejection(rErr))) return { res: json({ error: 'Your sign-in expired. Please sign in again.', state: 'failed', auth: true }, 401) };
  if (!isRole(role)) return { res: json({ error: 'Not allowed.', state: 'failed' }, 403) };
  let db = uc;
  if (ownerId !== user.id) {
    db = svc || mkService();
    if (!db) return { res: json({ error: 'The map isn’t set up for team members yet.', state: 'failed' }, 503) };
  }
  return { db, user, ownerId, role, canEdit: canEditTruck(role) };
}

const left = (deadline) => (deadline ? deadline - Date.now() : Infinity);

// One ORS call with a hard timeout: AbortController + our own timer (also covers a stalled body read), so it
// always settles by `t` even if the connection hangs. Never throws.
async function orsFetch(fetchImpl, url, init, timeoutMs, deadline) {
  const t = Math.min(timeoutMs, left(deadline) - 1_500);
  if (!(t > 500)) return { ok: false, status: null, body: null, timedOut: true, skipped: true };
  const ac = new AbortController();
  let timer;
  const timeUp = new Promise((resolve) => { timer = setTimeout(() => { ac.abort(); resolve({ ok: false, status: null, body: null, timedOut: true }); }, t); });
  const work = (async () => {
    const res = await fetchImpl(url, { ...init, cache: 'no-store', signal: ac.signal });
    let body = null; try { body = await res.json(); } catch {}
    return { ok: res.ok, status: res.status, body };
  })().catch((e) => ({ ok: false, status: null, body: null, timedOut: ac.signal.aborted || e?.name === 'TimeoutError' || e?.name === 'AbortError' }));
  try { return await Promise.race([work, timeUp]); } finally { clearTimeout(timer); }
}

// Resolve with `fallback()` if `p` hasn't settled by `ms` (the work may finish in the background).
export async function withDeadline(p, ms, fallback) {
  let timer;
  const late = new Promise((resolve) => { timer = setTimeout(() => resolve(fallback()), ms); });
  try { return await Promise.race([p, late]); } finally { clearTimeout(timer); }
}

// One stop → { lat, lng, precision } | { error } | null (not found). Structured search first, then free text; a
// street-level hit wins, else the best city/ZIP-level hit.
export async function geocodeStop(stop, { key, fetchImpl = fetch, take = (k) => limiter.take(k), timeoutMs = ORS_GEOCODE_TIMEOUT_MS, deadline = null } = {}) {
  let best = null, lastErr = null;
  for (const a of geocodeAttempts(stop)) {
    if (!take('geocode')) return best || { error: 'rate_limited' };
    const qs = new URLSearchParams(a.params).toString();
    const r = await orsFetch(fetchImpl, `${ORS_BASE}${a.path}?${qs}`, { headers: { Authorization: key, Accept: 'application/json' } }, timeoutMs, deadline);
    if (!r.ok) {
      const code = classifyOrsError(r);
      if (code === 'no_route') continue; // a 400/404 for this query: try the next one
      lastErr = code; continue;
    }
    const hit = pickGeocode(r.body, stop);
    if (hit?.precision === 'street') return hit;
    if (hit && !best) best = hit;
  }
  if (best) return best;
  return lastErr ? { error: lastErr } : null;
}

// The shared per-instance directions limiter (load map + home card ETA share one ORS key and one budget).
export const takeDirections = (k = 'directions') => limiter.take(k);

export async function fetchRoute(points, { key, fetchImpl = fetch, take = (k) => limiter.take(k), timeoutMs = ORS_ROUTE_TIMEOUT_MS, deadline = null, radiuses = null } = {}) {
  if (!take('directions')) return { error: 'rate_limited' };
  const r = await orsFetch(fetchImpl, `${ORS_BASE}${ORS_DIRECTIONS_PATH}`, {
    method: 'POST',
    headers: { Authorization: key, 'Content-Type': 'application/json', Accept: 'application/json' },
    // radiuses: a city/ZIP-level point may be off the road network; allow snapping up to 5 km.
    body: JSON.stringify({ coordinates: points.map((p) => [p.lng, p.lat]), units: 'mi', instructions: false, radiuses: radiuses || points.map(() => 5000) }),
  }, timeoutMs, deadline);
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
export function viewOf(load, stops, extra = {}, now = Date.now()) {
  const rs = routeStops(stops);
  const fr = routeFreshness(load, rs, now);
  const current = fr.key && load.route_key === fr.key;
  const missed = rs.filter((s) => !needsGeocode(s) && !isPinned(s));
  let state = 'ready', message = null;
  if (fr.reason === 'too_few') { state = 'too_few'; message = ERROR_TEXT.too_few; }
  else if (missed.length && (!fr.next || fr.next === 'miss' || current)) {
    state = 'error'; message = ERROR_TEXT.geocode_miss.replace('{stops}', missed.map((s) => `the ${s.stop_type || 'stop'} address`).join(' and '));
  } else if (current && load.route_error) { state = 'error'; message = ERROR_TEXT[load.route_error] || ERROR_TEXT.upstream; }
  return {
    state, message, stale: !fr.fresh, next: fr.fresh ? null : fr.next, retryInMs: fr.retryInMs ?? null,
    stops: rs.map((s) => ({ id: s.id, stop_type: s.stop_type, sequence: s.sequence, city: s.city, state: s.state, lat: s.lat ?? null, lng: s.lng ?? null, precision: s.geocode_precision ?? null })),
    geometry: current && !PERMANENT_ERRORS.has(load.route_error) ? load.route_geometry || null : null,
    calculated_miles: current ? load.calculated_miles ?? null : null,
    load: { total_miles: load.total_miles ?? null, rate_per_mile: load.rate_per_mile ?? null, calculated_miles: load.calculated_miles ?? null, ...(Object.prototype.hasOwnProperty.call(load, 'miles_source') ? { miles_source: load.miles_source } : {}) },
    ...extra,
  };
}

async function readLoad(db, ownerId, loadId) {
  if (!UUID.test(loadId || '')) return { notFound: true };
  const l = await db.from('loads').select('*').eq('id', loadId).eq('user_id', ownerId).maybeSingle();
  if (l.error) return isMissing(l.error) ? { setupNeeded: true } : { error: 'Could not load the load.' };
  if (!l.data) return { notFound: true };
  if (!hasRouteColumns(l.data)) return { setupNeeded: true };
  const s = await db.from('stops').select('*').eq('load_id', loadId).order('sequence');
  if (s.error) return isMissing(s.error) ? { setupNeeded: true } : { error: 'Could not load the stops.' };
  const stops = s.data || [];
  if (stops.length && !hasStopGeoColumns(stops[0])) return { setupNeeded: true };
  return { load: l.data, stops };
}

const noKeyView = (load, stops) => ({ ...viewOf(load, stops), state: 'no_key', message: ERROR_TEXT.no_key, stale: false, next: null });

// QA #83 r3: an EMPTY Planned falls back down the chain (typed > rate con > calculated) from what's already saved:
// the rate con's miles, else the cached route miles when that route is current for these stops. Conditional on
// total_miles still being empty, so typed or rate con miles are never overwritten. No ORS call.
// → { load, filled: { miles, source } | null }
export async function fillEmptyPlanned(db, ownerId, loadId, load, stops) {
  if (!hasMilesSourceColumn(load) || load.total_miles != null) return { load, filled: null };
  const key = routeKey(routeStops(stops));
  const calc = key && load.route_key === key && !load.route_error && Number(load.calculated_miles) > 0 ? Number(load.calculated_miles) : null;
  let rc = null;
  try {
    const d = await db.from('documents').select('ai_extracted_data').eq('load_id', loadId).eq('user_id', ownerId).eq('doc_type', 'rate_confirmation').limit(5);
    if (!d.error) rc = (d.data || []).map((x) => extractedMiles(x.ai_extracted_data)).find((m) => m != null) ?? null;
  } catch {}
  const miles = rc ?? calc;
  if (!miles) return { load, filled: null };
  const source = rc != null ? 'rate_con' : 'calculated';
  try {
    const u = await db.from('loads').update({ total_miles: miles, miles_source: source }).eq('id', loadId).eq('user_id', ownerId).is('total_miles', null).select('*');
    if (u.error || !u.data?.[0]) return { load, filled: null };
    return { load: { ...load, ...u.data[0] }, filled: { miles, source } };
  } catch { return { load, filled: null }; }
}

// GET: cached view only, never calls ORS (may fill an empty Planned from saved values, see fillEmptyPlanned).
export async function getRoute(db, ownerId, loadId, { env = process.env } = {}) {
  const r = await readLoad(db, ownerId, loadId);
  if (!r.load) return r;
  const f = await fillEmptyPlanned(db, ownerId, loadId, r.load, r.stops);
  const extra = f.filled ? { plannedFilled: f.filled } : {};
  if (!orsKey(env)) return { view: { ...noKeyView(f.load, r.stops), ...extra } };
  return { view: viewOf(f.load, r.stops, extra) };
}

// POST: one step when stale (geocode one stop, record a miss, or fetch the route), else the cache.
export async function ensureRoute(db, ownerId, loadId, opts = {}) {
  const k = `${ownerId}:${loadId}`;
  if (inflight.has(k)) return inflight.get(k);
  const p = stepNow(db, ownerId, loadId, opts).finally(() => inflight.delete(k));
  inflight.set(k, p);
  return p;
}

async function saveLoad(db, ownerId, loadId, patch) {
  const u = await db.from('loads').update(patch).eq('id', loadId).eq('user_id', ownerId).select('*');
  if (u.error) return isMissing(u.error) ? { setupNeeded: true } : { error: 'Could not save the route.' };
  return { row: u.data?.[0] || null };
}

async function stepNow(db, ownerId, loadId, { env = process.env, fetchImpl = fetch, take, shared = null, now = () => Date.now(), budgetMs = STEP_BUDGET_MS } = {}) {
  const r = await readLoad(db, ownerId, loadId);
  if (!r.load) return r;
  const key = orsKey(env);
  if (!key) return { view: noKeyView(r.load, r.stops) };
  let { load, stops } = r;
  const rs = routeStops(stops);
  const fr = routeFreshness(load, rs, now());
  if (fr.fresh) {
    const f = await fillEmptyPlanned(db, ownerId, loadId, load, stops);
    return { view: viewOf(f.load, stops, f.filled ? { plannedFilled: f.filled } : {}, now()), computed: false };
  }
  const deadline = Date.now() + budgetMs;
  const o = { key, fetchImpl, deadline, ...(take ? { take } : {}) };
  const stamp = new Date(now()).toISOString();
  const fail = async (code, extra = {}) => {
    const patch = { route_key: fr.key, route_computed_at: stamp, route_error: code, ...extra };
    // Permanent failure, or any failure for changed addresses: drop the old route so a stale number isn't offered.
    if (PERMANENT_ERRORS.has(code) || load.route_key !== fr.key) { patch.calculated_miles = null; patch.route_geometry = null; }
    const s = await saveLoad(db, ownerId, loadId, patch);
    if (!s.row) return s.setupNeeded || s.error ? s : { view: viewOf({ ...load, ...patch }, stops, {}, now()), computed: true };
    return { view: viewOf(s.row, stops, {}, now()), computed: true };
  };

  if (fr.next === 'geocode') {
    const s = rs.find(needsGeocode);
    const g = await geocodeStop(s, o);
    if (g?.error) return fail(g.error);
    const patch = g
      ? { lat: g.lat, lng: g.lng, geocoded_at: stamp, geocode_address: stopAddressText(s), geocode_precision: g.precision }
      : { lat: null, lng: null, geocoded_at: stamp, geocode_address: stopAddressText(s), geocode_precision: null };
    const u = await db.from('stops').update(patch).eq('id', s.id).eq('load_id', loadId);
    if (u.error) return isMissing(u.error) ? { setupNeeded: true } : { error: 'Could not save the stop location.' };
    stops = stops.map((x) => (x.id === s.id ? { ...x, ...patch } : x));
    return { view: viewOf(load, stops, {}, now()), computed: true };
  }
  if (fr.next === 'miss') return fail('geocode_miss');

  // next === 'route'
  if (!(await underSharedLimit(shared, now()))) return fail('rate_limited');
  const route = await fetchRoute(rs.map((s) => ({ lat: s.lat, lng: s.lng })), o);
  if (route.error) return fail(route.error);
  const sv = await saveLoad(db, ownerId, loadId, { route_key: fr.key, route_computed_at: stamp, route_error: null, route_geometry: route.geometry, calculated_miles: route.miles });
  if (!sv.row && (sv.setupNeeded || sv.error)) return sv;
  load = { ...load, ...(sv.row || { route_key: fr.key, route_error: null, route_geometry: route.geometry, calculated_miles: route.miles }) };

  // Planned miles (typed > rate con > calculated): an empty Planned takes the rate con's miles, else the route;
  // an older calculated value is refreshed. Conditional updates, so a value typed meanwhile is never replaced.
  let filled = null;
  if (load.total_miles == null) {
    const f = await fillEmptyPlanned(db, ownerId, loadId, load, stops);
    load = f.load; filled = f.filled;
  } else {
    const mp = calculatedMilesPatch(load, route.miles);
    if (mp.total_miles != null && load.total_miles !== mp.total_miles) {
      const f = await db.from('loads').update({ total_miles: mp.total_miles, miles_source: 'calculated' }).eq('id', loadId).eq('user_id', ownerId).eq('miles_source', 'calculated').select('*');
      if (!f.error && f.data?.[0]) { load = { ...load, ...f.data[0] }; filled = { miles: mp.total_miles, source: 'calculated' }; }
    }
  }
  return { view: viewOf(load, stops, filled ? { plannedFilled: filled } : {}, now()), computed: true };
}

export { routeKey };
