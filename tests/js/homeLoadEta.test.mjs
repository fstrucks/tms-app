// Home card Panel 2 (swipeable map + miles left + Drive time + ETA + Navigate), Marc Oct 18 2026. Fake data only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fakeSupabase } from './fakeSupabase.mjs';
import {
  haversineMi, roundCoord, parseOrigin, fixUsable, shouldRefresh, estimate, fmtDriveTime, fmtEta, validTz, etaTarget,
  totalRouteMiles, ageText, platformOf, googleMapsUrl, appleMapsUrl, truckerPathLink, stopAddress, postEta,
  AGE_TICK_MS, LOCATION_POLL_MS, REFRESH_MIN_GAP_MS, PERIODIC_MS, MANUAL_FLOOR_MS, MAX_ACCURACY_M, MAX_FIX_AGE_MS, ERROR_RETRY_MS, ORIGIN_DECIMALS,
  TP_APP_STORE, TP_PLAY_STORE, ETA_LIMITS, USER_PER_DAY,
} from '../../app/lib/loadEta.js';
import { parseDirections, encodePolyline, LIMITS } from '../../app/lib/loadRoute.js';
import { liveEta, createEtaCache, createUserGate, cacheKey, ETA_RADIUSES } from '../../app/lib/loadEtaServer.js';
import * as ETA from '../../app/api/loads/[id]/eta/route.js';

const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');
const MIN = 60_000;
const T0 = Date.parse('2026-10-19T12:00:00Z');
// Fake places (rounded test coordinates, no real customers).
const ONTARIO = { lat: 34.0633, lng: -117.6509 };
const PHOENIX = { lat: 33.4484, lng: -112.074 };
const DEL = { id: 'stop-d', sequence: 2, stop_type: 'delivery', company_name: 'Sample Foods DC (FAKE)', address_line1: '4500 W Test Rd', city: 'Phoenix', state: 'AZ', zip: '85043', timezone: 'America/Phoenix', ...PHOENIX };
const PU = { id: 'stop-p', sequence: 1, stop_type: 'pickup', company_name: 'Acme Cold Storage (FAKE)', address_line1: '1200 Example Industrial Pkwy', city: 'Ontario', state: 'CA', zip: '91761', timezone: 'America/Los_Angeles', ...ONTARIO };
const fixAt = (p, at = T0, accuracy = 50) => ({ ...p, accuracy, at });

// ---------- pure helpers ----------
test('haversine, rounding (2 decimals ≈ 0.7 mi) and origin validation', () => {
  const d = haversineMi(ONTARIO, PHOENIX);
  assert.ok(d > 300 && d < 330, String(d));
  assert.equal(haversineMi(null, PHOENIX), null);
  assert.equal(ORIGIN_DECIMALS, 2);
  assert.equal(roundCoord(34.06337), 34.06); assert.equal(roundCoord(-117.65091), -117.65);
  assert.deepEqual(parseOrigin({ lat: '34.1', lng: -117.2, accuracy_m: 30 }), { lat: 34.1, lng: -117.2, accuracy: 30 });
  for (const b of [{}, { lat: 91, lng: 0 }, { lat: 0, lng: 181 }, { lat: 'x', lng: 1 }, { lat: null, lng: null }, { lat: '', lng: '' }, null]) assert.equal(parseOrigin(b), null);
});

test('fixUsable: coarse (> 2 km) or stale (> 5 min) fixes are not routed from', () => {
  assert.ok(fixUsable(fixAt(ONTARIO), T0));
  assert.ok(!fixUsable(fixAt(ONTARIO, T0, MAX_ACCURACY_M + 1), T0));
  assert.ok(!fixUsable(fixAt(ONTARIO, T0 - MAX_FIX_AGE_MS - 1), T0));
  assert.ok(!fixUsable(null, T0));
});

