// PR B: load map + calculated truck miles (OpenRouteService + Leaflet/OSM). Fake data only; no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fakeSupabase } from './fakeSupabase.mjs';
import {
  routeKey, routeStops, stopAddressText, needsGeocode, geocodeAttempts, pickGeocode, decodePolyline, encodePolyline,
  simplifyLine, parseDirections, classifyOrsError, routeFreshness, calculatedMilesPatch, calculatedHint, createLimiter,
  LIMITS, ORS_BASE, ORS_DIRECTIONS_PATH, ORS_GEOCODE_PATH,
} from '../../app/lib/loadRoute.js';
import { ensureRoute, getRoute, geocodeStop, fetchRoute, underSharedLimit } from '../../app/lib/loadRouteServer.js';
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
    const text = u.searchParams.get('text') || `${u.searchParams.get('locality')}|${u.searchParams.get('postalcode')}`;
    for (const [needle, res] of Object.entries(geocode)) if (text.includes(needle)) return typeof res === 'function' ? res() : respond(200, res);
    if (text.includes('Dock')) return respond(200, feature(-96.8, 32.78));
    if (text.includes('Warehouse')) return respond(200, feature(-95.37, 29.76));
    return respond(200, { features: [] });
  };
  return { impl, calls, geocodes: () => calls.filter((c) => !c.url.includes('directions')), routes: () => calls.filter((c) => c.url.includes('directions')) };
}
const allow = () => true;

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

test('geocode: street address first, then city/state/zip (structured); Canada by province', () => {
  const a = geocodeAttempts(pickup);
  assert.equal(a.length, 2);
  assert.equal(a[0].path, ORS_GEOCODE_PATH); assert.equal(a[0].precision, 'street');
  assert.equal(a[0].params.text, '100 Example Dock Rd, Dallas, TX 75201'); assert.equal(a[0].params['boundary.country'], 'US');
  assert.equal(a[1].precision, 'city'); assert.deepEqual(a[1].params, { country: 'US', size: '1', locality: 'Dallas', region: 'TX', postalcode: '75201' });
  assert.equal(geocodeAttempts({ city: 'Testville', state: 'ON' })[0].params.country, 'CA');
  assert.equal(geocodeAttempts({ address_line1: null, city: 'Dallas', state: 'TX' }).length, 1, 'no street → city only');
});

