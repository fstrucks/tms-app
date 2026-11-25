// Route options, Phase 1 (display only). Fake data only; ORS is always a mocked fetch.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fakeSupabase } from './fakeSupabase.mjs';
import { classifyOrsError, routeKey, stopAddressText, encodePolyline, createLimiter } from '../../app/lib/loadRoute.js';
import { sameRoute, sameLine, mergeOptions, viewOfReply, nextIndex, mapOptions, chipDetail, announceText, OPTIONS_TEXT, VARIANTS } from '../../app/lib/routeOptions.js';
import { computeOptions, newOptionsState, createOptionsCache, OPTIONS_LIMITS, NO_TOLLS_MAX_MILES, OPTIONS_TIMEOUT_MS } from '../../app/lib/routeOptionsServer.js';
import { fetchRoute } from '../../app/lib/loadRouteServer.js';
import * as OPT from '../../app/api/loads/[id]/map/options/route.js';

const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');
const OWNER = '00000000-0000-4000-8000-00000000aaaa', DRIVER = '00000000-0000-4000-8000-00000000dddd', OTHER = '00000000-0000-4000-8000-00000000eeee';
const L1 = '00000000-0000-4000-8000-0000000000f1';
const env = { ORS_API_KEY: 'test-ors-key-not-real-0000' };
const g = (s, lat, lng) => ({ ...s, lat, lng, geocoded_at: '2026-10-18T20:00:00Z', geocode_address: stopAddressText(s), geocode_precision: 'city' });
const pickup = g({ id: 'p', load_id: L1, stop_type: 'pickup', sequence: 1, address_line1: '10 Test Yard Rd', city: 'Barstow', state: 'CA', zip: '92311' }, 34.9, -117.0);
const delivery = g({ id: 'd', load_id: L1, stop_type: 'delivery', sequence: 2, address_line1: '20 Sample Dock Ave', city: 'Phoenix', state: 'AZ', zip: '85043' }, 33.4, -112.2);
const KEY = routeKey([pickup, delivery]);
const FAST = [[34.9, -117.0], [34.2, -114.6], [33.4, -112.2]];
const SHORT = [[34.9, -117.0], [34.9, -114.0], [33.4, -112.2]];
const LINE = encodePolyline(FAST);
// Stored fastest is kept under NO_TOLLS_MAX_MILES so No tolls is asked; long trips have their own tests below.
const load0 = { id: L1, user_id: OWNER, rate: 1000, total_miles: 350, miles_source: 'manual', rate_per_mile: 2.86, calculated_miles: 143, route_key: KEY, route_geometry: LINE, route_computed_at: '2026-10-18T20:00:00Z', route_error: null, assigned_driver_user_id: DRIVER, show_rate_to_driver: false };
const mk = (load = {}, user = OWNER, role = 'owner') => fakeSupabase({ tables: { company_profiles: [{ id: 'c', owner_id: OWNER }], loads: [{ ...load0, ...load }], stops: [{ ...pickup }, { ...delivery }] }, user: { id: user }, role });
// Fake ORS: answers by request body (preference / avoid_features).
function fakeOrs(map) {
  const calls = [];
  const f = async (url, init) => {
    const b = JSON.parse(init.body); calls.push(b);
    const k = b.options?.avoid_features ? 'no_tolls' : b.preference || 'fastest';
    const r = map[k];
    if (r instanceof Error) throw r;
    if (r?.status) return new Response(JSON.stringify({ error: { code: r.code ?? 1, message: 'fake' } }), { status: r.status });
    return new Response(JSON.stringify({ routes: [{ summary: { distance: r.miles, duration: r.seconds }, geometry: encodePolyline(r.line) }] }), { status: 200 });
  };
  f.calls = calls; return f;
}
const opts = (o = {}) => ({ env, state: newOptionsState(), total: null, ...o });