test('shouldRefresh: first call, then only after ≥ 10 mi + ≥ 10 min, or every 20 min while moving; never parked or near the stop', () => {
  const start = fixAt(ONTARIO);
  assert.deepEqual(shouldRefresh({ last: null, fix: start, stop: DEL, now: T0 }), { go: true, reason: 'first' });
  const last = { origin: ONTARIO, at: T0, stopId: DEL.id };
  const east = (mi) => ({ lat: ONTARIO.lat, lng: ONTARIO.lng + mi / 57.3 }); // ≈ miles east at this latitude
  // moved 12 mi but only 5 min → wait; after 10 min → go
  assert.equal(shouldRefresh({ last, fix: fixAt(east(12), T0 + 5 * MIN), stop: DEL, now: T0 + 5 * MIN }).go, false);
  assert.deepEqual(shouldRefresh({ last, fix: fixAt(east(12), T0 + REFRESH_MIN_GAP_MS), stop: DEL, now: T0 + REFRESH_MIN_GAP_MS }), { go: true, reason: 'moved' });
  // moved 3 mi: wait until 20 min
  assert.equal(shouldRefresh({ last, fix: fixAt(east(3), T0 + 15 * MIN), stop: DEL, now: T0 + 15 * MIN }).go, false);
  assert.deepEqual(shouldRefresh({ last, fix: fixAt(east(3), T0 + PERIODIC_MS), stop: DEL, now: T0 + PERIODIC_MS }), { go: true, reason: 'periodic' });
  // parked: never, even after an hour
  assert.deepEqual(shouldRefresh({ last, fix: fixAt(ONTARIO, T0 + 60 * MIN), stop: DEL, now: T0 + 60 * MIN }), { go: false, reason: 'stationary' });
  // within 1 mi of the stop: no routing
  assert.equal(shouldRefresh({ last: null, fix: fixAt({ lat: PHOENIX.lat + 0.005, lng: PHOENIX.lng }), stop: DEL, now: T0 }).reason, 'near_stop');
  // the next stop changed → route right away
  assert.equal(shouldRefresh({ last: { ...last, stopId: PU.id }, fix: fixAt(ONTARIO, T0 + MIN), stop: DEL, now: T0 + MIN }).reason, 'stop_changed');
  // manual Refresh: 2-minute floor
  assert.equal(shouldRefresh({ last, fix: fixAt(ONTARIO, T0 + MIN), stop: DEL, now: T0 + MIN, manual: true }).reason, 'manual_floor');
  assert.equal(shouldRefresh({ last, fix: fixAt(ONTARIO, T0 + MANUAL_FLOOR_MS), stop: DEL, now: T0 + MANUAL_FLOOR_MS, manual: true }).reason, 'manual');
  // cool-down after an error; no_route waits for 2 mi of movement
  assert.equal(shouldRefresh({ last: null, fix: start, stop: DEL, now: T0, block: { until: T0 + ERROR_RETRY_MS } }).reason, 'cooldown');
  assert.equal(shouldRefresh({ last: null, fix: fixAt(east(1)), stop: DEL, now: T0, block: { noRouteAt: ONTARIO } }).reason, 'no_route_wait');
  assert.equal(shouldRefresh({ last: null, fix: fixAt(east(3)), stop: DEL, now: T0, block: { noRouteAt: ONTARIO } }).go, true);
  // no usable fix / stop without a pin
  assert.equal(shouldRefresh({ last: null, fix: null, stop: DEL, now: T0 }).reason, 'no_fix');
  assert.equal(shouldRefresh({ last: null, fix: start, stop: { ...DEL, lat: null, lng: null }, now: T0 }).reason, 'no_stop');
});

test('call budget: a 10 h drive with the panel open never routes more than ~6 times an hour', () => {
  let last = null, calls = 0;
  for (let m = 0; m <= 600; m += 1) { // location read every minute at 60 mph straight east
    const now = T0 + m * MIN;
    const fix = fixAt({ lat: ONTARIO.lat, lng: ONTARIO.lng + m / 57.3 }, now);
    const far = { ...DEL, lat: ONTARIO.lat, lng: ONTARIO.lng + 700 / 57.3 };
    if (shouldRefresh({ last, fix, stop: far, now }).go) { calls += 1; last = { origin: fix, at: now, stopId: far.id }; }
  }
  assert.ok(calls <= 61 && calls >= 50, String(calls));
  assert.ok(calls <= USER_PER_DAY + 1);
});

test('estimate: scales the last answer by straight-line progress between calls', () => {
  const last = { miles: 312, seconds: 18600, origin: ONTARIO };
  assert.deepEqual(estimate(last, null, DEL), { miles: 312, seconds: 18600, scaled: false });
  const half = { lat: (ONTARIO.lat + PHOENIX.lat) / 2, lng: (ONTARIO.lng + PHOENIX.lng) / 2 };
  const e = estimate(last, half, DEL);
  assert.ok(e.miles > 140 && e.miles < 170 && e.scaled, JSON.stringify(e));
  assert.equal(estimate(null, half, DEL), null);
});

