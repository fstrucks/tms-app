// PR B: load map + calculated truck miles (OpenRouteService + Leaflet/OSM). Fake data only; no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fakeSupabase } from './fakeSupabase.mjs';
import {
  routeKey, routeStops, stopAddressText, needsGeocode, geocodeAttempts, pickGeocode, decodePolyline, encodePolyline,
  simplifyLine, parseDirections, classifyOrsError, routeFreshness, calculatedMilesPatch, calculatedHint, createLimiter,
  LIMITS, ORS_BASE, ORS_DIRECTIONS_PATH, ORS_GEOCODE_PATH, ORS_GEOCODE_STRUCTURED_PATH,
} from '../../app/lib/loadRoute.js';
import { ensureRoute, getRoute, geocodeStop, fetchRoute, underSharedLimit, MAX_DURATION_S, STEP_BUDGET_MS, ORS_ROUTE_TIMEOUT_MS, ORS_GEOCODE_TIMEOUT_MS, MAX_STEPS } from '../../app/lib/loadRouteServer.js';
import * as MAP from '../../app/api/loads/[id]/map/route.js';

const OWNER = '00000000-0000-4000-8000-00000000aaaa', DRIVER = '00000000-0000-4000-8000-00000000bbbb';
const L1 = '00000000-0000-4000-8000-0000000000e1';
const FAKE_KEY = 'test-ors-key-not-real-0000';
const env = { ORS_API_KEY: FAKE_KEY };
const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');

const pickup = { id: 's1', load_id: L1, stop_type: 'pickup', sequence: 1, company_name: 'Test Shipper Co', address_line1: '100 Example Dock Rd', city: 'Dallas', state: 'TX', zip: '75201', lat: null, lng: null, geocoded_at: null, geocode_address: null, geocode_precision: null };
const delivery = { id: 's2', load_id: L1, stop_type: 'delivery', sequence: 2, company_name: 'Test Receiver LLC', address_line1: '200 Sample Warehouse Way', city: 'Houston', state: 'TX', zip: '77002', lat: null, lng: null, geocoded_at: null, geocode_address: null, geocode_precision: null };
const baseLoad = { id: L1, user_id: OWNER, rate: 1200, total_miles: null, miles_source: null, rate_per_mile: null, calculated_miles: null, route_key: null, route_geometry: null, route_computed_at: null, route_error: null };
const seed = (load = {}, stops = [pickup, delivery]) => ({ company_profiles: [{ id: 'p1', owner_id: OWNER }], loads: [{ ...baseLoad, ...load }], stops: stops.map((s) => ({ ...s })) });

const LINE = encodePolyline([[32.7767, -96.797], [31.5, -96.2], [29.7604, -95.3698]]);
const feature = (lng, lat, props) => ({ type: 'FeatureCollection', features: [{ geometry: { coordinates: [lng, lat] }, properties: { layer: 'address', confidence: 1, region_a: 'TX', ...props } }] });
// Fake ORS: geocodes by query text; directions return 239.4 mi.
function fakeOrs({ geocode = {}, directions = { status: 200, body: { routes: [{ summary: { distance: 239.4 }, geometry: LINE }] } } } = {}) {
  const calls = [];
  const impl = async (url, init = {}) => {
    calls.push({ url, init });
    const u = new URL(url);
    const respond = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
    if (u.pathname === ORS_DIRECTIONS_PATH) return respond(directions.status, directions.body);
    const sp = u.searchParams;
    const text = sp.get('text') || [sp.get('address'), sp.get('locality'), sp.get('postalcode')].filter(Boolean).join('|');
    for (const [needle, res] of Object.entries(geocode)) if (text.includes(needle)) return typeof res === 'function' ? res() : respond(200, res);
    if (text.includes('Dock')) return respond(200, feature(-96.8, 32.78));
    if (text.includes('Warehouse')) return respond(200, feature(-95.37, 29.76));
    return respond(200, { features: [] });
  };
  return { impl, calls, geocodes: () => calls.filter((c) => !c.url.includes('directions')), routes: () => calls.filter((c) => c.url.includes('directions')) };
}
const allow = () => true;
// The page calls POST once per step until nothing is stale (QA #83: short requests).
async function runSteps(db, opts, max = MAX_STEPS) {
  let r, n = 0;
  do { r = await ensureRoute(db, OWNER, L1, opts); n += 1; } while (r.view?.stale && r.view?.next && n < max);
  return { ...r, steps: n };
}