// ---- duplicate detection ----
test('sameRoute: miles ±0.5%, time ±1%, and matching line', () => {
  const a = { miles: 343, seconds: 20000, geometry: LINE };
  assert.equal(sameRoute(a, { miles: 344, seconds: 20100, geometry: LINE }), true);
  assert.equal(sameRoute(a, { miles: 346, seconds: 20000, geometry: LINE }), false, 'miles >0.5% apart');
  assert.equal(sameRoute(a, { miles: 343, seconds: 20300, geometry: LINE }), false, 'time >1% apart');
  assert.equal(sameRoute(a, { miles: 343, seconds: 20000, geometry: encodePolyline(SHORT) }), false, 'different road');
  assert.equal(sameRoute({ ...a, seconds: null }, { miles: 343, seconds: 20000, geometry: LINE }), true, 'unknown time skips the time check');
});
test('sameLine: ≥95% of sampled points within 0.25 mi counts as the same line', () => {
  const dense = []; for (let i = 0; i <= 100; i++) dense.push([34.9 - (1.5 * i) / 100, -117 + (4.8 * i) / 100]);
  const nudged = dense.map(([la, ln]) => [la + 0.001, ln]); // ~0.07 mi off
  assert.equal(sameLine(encodePolyline(dense), encodePolyline(nudged)), true);
  const far = dense.map(([la, ln], i) => [la + (i > 20 && i < 80 ? 0.2 : 0), ln]);
  assert.equal(sameLine(encodePolyline(dense), encodePolyline(far)), false);
});
test('mergeOptions: duplicates merge into one chip label and lend a drive time', () => {
  const m = mergeOptions([
    { id: 'fastest', miles: 343, seconds: null, geometry: LINE },
    { id: 'shortest', miles: 330, seconds: 21000, geometry: encodePolyline(SHORT) },
    { id: 'no_tolls', miles: 343, seconds: 20000, geometry: LINE },
  ]);
  assert.deepEqual(m.map((o) => o.label), ['Fastest · No tolls', 'Shortest']);
  assert.equal(m[0].seconds, 20000);
  assert.deepEqual(m[0].ids, ['fastest', 'no_tolls']);
});