test('Drive time, ETA in the stop’s zone (device zone when unknown), labels, total route fallback, age text', () => {
  assert.equal(fmtDriveTime(18600), '5 h 10 m'); assert.equal(fmtDriveTime(3600), '1 h'); assert.equal(fmtDriveTime(600), '10 m'); assert.equal(fmtDriveTime(null), null);
  // 5 h 10 m after 12:00 UTC = 17:10 UTC = 10:10 AM MST (Phoenix, no DST)
  assert.equal(fmtEta(T0, 18600, 'America/Phoenix'), 'Mon 10:10 AM MST');
  assert.ok(validTz('America/Chicago')); assert.ok(!validTz('Mars/Base')); assert.ok(!validTz(null));
  assert.equal(fmtEta(T0, 18600, 'Mars/Base'), 'Mon 10:10 AM PDT', 'test runner device zone is America/Los_Angeles');
  assert.equal(fmtEta(T0, null, 'America/Phoenix'), null);
  const load = { stops: [DEL, PU] };
  assert.equal(etaTarget(load, 1), 'to delivery'); assert.equal(etaTarget(load, 0), 'to pickup');
  assert.equal(etaTarget({ stops: [PU, { ...DEL, id: 'x', sequence: 2 }, { ...DEL, sequence: 3 }] }, 1), 'to stop 2 of 3');
  assert.equal(totalRouteMiles({ total_miles: 327 }, { calculated_miles: 331 }), 331);
  assert.equal(totalRouteMiles({ total_miles: 327 }, { calculated_miles: null }), 327);
  assert.equal(totalRouteMiles({}, null), null);
  assert.equal(ageText(T0, T0 + 30_000), 'Updated just now'); assert.equal(ageText(T0, T0 + 8 * MIN), 'Updated 8 min ago');
});

// ---------- Navigate ----------
test('Navigate: Google Maps and Apple Maps open to the address; Trucker Path uses its documented lat,lng launcher', () => {
  assert.equal(stopAddress(DEL), '4500 W Test Rd, Phoenix, AZ 85043');
  assert.equal(googleMapsUrl(DEL), 'https://www.google.com/maps/dir/?api=1&destination=4500%20W%20Test%20Rd%2C%20Phoenix%2C%20AZ%2085043&travelmode=driving');
  assert.equal(appleMapsUrl(DEL), 'https://maps.apple.com/?daddr=4500%20W%20Test%20Rd%2C%20Phoenix%2C%20AZ%2085043&dirflg=d');
  const ios = truckerPathLink(DEL, 'ios');
  assert.equal(ios.href, 'truckerpath://cal_route?daddr=33.448400,-112.074000'); assert.equal(ios.fallback, TP_APP_STORE);
  const and = truckerPathLink(DEL, 'android');
  assert.equal(and.href, `intent://cal_route?d_addr=33.448400,-112.074000#Intent;scheme=truckerpath;package=com.sixdays.truckerpath;S.browser_fallback_url=${encodeURIComponent(TP_PLAY_STORE)};end`);
  assert.equal(truckerPathLink(DEL, 'desktop'), null, 'phone app only');
  assert.equal(truckerPathLink({ ...DEL, lat: null, lng: null }, 'ios'), null, 'Trucker Path takes coordinates only');
  assert.equal(googleMapsUrl(null), null);
  assert.equal(platformOf('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)'), 'ios');
  assert.equal(platformOf('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', { maxTouchPoints: 5 }), 'ios', 'iPadOS');
  assert.equal(platformOf('Mozilla/5.0 (Linux; Android 14; Pixel 8)'), 'android');
  assert.equal(platformOf('Mozilla/5.0 (Windows NT 10.0; Win64; x64)'), 'desktop');
  const panel = read('app/components/LoadMapPanel.js');
  const order = ['nav-truckerpath', 'nav-google', 'nav-apple', 'nav-copy'].map((id) => panel.indexOf(`data-testid="${id}"`));
  assert.ok(order.every((i) => i > 0) && order.every((i, k) => k === 0 || i > order[k - 1]), 'Trucker Path, Google, Apple, then Copy');
  assert.match(panel, /copied \? '✓ Copied' : '📋 Copy address'/);
  assert.match(panel, /role="status"[^>]*>\{copied \? 'Address copied' : ''\}/);
});