// ---------- pure helpers ----------
test('route key: same addresses → same key (formatting ignored); any address change → new key; needs 2 stops', () => {
  const k = routeKey([pickup, delivery]);
  assert.match(k, /^[0-9a-f]{16}$/);
  assert.equal(routeKey([{ ...delivery }, { ...pickup }]), k, 'sorted by sequence');
  assert.equal(routeKey([{ ...pickup, address_line1: '100  EXAMPLE dock rd.' }, delivery]), k);
  assert.notEqual(routeKey([pickup, { ...delivery, zip: '77003' }]), k);
  assert.notEqual(routeKey([pickup, { ...delivery, address_line1: '201 Sample Warehouse Way' }]), k);
  assert.equal(routeKey([pickup]), null);
  assert.equal(routeKey([pickup, { id: 'x', sequence: 3 }]), null, 'a stop with no address is skipped');
  assert.deepEqual(routeStops([delivery, { id: 'x', sequence: 0 }, pickup]).map((s) => s.id), ['s1', 's2']);
});

test('geocode: structured search first (street + city + state + zip), then free text; Canada by province', () => {
  const a = geocodeAttempts(pickup);
  assert.equal(a.length, 2);
  assert.equal(a[0].path, ORS_GEOCODE_STRUCTURED_PATH);
  assert.deepEqual(a[0].params, { country: 'US', size: '1', address: '100 Example Dock Rd', locality: 'Dallas', region: 'TX', postalcode: '75201' });
  assert.equal(a[1].path, ORS_GEOCODE_PATH);
  assert.equal(a[1].params.text, '100 Example Dock Rd, Dallas, TX 75201'); assert.equal(a[1].params['boundary.country'], 'US');
  assert.equal(geocodeAttempts({ city: 'Testville', state: 'ON' })[0].params.country, 'CA');
  assert.equal(geocodeAttempts({ address_line1: null, city: 'Dallas', state: 'TX' }).length, 1, 'no street → structured city only');
});

test('pickGeocode: street ≥ 0.5 confidence; city/ZIP centroid = city; wrong 2-letter state rejected; "Texas" vs TX ok', () => {
  assert.deepEqual(pickGeocode(feature(-96.8, 32.78), pickup), { lat: 32.78, lng: -96.8, precision: 'street', label: null });
  assert.equal(pickGeocode(feature(-96.8, 32.78, { confidence: 0.55 }), pickup).precision, 'street', 'loosened from 0.7');
  assert.equal(pickGeocode(feature(-96.8, 32.78, { confidence: 0.3 }), pickup), null);
  assert.equal(pickGeocode(feature(-96.8, 32.78, { region_a: 'OK' }), pickup), null);
  assert.equal(pickGeocode(feature(-96.8, 32.78, { region_a: 'TX' }), { ...pickup, state: 'Texas' }).precision, 'street');
  assert.equal(pickGeocode(feature(-96.8, 32.78, { layer: 'postalcode', confidence: 0.8 }), pickup).precision, 'city');
  assert.equal(pickGeocode(feature(-96.8, 32.78, { layer: 'locality', confidence: 0.6 }), pickup).precision, 'city');
  assert.equal(pickGeocode(feature(-96.8, 32.78, { layer: 'country' }), pickup), null);
  assert.equal(pickGeocode({ features: [] }, pickup), null);
  assert.equal(pickGeocode(feature(-500, 32), pickup), null);
});

test('polyline: decodes the reference example, round-trips, simplifies long routes', () => {
  assert.deepEqual(decodePolyline('_p~iF~ps|U_ulLnnqC_mqNvxq`@'), [[38.5, -120.2], [40.7, -120.95], [43.252, -126.453]]);
  const pts = Array.from({ length: 3000 }, (_, i) => [32 + i * 0.001, -97 + Math.sin(i / 50) * 0.05]);
  const back = decodePolyline(encodePolyline(pts));
  assert.equal(back.length, 3000); assert.ok(Math.abs(back[1234][1] - pts[1234][1]) < 1e-5);
  const s = simplifyLine(pts, 400);
  assert.ok(s.length <= 400 && s.length > 10); assert.deepEqual(s[0], pts[0]); assert.deepEqual(s.at(-1), pts.at(-1));
  assert.deepEqual(decodePolyline(''), []); assert.deepEqual(decodePolyline(null), []);
});