// ---- server: compute, cache, limits ----
test('computeOptions: two parallel ORS calls (shortest + no tolls), fastest from the stored route, no truck dims, no writes', async () => {
  const db = mk(); const f = fakeOrs({ shortest: { miles: 330, seconds: 21000, line: SHORT }, no_tolls: { miles: 360, seconds: 22000, line: [[34.9, -117], [33.9, -115], [33.4, -112.2]] } });
  const r = await computeOptions(db, OWNER, L1, OWNER, opts({ fetchImpl: f }));
  assert.equal(r.state, 'ready'); assert.equal(r.default, 'fastest');
  assert.deepEqual(r.options.map((o) => o.id), ['fastest', 'shortest', 'no_tolls']);
  assert.equal(r.options[0].miles, 143); assert.equal(r.options[0].geometry, LINE);
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[0].preference, 'shortest');
  assert.deepEqual(f.calls[1].options, { avoid_features: ['tollways'] });
  for (const b of f.calls) { assert.equal(b.options?.profile_params, undefined); assert.equal(JSON.stringify(b).includes('restrictions'), false); }
  assert.equal(db.calls.some((c) => c.op !== 'select'), false, 'no database writes');
  assert.equal(JSON.stringify(r).includes('rate'), false, 'no rate in the reply');
});
test('all three the same → one option, only_one', async () => {
  const f = fakeOrs({ shortest: { miles: 143, seconds: 20000, line: FAST }, no_tolls: { miles: 143, seconds: 20000, line: FAST } });
  const r = await computeOptions(mk(), OWNER, L1, OWNER, opts({ fetchImpl: f }));
  assert.equal(r.options.length, 1); assert.equal(r.options[0].label, 'Fastest · Shortest · No tolls'); assert.equal(r.only_one, true);
  assert.equal(viewOfReply(r).text, OPTIONS_TEXT.onlyOne);
});
test('cache: a second open within 24 h makes no ORS call; a new stop address does', async () => {
  const state = newOptionsState(); const f = fakeOrs({ shortest: { miles: 330, seconds: 21000, line: SHORT }, no_tolls: { miles: 343, seconds: 20000, line: FAST } });
  await computeOptions(mk(), OWNER, L1, OWNER, opts({ fetchImpl: f, state }));
  await computeOptions(mk(), OWNER, L1, OWNER, opts({ fetchImpl: f, state }));
  assert.equal(f.calls.length, 2);
  const moved = { ...delivery, city: 'Tucson', zip: '85706', geocode_address: null };
  moved.geocode_address = stopAddressText(moved);
  const db = fakeSupabase({ tables: { company_profiles: [{ id: 'c', owner_id: OWNER }], loads: [{ ...load0, route_key: routeKey([pickup, moved]) }], stops: [{ ...pickup }, moved] }, user: { id: OWNER } });
  await computeOptions(db, OWNER, L1, OWNER, opts({ fetchImpl: f, state }));
  assert.equal(f.calls.length, 4);
});
test('cache expires after 24 h', () => {
  let t = 0; const c = createOptionsCache({ now: () => t }); c.set('k', { variants: {} });
  t = 23 * 3600e3; assert.ok(c.get('k')); t = 24 * 3600e3 + 1; assert.equal(c.get('k'), null);
});
test('partial failure: the other option still shows; the failed one is not asked again for 10 min', async () => {
  let t = Date.parse('2026-11-04T18:00:00Z'); const now = () => t; const state = newOptionsState({ now });
  const f = fakeOrs({ shortest: { status: 500 }, no_tolls: { miles: 360, seconds: 22000, line: SHORT } });
  const r = await computeOptions(mk(), OWNER, L1, OWNER, opts({ fetchImpl: f, state, now }));
  assert.deepEqual(r.options.map((o) => o.id), ['fastest', 'no_tolls']); assert.deepEqual(r.failed, [{ id: 'shortest', code: 'upstream' }]);
  assert.match(viewOfReply(r).partial, /Shortest isn’t available/);
  t += 5 * 60e3; await computeOptions(mk(), OWNER, L1, OWNER, opts({ fetchImpl: f, state, now })); assert.equal(f.calls.length, 2);
  t += 6 * 60e3; await computeOptions(mk(), OWNER, L1, OWNER, opts({ fetchImpl: f, state, now })); assert.equal(f.calls.length, 3, 'only the failed variant is retried');
});
test('limits: 10 computes a minute per instance → busy; per-user daily cap', async () => {
  assert.deepEqual(OPTIONS_LIMITS.options, { perMinute: 10, perDay: 300 });
  const state = newOptionsState(); const f = fakeOrs({ shortest: { miles: 330, seconds: 1, line: SHORT }, no_tolls: { miles: 360, seconds: 1, line: SHORT } });
  let last;
  for (let i = 0; i < 11; i++) {
    const s2 = { ...delivery, zip: String(85000 + i) }; s2.geocode_address = stopAddressText(s2);
    const db = fakeSupabase({ tables: { company_profiles: [{ id: 'c', owner_id: OWNER }], loads: [{ ...load0, route_key: routeKey([pickup, s2]) }], stops: [{ ...pickup }, s2] }, user: { id: OWNER } });
    last = await computeOptions(db, OWNER, L1, `u${i}`, opts({ fetchImpl: f, state }));
  }
  assert.equal(last.state, 'busy'); assert.equal(viewOfReply(last).kind, 'busy');
});
test('shared daily stop: fetchRoute refuses once the instance-wide counter is spent', async () => {
  const total = createLimiter({ all: { perMinute: 99, perDay: 1 } });
  const f = fakeOrs({ fastest: { miles: 1, seconds: 1, line: FAST } });
  const a = await fetchRoute([{ lat: 1, lng: 1 }, { lat: 2, lng: 2 }], { key: 'k', fetchImpl: f, take: () => true, total });
  const b = await fetchRoute([{ lat: 1, lng: 1 }, { lat: 2, lng: 2 }], { key: 'k', fetchImpl: f, take: () => true, total });
  assert.equal(a.miles, 1); assert.equal(b.error, 'rate_limited'); assert.equal(f.calls.length, 1);
  assert.match(read('app/lib/loadRouteServer.js'), /ORS_DAILY_STOP = 1900/);
});
test('no key → no_key (toggle hidden); stale route → not_ready; no ORS call', async () => {
  const f = fakeOrs({});
  assert.equal((await computeOptions(mk(), OWNER, L1, OWNER, opts({ fetchImpl: f, env: {} }))).state, 'no_key');
  assert.equal((await computeOptions(mk({ route_key: 'old' }), OWNER, L1, OWNER, opts({ fetchImpl: f }))).state, 'not_ready');
  assert.equal(f.calls.length, 0);
  assert.equal(viewOfReply({ state: 'no_key' }).kind, 'hidden');
});