// ---------- ORS duration ----------
test('parseDirections returns drive time seconds (and still miles)', () => {
  const g = encodePolyline([[34.06, -117.65], [33.45, -112.07]]);
  assert.deepEqual(parseDirections({ routes: [{ summary: { distance: 311.6, duration: 18600.4 }, geometry: g }] }).seconds, 18600);
  assert.equal(parseDirections({ routes: [{ summary: { distance: 311.6 }, geometry: g }] }).seconds, null);
  assert.equal(parseDirections({ routes: [{ summary: { distance: 311.6, duration: 1 } }] }).miles, 312);
});

// ---------- server ----------
const FAKE_KEY = 'fake-ors-key-for-tests';
const env = { ORS_API_KEY: FAKE_KEY };
const orsOk = () => {
  const calls = [];
  const impl = async (url, init) => { calls.push({ url, init, body: JSON.parse(init.body) }); return { ok: true, status: 200, json: async () => ({ routes: [{ summary: { distance: 311.6, duration: 18600 }, geometry: encodePolyline([[34.06, -117.65], [33.45, -112.07]]) }] }) }; };
  return { calls, impl };
};
const ctxOf = (userId = 'u-driver') => ({ user: { id: userId }, load: { id: '00000000-0000-4000-8000-0000000000a1' }, stops: [PU, DEL] });

test('liveEta: rounds the origin before HeiGIT, truck profile, both radiuses, returns miles + seconds; key never in the answer', async () => {
  const ors = orsOk();
  const r = await liveEta(ctxOf(), { lat: 34.06337, lng: -117.65091, accuracy_m: 20, stop_id: DEL.id }, { env, fetchImpl: ors.impl, cache: createEtaCache(), gate: createUserGate(), take: () => true, now: () => T0 });
  assert.equal(ors.calls.length, 1);
  assert.match(ors.calls[0].url, /^https:\/\/api\.heigit\.org\/openrouteservice\/v2\/directions\/driving-hgv$/);
  assert.deepEqual(ors.calls[0].body.coordinates, [[-117.65, 34.06], [PHOENIX.lng, PHOENIX.lat]]);
  assert.deepEqual(ors.calls[0].body.radiuses, ETA_RADIUSES);
  assert.equal(ors.calls[0].body.units, 'mi');
  assert.equal(r.body.state, 'ready'); assert.equal(r.body.miles, 312); assert.equal(r.body.seconds, 18600); assert.equal(r.body.stop_id, DEL.id);
  assert.ok(!JSON.stringify(r.body).includes(FAKE_KEY)); assert.ok(!('lat' in r.body) && !('origin' in r.body), 'origin not echoed');
});

test('liveEta: 10-min cache (same rounded spot → no new ORS call), per-user floor, quota, errors, no key, unpinned stop', async () => {
  const ors = orsOk(); const cache = createEtaCache(); const gate = createUserGate();
  const o = { env, fetchImpl: ors.impl, cache, gate, take: () => true };
  await liveEta(ctxOf(), { lat: 34.061, lng: -117.651, stop_id: DEL.id }, { ...o, now: () => T0 });
  const hit = await liveEta(ctxOf(), { lat: 34.064, lng: -117.649, stop_id: DEL.id }, { ...o, now: () => T0 + MIN });
  assert.equal(hit.body.cached, true); assert.equal(ors.calls.length, 1);
  assert.equal(cacheKey('L', 'S', { lat: 34.06, lng: -117.65 }), 'L:S:34.06:-117.65');
  // a new spot within 3 min → user floor (no ORS call)
  const floor = await liveEta(ctxOf(), { lat: 34.2, lng: -117.2, stop_id: DEL.id }, { ...o, now: () => T0 + 2 * MIN });
  assert.equal(floor.body.code, 'user_limit'); assert.ok(floor.body.retryInMs > 0); assert.equal(ors.calls.length, 1);
  // after 11 min the cache expired and the floor passed
  await liveEta(ctxOf(), { lat: 34.061, lng: -117.651, stop_id: DEL.id }, { ...o, now: () => T0 + 11 * MIN });
  assert.equal(ors.calls.length, 2);
  // limiter full → rate_limited with a 10-min retry, ORS not called
  const full = await liveEta(ctxOf('u2'), { lat: 34.5, lng: -117, stop_id: DEL.id }, { ...o, take: () => false, now: () => T0 });
  assert.deepEqual([full.body.code, full.body.retryInMs], ['rate_limited', ERROR_RETRY_MS]); assert.equal(ors.calls.length, 2);
  // ORS 429 / 2009
  const r429 = await liveEta(ctxOf('u3'), { lat: 34.5, lng: -117, stop_id: DEL.id }, { ...o, fetchImpl: async () => ({ ok: false, status: 429, json: async () => ({}) }), now: () => T0 });
  assert.equal(r429.body.code, 'rate_limited');
  const nr = await liveEta(ctxOf('u4'), { lat: 34.5, lng: -117, stop_id: DEL.id }, { ...o, fetchImpl: async () => ({ ok: false, status: 404, json: async () => ({ error: { code: 2009 } }) }), now: () => T0 });
  assert.deepEqual([nr.body.code, nr.body.retryInMs], ['no_route', null]);
  // no key / unpinned stop / foreign stop / bad origin
  assert.equal((await liveEta(ctxOf('u5'), { lat: 34, lng: -117, stop_id: DEL.id }, { ...o, env: {} })).body.state, 'no_key');
  const unp = await liveEta({ ...ctxOf('u6'), stops: [{ ...DEL, lat: null, lng: null }] }, { lat: 34, lng: -117, stop_id: DEL.id }, o);
  assert.equal(unp.body.code, 'no_stop_location');
  assert.equal((await liveEta(ctxOf('u7'), { lat: 34, lng: -117, stop_id: 'nope' }, o)).status, 400);
  assert.equal((await liveEta(ctxOf('u8'), { stop_id: DEL.id }, o)).status, 400);
  assert.equal(ors.calls.length, 2);
});