test('directions parse (units=mi) and ORS error codes', () => {
  assert.equal(parseDirections({ routes: [{ summary: { distance: 239.4 }, geometry: LINE }] }).miles, 239);
  assert.equal(parseDirections({ routes: [{ summary: { distance: 0 } }] }), null);
  assert.equal(parseDirections({}), null);
  assert.equal(classifyOrsError({ status: 429 }), 'rate_limited');
  assert.equal(classifyOrsError({ status: 403 }), 'bad_key');
  assert.equal(classifyOrsError({ status: 404, body: { error: { code: 2010 } } }), 'no_route');
  assert.equal(classifyOrsError({ status: 500, body: { error: { code: 2009 } } }), 'no_route');
  assert.equal(classifyOrsError({ status: 502 }), 'upstream');
  assert.equal(classifyOrsError({ timedOut: true }), 'timeout');
});

test('freshness: one step at a time; recompute only when addresses change; cool-downs; misses wait for an address change', () => {
  const k = routeKey([pickup, delivery]);
  const g = (s, lat) => ({ ...s, lat, lng: lat, geocode_address: stopAddressText(s), geocode_precision: lat == null ? null : 'street' });
  const geo = [g(pickup, 1), g(delivery, 2)];
  assert.equal(routeFreshness({ route_key: null }, [pickup, delivery]).next, 'geocode');
  assert.equal(routeFreshness({ route_key: null }, geo).next, 'route');
  assert.equal(routeFreshness({ route_key: k, route_error: null, calculated_miles: 239 }, geo).fresh, true);
  assert.equal(routeFreshness({ route_key: k, calculated_miles: 239 }, [geo[0], { ...geo[1], city: 'Katy' }]).next, 'geocode', 'address changed');
  const now = Date.parse('2026-10-18T19:00:00Z');
  const rl = { route_key: k, route_error: 'rate_limited', route_computed_at: '2026-10-18T18:55:00Z' };
  assert.equal(routeFreshness(rl, geo, now).fresh, true); assert.equal(routeFreshness(rl, geo, now).retryInMs, 5 * 60_000);
  assert.equal(routeFreshness(rl, geo, now + 6 * 60_000).next, 'route');
  assert.equal(routeFreshness(rl, [geo[0], delivery], now).fresh, true, 'a geocode cool-down also waits');
  const missed = [geo[0], g(delivery, null)];
  assert.equal(routeFreshness({ route_key: null }, missed).next, 'miss');
  assert.equal(routeFreshness({ route_key: k, route_error: 'geocode_miss', route_computed_at: '2020-01-01T00:00:00Z' }, missed, now).fresh, true);
  assert.equal(routeFreshness({ route_key: k, route_error: 'no_route' }, geo).fresh, true);
  assert.equal(needsGeocode(geo[0]), false); assert.equal(needsGeocode(missed[1]), false, 'a remembered miss is not looked up again');
  assert.equal(needsGeocode({ ...geo[0], zip: '75202' }), true);
});

test('precedence: calculated fills Planned only when empty or already calculated (typed > rate con > calculated)', () => {
  assert.deepEqual(calculatedMilesPatch({ total_miles: null, miles_source: null }, 239), { calculated_miles: 239, total_miles: 239, miles_source: 'calculated' });
  assert.deepEqual(calculatedMilesPatch({ total_miles: 250, miles_source: 'calculated' }, 239), { calculated_miles: 239, total_miles: 239, miles_source: 'calculated' });
  assert.deepEqual(calculatedMilesPatch({ total_miles: 260, miles_source: 'rate_con' }, 239), { calculated_miles: 239 });
  assert.deepEqual(calculatedMilesPatch({ total_miles: 300, miles_source: 'typed' }, 239), { calculated_miles: 239 });
  assert.deepEqual(calculatedMilesPatch({ total_miles: null }, 239), { calculated_miles: 239 }, 'before the PR A migration Planned is left alone');
});

test('"Calculated N mi · Use this" only when rate con and route differ by more than 10%', () => {
  assert.deepEqual(calculatedHint({ load: { calculated_miles: 239, total_miles: 280 }, rateConMiles: 280 }), { miles: 239, diffPct: 15 });
  assert.equal(calculatedHint({ load: { calculated_miles: 239, total_miles: 260 }, rateConMiles: 260 }), null, '8% → no hint');
  assert.equal(calculatedHint({ load: { calculated_miles: 239, total_miles: 239 }, rateConMiles: 280 }), null, 'already using it');
  assert.equal(calculatedHint({ load: { calculated_miles: 239, total_miles: 239 }, rateConMiles: null }), null);
  assert.equal(calculatedHint({ load: { calculated_miles: null, total_miles: 280 }, rateConMiles: 280 }), null);
});