// ---- API route: auth + access ----
const call = (db, extra = {}) => OPT.POST(new Request(`http://x/api/loads/${L1}/map/options`, { method: 'POST', headers: { authorization: 'Bearer t' } }),
  { params: { id: L1 }, deps: { mkUserClient: () => db, authRetryMs: 0, options: opts({ fetchImpl: fakeOrs({ shortest: { miles: 330, seconds: 1, line: SHORT }, no_tolls: { miles: 343, seconds: 1, line: FAST } }) }), ...extra } });
test('API: owner and the assigned driver see options; an unassigned driver gets 404; no token → 401', async () => {
  const own = await call(mk()); assert.equal(own.status, 200); assert.equal((await own.json()).state, 'ready');
  const dd = mk({}, DRIVER, 'driver'); const drv = await call(dd, { sb: dd }); assert.equal(drv.status, 200);
  const od = mk({}, OTHER, 'driver'); const oth = await call(od, { sb: od }); assert.equal(oth.status, 404);
  const anon = await OPT.POST(new Request(`http://x/api/loads/${L1}/map/options`, { method: 'POST' }), { params: { id: L1 }, deps: { mkUserClient: () => mk(), authRetryMs: 0 } });
  assert.equal(anon.status, 401);
});

// ---- UI logic + source checks ----
test('UI helpers: arrows wrap, chips show miles and time, map shows options only when there is a choice', () => {
  assert.equal(nextIndex(0, 'ArrowRight', 3), 1); assert.equal(nextIndex(2, 'ArrowRight', 3), 0); assert.equal(nextIndex(0, 'ArrowLeft', 3), 2); assert.equal(nextIndex(1, 'Tab', 3), 1);
  assert.equal(chipDetail({ miles: 1234, seconds: 3600 * 5 + 600 }), '1,234 mi · 5 h 10 m');
  assert.match(announceText({ label: 'Shortest', miles: 330, seconds: null }), /^Shortest selected, 330 mi\.$/);
  const o = [{ id: 'fastest', ids: ['fastest', 'no_tolls'], geometry: 'a' }, { id: 'shortest', ids: ['shortest'], geometry: 'b' }];
  assert.deepEqual(mapOptions(o, null).map((x) => x.selected), [true, false]);
  assert.deepEqual(mapOptions(o, o[1]).map((x) => x.selected), [false, true]);
  assert.equal(mapOptions([o[0]], null), null);
  assert.equal(viewOfReply(null, { online: false }).kind, 'offline'); assert.equal(viewOfReply(null).kind, 'loading');
  assert.equal(viewOfReply({ state: 'failed', message: 'x' }).kind, 'error');
  assert.deepEqual(VARIANTS.map((v) => v.id), ['fastest', 'shortest', 'no_tolls']);
});
test('UI source: lazy fetch, radio group a11y, 44px, CSS vars only, notes, no "Use these miles", Planned/ETA untouched', () => {
  const ro = read('app/components/RouteOptions.js');
  assert.match(ro, /role="radiogroup"/); assert.match(ro, /role="radio"/); assert.match(ro, /aria-checked=\{on\}/); assert.match(ro, /aria-live="polite"/); assert.match(ro, /'✓ '/);
  assert.match(ro, /minHeight: 44/); assert.match(ro, /if \(next && .*load\(\)/, 'fetch only when opened');
  assert.doesNotMatch(ro, /useEffect/, 'no fetch on mount');
  for (const f of ['app/components/RouteOptions.js', 'app/lib/routeOptions.js', 'app/lib/routeOptionsServer.js', 'app/api/loads/[id]/map/options/route.js']) {
    const src = read(f); assert.doesNotMatch(src, /#[0-9a-fA-F]{3,8}\b|rgba?\(/, `${f}: no hex/rgba`); assert.doesNotMatch(src, /Use these miles/);
    assert.doesNotMatch(src, /\.update\(|\.insert\(|\.upsert\(/, `${f}: no writes`);
  }
  assert.match(read('app/globals.css'), /ph-route-sel \{ stroke: var\(--primary\); \}/);
  const rm = read('app/components/RouteMap.js'); assert.match(rm, /className: 'ph-route-sel', weight: 5/); assert.match(rm, /className: 'ph-route-alt'/);
  assert.equal(OPTIONS_TEXT.hint, 'Navigation apps pick their own route.'); assert.equal(OPTIONS_TEXT.homeNote, 'ETA uses the fastest route.');
  const home = read('app/components/LoadMapPanel.js');
  assert.match(home, /homeNote testid="home-route-options"/);
  assert.match(home, /postEta\(\{ url: `\/api\/loads\/\$\{load\.id\}\/eta`/, 'ETA call unchanged');
  assert.doesNotMatch(home, /pick[^\n]*(total_miles|rate_per_mile|onRouteFilled)/);
  const card = read('app/components/LoadRouteCard.js');
  assert.doesNotMatch(card, /pick[^\n]*(total_miles|rate_per_mile|onRouteFilled|onLoadChange)/);
});

// ---- No tolls on long trips (ORS 2004 distance cap with avoid_features) ----
const quiet = (fn) => async () => { const orig = console.warn; const logs = []; console.warn = (...a) => logs.push(a); try { await fn(logs); } finally { console.warn = orig; } };
test('classify: 2004 is too_long only for route options; the stored route keeps no_route', () => {
  const r = { status: 404, body: { error: { code: 2004 } } };
  assert.equal(classifyOrsError(r), 'no_route');
  assert.equal(classifyOrsError(r, { keep2004: true }), 'too_long');
  assert.equal(classifyOrsError({ status: 404, body: { error: { code: 2009 } } }, { keep2004: true }), 'no_route');
  assert.equal(classifyOrsError({ timedOut: true }, { keep2004: true }), 'timeout');
});
test('long fake trip (Chicago → Pittsburgh, 460 mi): No tolls skipped with no ORS call; Shortest still asked; clear amber message', quiet(async (logs) => {
  assert.equal(NO_TOLLS_MAX_MILES, 150); assert.equal(OPTIONS_TIMEOUT_MS, 12000);
  const f = fakeOrs({ shortest: { miles: 455, seconds: 26000, line: SHORT } });
  const r = await computeOptions(mk({ calculated_miles: 460 }), OWNER, L1, OWNER, opts({ fetchImpl: f }));
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].preference, 'shortest'); assert.equal(f.calls[0].options, undefined);
  assert.deepEqual(r.options.map((o) => o.id), ['fastest', 'shortest']);
  assert.deepEqual(r.failed, [{ id: 'no_tolls', code: 'too_long' }]);
  assert.equal(viewOfReply(r).partial, 'No-toll routing isn’t available for trips this long.');
  assert.equal(logs.length, 0, 'a skip is not a failure to log');
}));
test('long trip with Shortest also cached: no ORS call at all', quiet(async () => {
  const state = newOptionsState(); const f = fakeOrs({ shortest: { miles: 455, seconds: 26000, line: SHORT } });
  await computeOptions(mk({ calculated_miles: 460 }), OWNER, L1, OWNER, opts({ fetchImpl: f, state }));
  const r = await computeOptions(mk({ calculated_miles: 460 }), OWNER, L1, OWNER, opts({ fetchImpl: f, state }));
  assert.equal(f.calls.length, 1); assert.equal(viewOfReply(r).partial, OPTIONS_TEXT.tooLong);
}));
test('short trip (fake Portland → Salem, 47 mi): No tolls asked and merged with Fastest', async () => {
  const f = fakeOrs({ shortest: { miles: 45, seconds: 3300, line: SHORT }, no_tolls: { miles: 47, seconds: 3000, line: FAST } });
  const r = await computeOptions(mk({ calculated_miles: 47 }), OWNER, L1, OWNER, opts({ fetchImpl: f }));
  assert.equal(f.calls.length, 2); assert.deepEqual(r.options.map((o) => o.label), ['Fastest · No tolls', 'Shortest']); assert.deepEqual(r.failed, []);
});
test('ORS 2004 under the threshold → too_long, cached until the stops change, logged with code/load/status only', quiet(async (logs) => {
  let t = Date.parse('2026-11-04T18:00:00Z'); const now = () => t; const state = newOptionsState({ now });
  const f = fakeOrs({ shortest: { miles: 140, seconds: 9000, line: SHORT }, no_tolls: { status: 404, code: 2004 } });
  const r = await computeOptions(mk(), OWNER, L1, OWNER, opts({ fetchImpl: f, state, now }));
  assert.deepEqual(r.failed, [{ id: 'no_tolls', code: 'too_long' }]); assert.equal(viewOfReply(r).partial, OPTIONS_TEXT.tooLong);
  assert.equal(logs.length, 1); assert.equal(logs[0][0], '[map options] variant failed');
  assert.deepEqual(JSON.parse(logs[0][1]), { variant: 'no_tolls', code: 'too_long', status: 404, load: L1 });
  const line = JSON.stringify(logs);
  for (const bad of [env.ORS_API_KEY, 'Barstow', 'Phoenix', 'Test Yard', '92311', '34.9']) assert.equal(line.includes(bad), false, bad);
  t += 3 * 3600e3; await computeOptions(mk(), OWNER, L1, OWNER, opts({ fetchImpl: f, state, now }));
  assert.equal(f.calls.length, 2, 'too_long is not asked again');
}));
test('message: other failures keep the generic text; both together read cleanly', () => {
  const v = viewOfReply({ state: 'ready', default: 'fastest', options: [{ id: 'fastest', ids: ['fastest'], label: 'Fastest', miles: 1, seconds: null, geometry: LINE }], failed: [{ id: 'shortest', code: 'upstream' }, { id: 'no_tolls', code: 'too_long' }], only_one: false });
  assert.equal(v.partial, 'Shortest isn’t available right now. No-toll routing isn’t available for trips this long.');
  const w = viewOfReply({ state: 'ready', default: 'fastest', options: [{ id: 'fastest', ids: ['fastest'], label: 'Fastest', miles: 1, seconds: null, geometry: LINE }], failed: [{ id: 'no_tolls', code: 'upstream' }], only_one: false });
  assert.match(w.partial, /No tolls isn’t available right now/);
  assert.match(read('app/components/RouteOptions.js'), /var\(--warning\)/);
});