test('user gate: ≤ 60 ORS calls a UTC day per user; shared limits stay inside the free plan', () => {
  const g = createUserGate({ gapMs: 0, perDay: 60 });
  for (let i = 0; i < 60; i++) { assert.ok(g.check('u', T0 + i).ok); g.record('u', T0 + i); }
  assert.equal(g.check('u', T0 + 100).ok, false);
  assert.ok(g.check('u', T0 + 86_400_000).ok, 'next UTC day');
  assert.ok(ETA_LIMITS.eta.perDay < LIMITS.directions.perDay && LIMITS.directions.perDay < 2000);
  assert.ok(ETA_LIMITS.eta.perMinute <= LIMITS.directions.perMinute && LIMITS.directions.perMinute < 40);
});

// ---------- API route (fake Supabase) ----------
const L1 = '00000000-0000-4000-8000-0000000000a1';
const OWNER = '00000000-0000-4000-8000-0000000000b1';
const DRIVER = '00000000-0000-4000-8000-0000000000b2';
const loadRow = { id: L1, user_id: OWNER, status: 'in_transit', total_miles: 327, route_key: null, route_geometry: null, route_error: null, calculated_miles: null };
function clients({ user, role, visible }) {
  const uc = fakeSupabase({ tables: { company_profiles: user === OWNER ? [] : [{ owner_id: OWNER }] }, user: { id: user }, role });
  const rpcCalls = [];
  uc.rpc = async (fn, args) => { rpcCalls.push([fn, args]); if (fn === 'packet_role') return { data: role, error: null }; if (fn === 'visible_loads') return { data: visible ? [{ ...loadRow, stops: [PU, DEL] }] : [], error: null }; return { data: null, error: null }; };
  const sb = fakeSupabase({ tables: { loads: [loadRow] } });
  return { uc, sb, rpcCalls };
}
const req = (method, body, auth = 'Bearer t') => new Request(`http://x/api/loads/${L1}/eta`, { method, headers: { ...(auth ? { authorization: auth } : {}), 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });

test('API: assigned driver gets stops + stored route (GET, no ORS) and live miles (POST); unassigned driver gets 404; sign-in required', async () => {
  const { uc, sb, rpcCalls } = clients({ user: DRIVER, role: 'driver', visible: true });
  const ors = orsOk();
  const deps = { mkUserClient: () => uc, sb, authRetryMs: 0, eta: { env, fetchImpl: ors.impl, cache: createEtaCache(), gate: createUserGate(), take: () => true } };
  const g = await (await ETA.GET(req('GET'), { params: { id: L1 }, deps })).json();
  assert.equal(g.state, 'ready'); assert.equal(g.live, true); assert.equal(g.stops.length, 2); assert.equal(g.total_miles, 327); assert.equal(ors.calls.length, 0);
  assert.deepEqual(rpcCalls.find(([f]) => f === 'visible_loads')[1], { p_statuses: null, p_load: L1 });
  const p = await (await ETA.POST(req('POST', { lat: 34.06, lng: -117.65, accuracy_m: 30, stop_id: DEL.id }), { params: { id: L1 }, deps })).json();
  assert.equal(p.state, 'ready'); assert.equal(p.miles, 312); assert.equal(ors.calls.length, 1);
  const other = clients({ user: DRIVER, role: 'driver', visible: false });
  const r = await ETA.POST(req('POST', { lat: 34, lng: -117, stop_id: DEL.id }), { params: { id: L1 }, deps: { ...deps, mkUserClient: () => other.uc, sb: other.sb } });
  assert.equal(r.status, 404); assert.equal(ors.calls.length, 1);
  assert.equal((await ETA.GET(req('GET', null, null), { params: { id: L1 }, deps })).status, 401);
});

test('privacy: coordinates are never logged, even when the handler crashes, and never written to the database', async () => {
  const logs = []; const orig = { e: console.error, l: console.log, w: console.warn };
  console.error = (...a) => logs.push(a.join(' ')); console.log = console.error; console.warn = console.error;
  try {
    const { uc, sb } = clients({ user: OWNER, role: 'owner', visible: true });
    const boom = async () => { throw new TypeError('socket 34.0633 -117.6509'); };
    const deps = { mkUserClient: () => uc, sb, authRetryMs: 0, eta: { env, fetchImpl: boom, cache: createEtaCache(), gate: createUserGate(), take: () => true } };
    await ETA.POST(req('POST', { lat: 34.0633, lng: -117.6509, stop_id: DEL.id }), { params: { id: L1 }, deps });
    uc.rpc = async () => { throw new Error('crash at 34.0633,-117.6509'); };
    const r = await ETA.POST(req('POST', { lat: 34.0633, lng: -117.6509, stop_id: DEL.id }), { params: { id: L1 }, deps });
    assert.equal(r.status, 500);
    assert.ok(!logs.some((l) => /34\.06|117\.65/.test(l)), logs.join('\n'));
    assert.equal([...uc.calls, ...sb.calls].filter((c) => c.op !== 'select').length, 0, 'no writes');
  } finally { console.error = orig.e; console.log = orig.l; console.warn = orig.w; }
  const src = read('app/lib/loadEtaServer.js') + read('app/api/loads/[id]/eta/route.js') + read('app/components/LoadMapPanel.js');
  assert.ok(!/localStorage|sessionStorage|document\.cookie/.test(src.replace(/never in localStorage, cookies/g, '')), 'no device storage');
  assert.ok(!/console\.(log|error|warn)\([^)]*(lat|lng|fix|origin|body)/.test(src), 'no location in logs');
  assert.ok(!/\.(insert|update|upsert)\(/.test(read('app/lib/loadEtaServer.js')), 'no database writes');
});

test('postEta: coordinates go in the POST body (never the URL); 401 refreshes the sign-in once; network error → retry later', async () => {
  const seen = [];
  const f = async (url, init) => { seen.push({ url, init }); return { status: seen.length === 1 ? 401 : 200, ok: seen.length > 1, json: async () => ({ state: 'ready', miles: 1 }) }; };
  const fresh = [];
  const j = await postEta({ url: '/api/loads/x/eta', body: { lat: 1, lng: 2, stop_id: 's' }, fetchImpl: f, getToken: async (x) => { fresh.push(x); return 't'; } });
  assert.equal(j.state, 'ready'); assert.deepEqual(fresh, [false, true]);
  assert.ok(seen.every((s) => s.url === '/api/loads/x/eta' && s.init.method === 'POST' && JSON.parse(s.init.body).lat === 1));
  assert.deepEqual(await postEta({ url: 'u', body: {}, fetchImpl: async () => { throw new TypeError('offline'); }, getToken: async () => 't' }), { state: 'error', code: 'network', retryInMs: ERROR_RETRY_MS });
});

// ---------- UI wiring (source checks) ----------
test('panels: WAI-ARIA tabs + arrows + dots + scroll-snap; Panel 2 (and Leaflet) mounts only after it is shown', () => {
  const src = read('app/components/CurrentLoadPanels.js');
  assert.match(src, /role="tablist" aria-label="Current load views"/);
  assert.match(src, /role="tab"[\s\S]*aria-selected=\{idx === i\}[\s\S]*aria-controls=/);
  assert.match(src, /tabIndex=\{idx === i \? 0 : -1\}/);
  assert.match(src, /role="tabpanel"[\s\S]*aria-labelledby=/);
  assert.match(src, /inert=\{idx === i \? undefined : ''\}/);
  for (const k of ['ArrowRight', 'ArrowLeft', 'Home', 'End']) assert.match(src, new RegExp(`k === '${k}'`));
  assert.match(src, /aria-label=\{side === 'l' \? 'Show load panel' : 'Show map panel'\}/);
  assert.match(src, /<div aria-hidden="true"[\s\S]*panels-dot-/);
  assert.match(src, /scrollSnapType: 'x mandatory'/);
  assert.match(src, /prefers-reduced-motion/);
  assert.match(src, /revealed \? <LoadMapPanel/);
  assert.match(src, /dynamic\(\(\) => import\('\.\/LoadMapPanel'\)/);
  const home = read('app/components/HomeCurrentLoad.js');
  assert.match(home, /<CurrentLoadPanels enabled=\{props\.pick\.kind === 'current'\}[^>]*>\s*<FrontCard \{\.\.\.props\} \/>/);
  assert.match(home, /<LoadCard pick=\{pick\} docPath=\{docPath\} onOpenRateCon=\{openRateCon\} now=\{now\} audience=\{audience\}[\s\S]{0,120}?\/>/, 'render line keeps the card props (overdue prompt props added Oct 20)');
  assert.ok(!/LoadMapPanel|milesLeft|fmtMilesLeft|Drive time|left to delivery|loadEta/.test(home), 'front panel: no miles-left line');
});

test('map panel: location only after a tap (never on load), polled only while shown and visible; Drive time + ETA + ideal-conditions note', () => {
  const src = read('app/components/LoadMapPanel.js');
  assert.match(src, /data-testid="eta-use-location" onClick=\{\(\) => readLocation\(\)\}/);
  assert.match(src, /navigator\.permissions\?\.query\?\.\(\{ name: 'geolocation' \}\)/);
  assert.match(src, /if \(!active \|\| perm !== 'granted'\) return undefined;/);
  assert.match(src, /document\.visibilityState === 'visible'\) readLocation\(\{ quiet: gotFix\.current \}\)/);
  assert.match(src, /enableHighAccuracy: false, maximumAge: 60_000, timeout: 15_000/);
  assert.ok(!/watchPosition/.test(src));
  assert.match(src, /<b>Drive time<\/b>/); assert.match(src, /<b>ETA<\/b>/);
  assert.match(src, /Ideal conditions: no traffic, breaks or fuel stops\./);
  assert.match(src, /total route/);
  assert.match(src, /Location is blocked for this site/);
  const map = read('app/components/RouteMap.js');
  assert.match(map, /truck = null, live = null, label = null/);
  assert.match(map, /aria-label="Map of pickup and delivery with the truck route"/, 'load page label unchanged');
  assert.ok(!/filter:\s*['"]?invert/.test(map), 'tiles stay light in dark mode');
});

test('colors: new UI uses #95 theme tokens only (no hex/rgb, no fallbacks)', () => {
  for (const f of ['app/components/CurrentLoadPanels.js', 'app/components/LoadMapPanel.js']) {
    const src = read(f);
    assert.ok(!/#[0-9a-fA-F]{3,6}\b|rgba?\(/.test(src), `${f}: no hardcoded colors`);
    assert.ok(!/var\(--[\w-]+,/.test(src), `${f}: plain var(--x), no fallbacks`);
    assert.match(src, /var\(--surface\)/); assert.match(src, /var\(--primary\)/);
  }
});

test('QA #96: "Updated N min ago" ages between server calls (clock while Panel 2 is showing and visible)', () => {
  assert.equal(AGE_TICK_MS, 15_000); assert.ok(AGE_TICK_MS < LOCATION_POLL_MS);
  const at = T0;
  assert.deepEqual([0, 0.5, 1, 7, 7.5, 59, 61].map((m) => ageText(at, at + m * MIN)),
    ['Updated just now', 'Updated just now', 'Updated 1 min ago', 'Updated 7 min ago', 'Updated 7 min ago', 'Updated 59 min ago', 'Updated 1 h ago']);
  const src = read('app/components/LoadMapPanel.js');
  // the age clock runs on its own interval, gated only on the panel being shown (not on location permission)
  assert.match(src, /if \(!active\) return undefined;\s*let t = null;\s*const tick = \(\) => \{\s*const n = Date\.now\(\);\s*if \(document\.visibilityState === 'visible'\) setNow\(n\);\s*t = setTimeout\(tick, nextAgeTickMs\(ageAt, n\)\);/);
  assert.match(src, /ageText\(fresh\.at, now\)/);
  // a later "prompt" from the Permissions API (Safari "Ask") doesn't stop polling after a fix arrived
  assert.match(src, /gotFix\.current \? 'granted' : 'prompt'/);
});

test('API: a driver gets 404 from /api/loads/[id]/eta (GET and POST) for a load not assigned to them; ORS never called', async () => {
  const { uc, sb, rpcCalls } = clients({ user: DRIVER, role: 'driver', visible: false }); // visible_loads() returns nothing: not assigned
  const ors = orsOk();
  const deps = { mkUserClient: () => uc, sb, authRetryMs: 0, eta: { env, fetchImpl: ors.impl, cache: createEtaCache(), gate: createUserGate(), take: () => true } };
  const g = await ETA.GET(req('GET'), { params: { id: L1 }, deps });
  assert.equal(g.status, 404); assert.equal((await g.json()).error, 'Load not found.');
  const p = await ETA.POST(req('POST', { lat: 34.06, lng: -117.65, accuracy_m: 30, stop_id: DEL.id }), { params: { id: L1 }, deps });
  assert.equal(p.status, 404);
  assert.equal(ors.calls.length, 0, 'no ORS call');
  assert.ok(rpcCalls.filter(([f]) => f === 'visible_loads').every(([, a]) => a.p_load === L1), 'access decided by visible_loads(p_load) as the caller');
  assert.equal(sb.calls.length, 0, 'service client never reads the load');
});

// ---------- Follow-up PR (Oct 19): label exact to the minute, "Finding your location…" ----------
import { nextAgeTickMs, LOCATING_MAX_MS } from '../../app/lib/loadEta.js';

test('QA #96 r2: the age clock fires right after each whole minute since the fix (no ~72 s "1 min ago")', () => {
  const at = Date.parse('2026-10-19T05:28:15Z');
  // Taylor's case: POST at :15 → "1 min ago" must show at :15 of the next minute, not at :27.
  let now = at, flips = [], label = ageText(at, now);
  for (let i = 0; i < 40 && flips.length < 3; i++) {
    now += nextAgeTickMs(at, now);
    const l = ageText(at, now);
    if (l !== label) { flips.push(now - at); label = l; }
  }
  assert.equal(flips.length, 3);
  flips.forEach((ms, i) => assert.ok(ms >= (i + 1) * 60_000 && ms <= (i + 1) * 60_000 + 100, `flip ${i + 1} at ${ms} ms`));
  assert.ok(nextAgeTickMs(at, at + 1_000) <= AGE_TICK_MS, 'never longer than the max tick (estimate keeps moving)');
  assert.equal(nextAgeTickMs(at, at + 59_000), 1_050, 'just after the minute');
  assert.equal(nextAgeTickMs(null, at), AGE_TICK_MS, 'no answer yet: plain 15 s tick');
  assert.equal(nextAgeTickMs(at + 5_000, at), AGE_TICK_MS, 'clock skew (fix in the future): plain tick');
});

test('map panel: "Finding your location…" from the tap until a fix, an error or a timeout', () => {
  const src = read('app/components/LoadMapPanel.js');
  assert.equal(LOCATING_MAX_MS, 30_000);
  assert.match(src, /if \(!quiet\) \{\s*setLocating\(true\);[\s\S]*setTimeout\(\(\) => \{ locTimer\.current = null; setLocating\(false\); \}, LOCATING_MAX_MS\)/, 'backstop timeout');
  assert.match(src, /\(p\) => \{ stopLocating\(\); gotFix\.current = true;/, 'cleared on a fix');
  assert.match(src, /\(e\) => \{ stopLocating\(\); if \(e\?\.code === 1\)/, 'cleared on any error incl. timeout (code 3) and denied (code 1)');
  assert.match(src, /locating && !fresh && \(\s*<p role="status" data-testid="eta-locating"[^>]*>Finding your location…<\/p>/);
  assert.match(src, /!locating && \(perm === 'prompt' \|\| perm === 'unknown'\) && \(\s*<button type="button" data-testid="eta-use-location"/, 'button hidden while locating (no double prompt)');
  assert.match(src, /useEffect\(\(\) => \(\) => \{ if \(locTimer\.current\) clearTimeout\(locTimer\.current\); \}, \[\]\);/, 'timer cleared on unmount');
  assert.ok(!/localStorage\.|sessionStorage\.|document\.cookie/.test(src), 'position still memory-only');
});