test('limiter: under the free plan (40/min, 2,000/day directions) per minute and per UTC day', () => {
  assert.ok(LIMITS.directions.perMinute < 40 && LIMITS.directions.perDay < 2000);
  assert.ok(LIMITS.geocode.perMinute < 100 && LIMITS.geocode.perDay < 1000);
  let now = Date.parse('2026-10-18T10:00:00Z');
  const l = createLimiter({ directions: { perMinute: 3, perDay: 5 } }, () => now);
  assert.equal([1, 2, 3, 4].map(() => l.take('directions')).join(), 'true,true,true,false');
  now += 61_000; assert.equal(l.take('directions'), true); assert.equal(l.take('directions'), true); assert.equal(l.take('directions'), false, 'day cap');
  now = Date.parse('2026-10-19T00:00:05Z'); assert.equal(l.take('directions'), true, 'new UTC day');
});

test('shared limit counts recent route attempts in the database (best effort)', async () => {
  const mk = (m, d) => ({ from: () => ({ select: () => ({ gte: async (_c, v) => ({ count: v.endsWith('T00:00:00.000Z') ? d : m, error: null }) }) }) });
  assert.equal(await underSharedLimit(mk(2, 10)), true);
  assert.equal(await underSharedLimit(mk(LIMITS.directions.perMinute, 10)), false);
  assert.equal(await underSharedLimit(mk(1, LIMITS.directions.perDay)), false);
  assert.equal(await underSharedLimit(null), true);
  assert.equal(await underSharedLimit({ from: () => { throw new Error('x'); } }), true);
});

// ---------- server: ensureRoute (one step per call) ----------
test('time limits: every step fits well inside maxDuration (QA #83)', () => {
  assert.ok(STEP_BUDGET_MS + 3_000 <= MAX_DURATION_S * 1000);
  assert.ok(ORS_ROUTE_TIMEOUT_MS < STEP_BUDGET_MS && 2 * ORS_GEOCODE_TIMEOUT_MS < STEP_BUDGET_MS);
  const src = read('app/api/loads/[id]/map/route.js');
  assert.match(src, new RegExp(`export const maxDuration = ${MAX_DURATION_S};`));
});

test('each POST does one short step: geocode stop 1, geocode stop 2, then the route; never geocode + route together', async () => {
  const db = fakeSupabase({ tables: seed() });
  const ors = fakeOrs();
  const opts = { env, fetchImpl: ors.impl, take: allow };
  let r = await ensureRoute(db, OWNER, L1, opts);
  assert.equal(r.view.stale, true); assert.equal(r.view.next, 'geocode'); assert.equal(ors.geocodes().length, 1); assert.equal(ors.routes().length, 0);
  assert.equal(r.view.stops[0].lat, 32.78, 'the first pin shows right away');
  r = await ensureRoute(db, OWNER, L1, opts);
  assert.equal(r.view.next, 'route'); assert.equal(ors.geocodes().length, 2); assert.equal(ors.routes().length, 0);
  r = await ensureRoute(db, OWNER, L1, opts);
  assert.equal(r.view.stale, false); assert.equal(ors.routes().length, 1); assert.equal(ors.geocodes().length, 2);
  const [g, d] = [ors.geocodes()[0], ors.routes()[0]];
  assert.ok(g.url.startsWith(`${ORS_BASE}/pelias/v1/search/structured?`)); assert.equal(g.init.headers.Authorization, FAKE_KEY);
  assert.ok(g.init.signal, 'every ORS call has a timeout');
  const body = JSON.parse(d.init.body);
  assert.equal(d.url, `${ORS_BASE}${ORS_DIRECTIONS_PATH}`); assert.equal(body.units, 'mi'); assert.deepEqual(body.coordinates, [[-96.8, 32.78], [-95.37, 29.76]]);
  const s1 = db.db.stops.find((s) => s.id === 's1');
  assert.equal(s1.lat, 32.78); assert.equal(s1.lng, -96.8); assert.ok(s1.geocoded_at); assert.equal(s1.geocode_precision, 'street');
  const l = db.db.loads[0];
  assert.equal(l.calculated_miles, 239); assert.equal(l.total_miles, 239); assert.equal(l.miles_source, 'calculated');
  assert.equal(l.route_key, routeKey([pickup, delivery])); assert.equal(l.route_error, null); assert.ok(l.route_geometry);
  assert.equal(r.view.state, 'ready'); assert.equal(r.view.calculated_miles, 239); assert.ok(r.view.geometry);
  assert.equal(r.view.load.total_miles, 239); assert.equal(r.view.stops.length, 2);
  assert.ok(!JSON.stringify(r).includes(FAKE_KEY), 'the key never goes back to the browser');

  // Cached: POST and GET don't call ORS again.
  assert.equal((await ensureRoute(db, OWNER, L1, opts)).computed, false); assert.equal(ors.calls.length, 3);
  const got = await getRoute(db, OWNER, L1, { env });
  assert.equal(got.view.calculated_miles, 239); assert.equal(got.view.stale, false); assert.equal(ors.calls.length, 3);

  // Delivery address changes → only that stop is looked up again, then the route.
  db.db.stops.find((s) => s.id === 's2').address_line1 = '300 Sample Warehouse Way';
  const st = await getRoute(db, OWNER, L1, { env });
  assert.equal(st.view.stale, true); assert.equal(st.view.geometry, null, 'old line hidden for new addresses');
  const done = await runSteps(db, opts);
  assert.equal(done.steps, 2); assert.equal(ors.geocodes().length, 3); assert.equal(ors.routes().length, 2);
});