test('pickGeocode rejects a wrong-state match, low confidence and a city hit for a street query', () => {
  assert.deepEqual(pickGeocode(feature(-96.8, 32.78), pickup, 'street'), { lat: 32.78, lng: -96.8, precision: 'street', label: null });
  assert.equal(pickGeocode(feature(-96.8, 32.78, { region_a: 'OK' }), pickup, 'street'), null);
  assert.equal(pickGeocode(feature(-96.8, 32.78, { confidence: 0.4 }), pickup, 'street'), null);
  assert.equal(pickGeocode(feature(-96.8, 32.78, { layer: 'locality' }), pickup, 'street'), null);
  assert.ok(pickGeocode(feature(-96.8, 32.78, { layer: 'locality' }), pickup, 'city'));
  assert.equal(pickGeocode({ features: [] }, pickup, 'street'), null);
  assert.equal(pickGeocode(feature(-500, 32), pickup, 'street'), null);
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

test('freshness: recompute only when addresses change; temporary failures cool down; misses wait for an address change', () => {
  const k = routeKey([pickup, delivery]);
  const geo = [{ ...pickup, lat: 1, lng: 1, geocode_address: stopAddressText(pickup) }, { ...delivery, lat: 2, lng: 2, geocode_address: stopAddressText(delivery) }];
  assert.equal(routeFreshness({ route_key: null }, geo).fresh, false);
  assert.equal(routeFreshness({ route_key: k, route_error: null }, geo).fresh, true);
  assert.equal(routeFreshness({ route_key: k }, [geo[0], { ...geo[1], city: 'Katy' }]).fresh, false, 'address changed');
  const now = Date.parse('2026-10-18T19:00:00Z');
  const rl = { route_key: k, route_error: 'rate_limited', route_computed_at: '2026-10-18T18:55:00Z' };
  assert.equal(routeFreshness(rl, geo, now).fresh, true); assert.equal(routeFreshness(rl, geo, now).retryInMs, 5 * 60_000);
  assert.equal(routeFreshness(rl, geo, now + 6 * 60_000).fresh, false);
  assert.equal(routeFreshness({ route_key: k, route_error: 'geocode_miss', route_computed_at: '2020-01-01T00:00:00Z' }, [geo[0], delivery], now).fresh, true);
  assert.equal(needsGeocode(geo[0]), false); assert.equal(needsGeocode({ ...geo[0], zip: '75202' }), true);
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

// ---------- server: ensureRoute ----------
test('first view computes once: geocodes both stops, saves lat/lng + geocoded_at, route miles, fills empty Planned', async () => {
  const db = fakeSupabase({ tables: seed() });
  const ors = fakeOrs();
  const r = await ensureRoute(db, OWNER, L1, { env, fetchImpl: ors.impl, take: allow });
  assert.equal(r.computed, true);
  assert.equal(ors.geocodes().length, 2); assert.equal(ors.routes().length, 1);
  const [g, d] = [ors.geocodes()[0], ors.routes()[0]];
  assert.ok(g.url.startsWith(`${ORS_BASE}/pelias/v1/search?`)); assert.equal(g.init.headers.Authorization, FAKE_KEY);
  const body = JSON.parse(d.init.body);
  assert.equal(d.url, `${ORS_BASE}${ORS_DIRECTIONS_PATH}`); assert.equal(body.units, 'mi'); assert.deepEqual(body.coordinates, [[-96.8, 32.78], [-95.37, 29.76]]);
  const s1 = db.db.stops.find((s) => s.id === 's1');
  assert.equal(s1.lat, 32.78); assert.equal(s1.lng, -96.8); assert.ok(s1.geocoded_at); assert.equal(s1.geocode_precision, 'street');
  const l = db.db.loads[0];
  assert.equal(l.calculated_miles, 239); assert.equal(l.total_miles, 239); assert.equal(l.miles_source, 'calculated');
  assert.equal(l.route_key, routeKey([pickup, delivery])); assert.equal(l.route_error, null); assert.ok(l.route_geometry);
  assert.equal(r.view.state, 'ready'); assert.equal(r.view.calculated_miles, 239); assert.equal(r.view.stale, false);
  assert.equal(r.view.load.total_miles, 239); assert.equal(r.view.stops.length, 2);
  assert.ok(!JSON.stringify(r).includes(FAKE_KEY), 'the key never goes back to the browser');

  // Second view (and GET): cached, ORS not called again.
  const again = await ensureRoute(db, OWNER, L1, { env, fetchImpl: ors.impl, take: allow });
  assert.equal(again.computed, false); assert.equal(ors.calls.length, 3);
  const got = await getRoute(db, OWNER, L1, { env });
  assert.equal(got.view.calculated_miles, 239); assert.equal(got.view.stale, false); assert.equal(ors.calls.length, 3);

  // Delivery address changes → only that stop is geocoded again, and the route recomputed.
  db.db.stops.find((s) => s.id === 's2').address_line1 = '300 Sample Warehouse Way';
  assert.equal((await getRoute(db, OWNER, L1, { env })).view.stale, true);
  await ensureRoute(db, OWNER, L1, { env, fetchImpl: ors.impl, take: allow });
  assert.equal(ors.geocodes().length, 3); assert.equal(ors.routes().length, 2);
});

test('typed and rate con miles are never replaced; calculated goes in its own column', async () => {
  for (const [tm, src] of [[300, 'typed'], [280, 'rate_con']]) {
    const db = fakeSupabase({ tables: seed({ total_miles: tm, miles_source: src }) });
    await ensureRoute(db, OWNER, L1, { env, fetchImpl: fakeOrs().impl, take: allow });
    const l = db.db.loads[0];
    assert.equal(l.total_miles, tm); assert.equal(l.miles_source, src); assert.equal(l.calculated_miles, 239);
  }
  const db = fakeSupabase({ tables: seed({ total_miles: 250, miles_source: 'calculated' }) });
  await ensureRoute(db, OWNER, L1, { env, fetchImpl: fakeOrs().impl, take: allow });
  assert.equal(db.db.loads[0].total_miles, 239, 'an older calculated value is refreshed');
});

test('street not found → falls back to city/state/zip and still routes', async () => {
  const db = fakeSupabase({ tables: seed() });
  const ors = fakeOrs({ geocode: { 'Warehouse': { features: [] }, 'Houston|77002': feature(-95.36, 29.75, { layer: 'locality' }) } });
  const r = await ensureRoute(db, OWNER, L1, { env, fetchImpl: ors.impl, take: allow });
  const s2 = db.db.stops.find((s) => s.id === 's2');
  assert.equal(s2.geocode_precision, 'city'); assert.equal(s2.lat, 29.75);
  assert.ok(ors.geocodes()[2].url.includes('/pelias/v1/search/structured?'));
  assert.equal(r.view.state, 'ready'); assert.equal(db.db.loads[0].calculated_miles, 239);
});

test('geocode miss: no directions call, pins what it found, clear message, not retried until the address changes', async () => {
  const db = fakeSupabase({ tables: seed() });
  const ors = fakeOrs({ geocode: { 'Warehouse': { features: [] }, 'Houston': { features: [] } } });
  const r = await ensureRoute(db, OWNER, L1, { env, fetchImpl: ors.impl, take: allow });
  assert.equal(ors.routes().length, 0);
  assert.equal(r.view.state, 'error'); assert.match(r.view.message, /Couldn’t find the delivery address on the map/);
  assert.equal(r.view.stops.find((s) => s.id === 's1').lat, 32.78);
  assert.equal(db.db.loads[0].route_error, 'geocode_miss'); assert.equal(db.db.loads[0].total_miles, null);
  const n = ors.calls.length;
  await ensureRoute(db, OWNER, L1, { env, fetchImpl: ors.impl, take: allow });
  assert.equal(ors.calls.length, n, 'no repeat lookups for the same bad address');
});

test('rate limited (429 or our own limiter): saved as a temporary error with a cool-down; Planned untouched', async () => {
  const db = fakeSupabase({ tables: seed() });
  const ors = fakeOrs({ directions: { status: 429, body: { error: 'Rate limit exceeded' } } });
  const r = await ensureRoute(db, OWNER, L1, { env, fetchImpl: ors.impl, take: allow });
  assert.equal(db.db.loads[0].route_error, 'rate_limited'); assert.equal(db.db.loads[0].total_miles, null);
  assert.match(r.view.message, /busy/); assert.ok(r.view.retryInMs > 0);
  await ensureRoute(db, OWNER, L1, { env, fetchImpl: ors.impl, take: allow });
  assert.equal(ors.routes().length, 1, 'waits for the cool-down');
  // Own limiter says no → ORS isn't called at all.
  const db2 = fakeSupabase({ tables: seed() });
  const ors2 = fakeOrs();
  await ensureRoute(db2, OWNER, L1, { env, fetchImpl: ors2.impl, take: () => false });
  assert.equal(ors2.calls.length, 0); assert.equal(db2.db.loads[0].route_error, 'rate_limited');
});

test('timeouts / network errors are temporary; geocodeStop and fetchRoute never throw', async () => {
  const boom = async () => { const e = new Error('t'); e.name = 'TimeoutError'; throw e; };
  assert.deepEqual(await geocodeStop(pickup, { key: FAKE_KEY, fetchImpl: boom, take: allow }), { error: 'timeout' });
  assert.deepEqual(await fetchRoute([{ lat: 1, lng: 1 }, { lat: 2, lng: 2 }], { key: FAKE_KEY, fetchImpl: async () => { throw new Error('net'); }, take: allow }), { error: 'upstream' });
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
  // loads migrated but stops not (or the reverse) → still setupNeeded.
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
test('API: GET is cache-only; POST computes for the owner; drivers get the cached view; sign-in required', async () => {
  const data = fakeSupabase({ tables: seed(), user: { id: OWNER }, role: 'owner' });
  const ors = fakeOrs();
  const deps = { mkUserClient: () => data, shared: null, route: { env, fetchImpl: ors.impl, take: allow } };
  const g = await (await MAP.GET(req(), { params: { id: L1 }, deps })).json();
  assert.equal(g.stale, true); assert.equal(ors.calls.length, 0);
  const p = await MAP.POST(req('POST'), { params: { id: L1 }, deps });
  assert.equal(p.headers.get('cache-control'), 'no-store');
  const pj = await p.json();
  assert.equal(pj.calculated_miles, 239); assert.equal(pj.canEdit, true); assert.ok(!JSON.stringify(pj).includes(FAKE_KEY));

  const d2 = fakeSupabase({ tables: seed(), user: { id: DRIVER }, role: 'driver' });
  const uc = fakeSupabase({ tables: { company_profiles: [{ id: 'p1', owner_id: OWNER }] }, user: { id: DRIVER }, role: 'driver' });
  const ors2 = fakeOrs();
  const dj = await (await MAP.POST(req('POST'), { params: { id: L1 }, deps: { mkUserClient: () => uc, sb: d2, shared: null, route: { env, fetchImpl: ors2.impl, take: allow } } })).json();
  assert.equal(dj.canEdit, false); assert.equal(ors2.calls.length, 0);

  assert.equal((await MAP.GET(req('GET', null), { params: { id: L1 }, deps })).status, 401);
  assert.equal((await MAP.GET(req(), { params: { id: 'nope' }, deps })).status, 404);
  const pre = fakeSupabase({ tables: { company_profiles: [{ id: 'p1', owner_id: OWNER }], loads: [{ id: L1, user_id: OWNER }], stops: [] }, user: { id: OWNER } });
  const sj = await (await MAP.GET(req(), { params: { id: L1 }, deps: { mkUserClient: () => pre, route: { env } } })).json();
  assert.equal(sj.setupNeeded, true); assert.equal(sj.state, 'setup');
});

// ---------- UI / files ----------
test('map: Leaflet lazy-loaded (ssr off), OSM tiles per policy, required attribution, phone friendly', () => {
  const card = read('app/components/LoadRouteCard.js');
  assert.match(card, /dynamic\(\(\) => import\('\.\/RouteMap'\), \{ ssr: false/);
  assert.match(card, /method: 'GET'|call\('GET'\)/); assert.match(card, /j\.stale && j\.canEdit/);
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