test('a slow ORS can never outlast the step budget (timeouts capped by the deadline)', async () => {
  const db = fakeSupabase({ tables: seed() });
  const hang = (url, init) => new Promise((_, rej) => init.signal.addEventListener('abort', () => { const e = new Error('t'); e.name = 'TimeoutError'; rej(e); }));
  const t0 = Date.now();
  const keep = setInterval(() => {}, 50); // AbortSignal.timeout timers don't keep Node's test loop alive
  const r = await ensureRoute(db, OWNER, L1, { env, fetchImpl: hang, take: allow, budgetMs: 2_500 }).finally(() => clearInterval(keep));
  assert.ok(Date.now() - t0 < 2_400, 'answered before the budget');
  assert.equal(db.db.loads[0].route_error, 'timeout'); assert.match(r.view.message, /didn’t answer/);
});

test('typed and rate con miles are never replaced; calculated goes in its own column', async () => {
  for (const [tm, src] of [[300, 'typed'], [280, 'rate_con']]) {
    const db = fakeSupabase({ tables: seed({ total_miles: tm, miles_source: src }) });
    await runSteps(db, { env, fetchImpl: fakeOrs().impl, take: allow });
    const l = db.db.loads[0];
    assert.equal(l.total_miles, tm); assert.equal(l.miles_source, src); assert.equal(l.calculated_miles, 239);
  }
  const db = fakeSupabase({ tables: seed({ total_miles: 250, miles_source: 'calculated' }) });
  await runSteps(db, { env, fetchImpl: fakeOrs().impl, take: allow });
  assert.equal(db.db.loads[0].total_miles, 239, 'an older calculated value is refreshed');
});

test('street not found → city/ZIP centroid ("city"), and it still routes', async () => {
  const db = fakeSupabase({ tables: seed() });
  const ors = fakeOrs({ geocode: { 'Warehouse': feature(-95.36, 29.75, { layer: 'postalcode', confidence: 0.8 }) } });
  const r = await runSteps(db, { env, fetchImpl: ors.impl, take: allow });
  const s2 = db.db.stops.find((s) => s.id === 's2');
  assert.equal(s2.geocode_precision, 'city'); assert.equal(s2.lat, 29.75);
  assert.equal(r.view.state, 'ready'); assert.equal(db.db.loads[0].calculated_miles, 239);
});

test('geocode miss: no directions call, pins what it found, clear message, not retried until the address changes', async () => {
  const db = fakeSupabase({ tables: seed() });
  const ors = fakeOrs({ geocode: { 'Warehouse': { features: [] } } });
  const r = await runSteps(db, { env, fetchImpl: ors.impl, take: allow });
  assert.equal(ors.routes().length, 0);
  assert.equal(r.view.state, 'error'); assert.match(r.view.message, /Couldn’t find the delivery address on the map/);
  assert.equal(r.view.stops.find((s) => s.id === 's1').lat, 32.78);
  assert.equal(db.db.loads[0].route_error, 'geocode_miss'); assert.equal(db.db.loads[0].total_miles, null);
  const n = ors.calls.length;
  await runSteps(db, { env, fetchImpl: ors.impl, take: allow });
  assert.equal(ors.calls.length, n, 'no repeat lookups for the same bad address');
});

test('rate limited (429 or our own limiter): saved as a temporary error with a cool-down; Planned untouched', async () => {
  const db = fakeSupabase({ tables: seed() });
  const ors = fakeOrs({ directions: { status: 429, body: { error: 'Rate limit exceeded' } } });
  const r = await runSteps(db, { env, fetchImpl: ors.impl, take: allow });
  assert.equal(db.db.loads[0].route_error, 'rate_limited'); assert.equal(db.db.loads[0].total_miles, null);
  assert.match(r.view.message, /busy/); assert.ok(r.view.retryInMs > 0); assert.equal(r.view.stale, false);
  await runSteps(db, { env, fetchImpl: ors.impl, take: allow });
  assert.equal(ors.routes().length, 1, 'waits for the cool-down');
  const db2 = fakeSupabase({ tables: seed() });
  const ors2 = fakeOrs();
  await runSteps(db2, { env, fetchImpl: ors2.impl, take: () => false });
  assert.equal(ors2.calls.length, 0); assert.equal(db2.db.loads[0].route_error, 'rate_limited');
});

test('timeouts / network errors are temporary; geocodeStop and fetchRoute never throw', async () => {
  const boom = async () => { const e = new Error('t'); e.name = 'TimeoutError'; throw e; };
  assert.deepEqual(await geocodeStop(pickup, { key: FAKE_KEY, fetchImpl: boom, take: allow }), { error: 'timeout' });
  assert.deepEqual(await fetchRoute([{ lat: 1, lng: 1 }, { lat: 2, lng: 2 }], { key: FAKE_KEY, fetchImpl: async () => { throw new Error('net'); }, take: allow }), { error: 'upstream' });
  // structured times out but free text answers → still pinned
  let n = 0;
  const flaky = async (url) => { n += 1; if (n === 1) { const e = new Error('t'); e.name = 'TimeoutError'; throw e; } return { ok: true, status: 200, json: async () => feature(-96.8, 32.78) }; };
  assert.equal((await geocodeStop(pickup, { key: FAKE_KEY, fetchImpl: flaky, take: allow })).precision, 'street');
});

test('no ORS_API_KEY: nothing is called, a calm note is shown', async () => {
  const db = fakeSupabase({ tables: seed() });
  const ors = fakeOrs();
  const r = await ensureRoute(db, OWNER, L1, { env: {}, fetchImpl: ors.impl, take: allow });
  assert.equal(ors.calls.length, 0); assert.equal(r.view.state, 'no_key'); assert.match(r.view.message, /aren’t set up yet/);
  assert.equal((await getRoute(db, OWNER, L1, { env: { ORS_API_KEY: '  ' } })).view.state, 'no_key');
});

test('before the migration: setupNeeded, no ORS calls, nothing written', async () => {
  const oldLoad = { id: L1, user_id: OWNER, total_miles: null, rate: 1200 };
  const oldStops = [pickup, delivery].map(({ lat, lng, geocoded_at, geocode_address, geocode_precision, ...s }) => s);
  const db = fakeSupabase({ tables: { loads: [oldLoad], stops: oldStops } });
  const ors = fakeOrs();
  assert.equal((await ensureRoute(db, OWNER, L1, { env, fetchImpl: ors.impl, take: allow })).setupNeeded, true);
  assert.equal((await getRoute(db, OWNER, L1, { env })).setupNeeded, true);
  assert.equal(ors.calls.length, 0);
  assert.equal(db.calls.filter((c) => c.op === 'update').length, 0);
  const db2 = fakeSupabase({ tables: { loads: [{ ...baseLoad }], stops: oldStops } });
  assert.equal((await ensureRoute(db2, OWNER, L1, { env, fetchImpl: ors.impl, take: allow })).setupNeeded, true);
});

test('fewer than two addresses: no ORS call, "too_few" state', async () => {
  const db = fakeSupabase({ tables: seed({}, [pickup]) });
  const ors = fakeOrs();
  const r = await ensureRoute(db, OWNER, L1, { env, fetchImpl: ors.impl, take: allow });
  assert.equal(ors.calls.length, 0); assert.equal(r.view.state, 'too_few');
});

// ---------- API route ----------
const req = (method = 'GET', auth = 'Bearer t') => new Request(`http://x/api/loads/${L1}/map`, { method, headers: auth ? { authorization: auth } : {} });
test('API: GET is cache-only; POST steps for the owner; drivers get the cached view; sign-in required', async () => {
  const data = fakeSupabase({ tables: seed(), user: { id: OWNER }, role: 'owner' });
  const ors = fakeOrs();
  const deps = { mkUserClient: () => data, authRetryMs: 0, shared: null, route: { env, fetchImpl: ors.impl, take: allow } };
  const g = await (await MAP.GET(req(), { params: { id: L1 }, deps })).json();
  assert.equal(g.stale, true); assert.equal(g.next, 'geocode'); assert.equal(ors.calls.length, 0);
  let pj;
  for (let i = 0; i < 3; i++) {
    const p = await MAP.POST(req('POST'), { params: { id: L1 }, deps });
    assert.equal(p.headers.get('cache-control'), 'no-store');
    pj = await p.json();
  }
  assert.equal(pj.calculated_miles, 239); assert.equal(pj.canEdit, true); assert.ok(!JSON.stringify(pj).includes(FAKE_KEY));

  // PR #110: only the ASSIGNED driver gets the view, and without rate fields unless Show rate is on.
  const seeded = seed(); seeded.loads = seeded.loads.map((l) => (l.id === L1 ? { ...l, assigned_driver_user_id: DRIVER, show_rate_to_driver: false, rate_per_mile: 2.5 } : l));
  const d2 = fakeSupabase({ tables: seeded, user: { id: DRIVER }, role: 'driver' });
  const uc = fakeSupabase({ tables: { company_profiles: [{ id: 'p1', owner_id: OWNER }] }, user: { id: DRIVER }, role: 'driver' });
  const ors2 = fakeOrs();
  const dj = await (await MAP.POST(req('POST'), { params: { id: L1 }, deps: { mkUserClient: () => uc, sb: d2, authRetryMs: 0, shared: null, route: { env, fetchImpl: ors2.impl, take: allow } } })).json();
  assert.equal(dj.canEdit, false); assert.equal(ors2.calls.length, 0);
  assert.ok(dj.load && !('rate_per_mile' in dj.load), 'no RPM for a driver without Show rate');

  const noTok = await MAP.GET(req('GET', null), { params: { id: L1 }, deps });
  assert.equal(noTok.status, 401); assert.match((await noTok.json()).error, /Sign in first/);
  assert.equal((await MAP.GET(req(), { params: { id: 'nope' }, deps })).status, 404);
  const pre = fakeSupabase({ tables: { company_profiles: [{ id: 'p1', owner_id: OWNER }], loads: [{ id: L1, user_id: OWNER }], stops: [] }, user: { id: OWNER } });
  const sj = await (await MAP.GET(req(), { params: { id: L1 }, deps: { mkUserClient: () => pre, authRetryMs: 0, route: { env } } })).json();
  assert.equal(sj.setupNeeded, true); assert.equal(sj.state, 'setup');
});

test('API auth: falls back to the database token check when Supabase Auth is down (like the fields API)', async () => {
  const data = fakeSupabase({ tables: seed(), user: null, role: 'owner' });
  data.auth.getUser = async () => ({ data: null, error: { status: 503, message: 'upstream unavailable' } });
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const tok = `${b64({ alg: 'HS256' })}.${b64({ sub: OWNER, role: 'authenticated', exp: Math.floor(Date.now() / 1000) + 600 })}.sig`;
  const j = await (await MAP.GET(req('GET', `Bearer ${tok}`), { params: { id: L1 }, deps: { mkUserClient: () => data, authRetryMs: 0, route: { env } } })).json();
  assert.equal(j.state, 'ready'); assert.equal(j.stale, true);
  const old = `${b64({ alg: 'HS256' })}.${b64({ sub: OWNER, role: 'authenticated', exp: 1 })}.sig`;
  assert.equal((await MAP.GET(req('GET', `Bearer ${old}`), { params: { id: L1 }, deps: { mkUserClient: () => data, authRetryMs: 0, route: { env } } })).status, 401);
  // A rejected token (Auth answers 401) → 401, not 503.
  const rej = fakeSupabase({ tables: seed() });
  rej.auth.getUser = async () => ({ data: null, error: { status: 401, message: 'invalid JWT' } });
  assert.equal((await MAP.GET(req(), { params: { id: L1 }, deps: { mkUserClient: () => rej, authRetryMs: 0 } })).status, 401);
});

test('API never crashes without JSON: an unexpected throw → 500 JSON with state "failed"', async () => {
  const bad = { auth: { getUser: async () => { throw new TypeError('boom'); } }, from: () => { throw new TypeError('boom'); }, rpc: async () => { throw new TypeError('boom'); } };
  for (const fn of [MAP.GET, MAP.POST]) {
    const r = await fn(req(fn === MAP.POST ? 'POST' : 'GET'), { params: { id: L1 }, deps: { mkUserClient: () => bad, authRetryMs: 0 } });
    assert.ok([500, 503].includes(r.status)); const j = await r.json(); assert.equal(j.state, 'failed'); assert.ok(j.error);
  }
});

test('client: steps POST while a step is to come (capped), keeps pins on a failed step', () => {
  const card = read('app/components/LoadRouteCard.js');
  assert.match(card, /while \(live && cardPhase\(j, \{ steps, max: MAX_STEPS \}\)\.computing\)/);
  assert.match(card, /callMap\(\{ url: `\/api\/loads\/\$\{loadId\}\/map`, method, getToken: token \}\)/); assert.match(card, /refreshSession\(\)/);
  assert.match(card, /cur\.stops \? \{ \.\.\.cur, computing: false, message: msg \}/);
  assert.match(card, /Some pins are approximate/);
});

// ---------- UI / files ----------
test('map: Leaflet lazy-loaded (ssr off), OSM tiles per policy, required attribution, phone friendly', () => {
  const card = read('app/components/LoadRouteCard.js');
  assert.match(card, /dynamic\(\(\) => import\('\.\/RouteMap'\), \{ ssr: false/);
  assert.match(card, /call\('GET'\)/); assert.match(card, /cardPhase\(j, \{ steps, max: MAX_STEPS \}\)\.computing/);
  const map = read('app/components/RouteMap.js');
  assert.match(map, /https:\/\/tile\.openstreetmap\.org\/\{z\}\/\{x\}\/\{y\}\.png/);
  assert.match(map, /maxZoom: 19/);
  const text = map.match(/ATTRIBUTION = '([^']+)'/)[1].replace(/<[^>]+>/g, '');
  assert.equal(text, '© openrouteservice by HeiGIT | © OpenStreetMap contributors');
  assert.match(map, /scrollWheelZoom: false/); assert.match(map, /dragging: !touch/); assert.match(map, /clamp\(180px/);
  assert.match(map, /import 'leaflet\/dist\/leaflet\.css'/);
  assert.ok(!/ORS_API_KEY/.test(card + map), 'no key in client code');
  const page = read('app/loads/[id]/page.js');
  assert.ok(page.indexOf('<LoadRouteCard') > 0 && page.indexOf('<LoadRouteCard') < page.indexOf('>Stops</h2>'), 'map at the top, above Stops');
  assert.ok(JSON.parse(read('package.json')).dependencies.leaflet);
});

test('Planned miles card: "Calculated N mi" with "Use this" saves miles_source calculated', () => {
  const src = read('app/components/LoadMileage.js');
  assert.match(src, /calculatedHint\(\{ load, rateConMiles \}\)/);
  assert.match(src, /data-testid="use-calculated"[^>]*>Use this<\/button>|Use this<\/button>/);
  assert.match(src, /source: 'calculated'/);
  assert.match(src, /setManual\(load\.total_miles \?\? ''\); \}, \[load\.total_miles\]\)/);
});

test('migration: adds stop location + load route columns only, not applied, grants the route columns', () => {
  const sql = read('supabase/migrations/20261018000400_load_route_map.sql');
  for (const c of ['lat double precision', 'lng double precision', 'geocoded_at timestamptz', 'geocode_address text', 'geocode_precision text'])
    assert.match(sql, new RegExp(`alter table public\\.stops add column if not exists ${c}`));
  for (const c of ['calculated_miles integer', 'route_key text', 'route_geometry text', 'route_computed_at timestamptz', 'route_error text'])
    assert.match(sql, new RegExp(`alter table public\\.loads add column if not exists ${c}`));
  assert.match(sql, /grant update \(calculated_miles, route_key, route_geometry, route_computed_at, route_error\) on public\.loads to authenticated/);
  assert.match(sql, /notify pgrst, 'reload schema'/);
  assert.ok(!/\b(drop table|delete from|truncate|update public\.)/i.test(sql), 'no data changes');
  assert.ok(!/miles_source/.test(sql.replace(/^--.*$/gm, '')), 'PR A owns miles_source');
});
