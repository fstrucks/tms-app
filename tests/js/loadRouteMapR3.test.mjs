// QA #83 r3: (1) an empty Planned falls back to saved values (rate con, else the cached route) without a recompute,
// also after clearing it on an open page; (2) the map frames the route + pins once it has a real size. Fake data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fakeSupabase } from './fakeSupabase.mjs';
import { routeKey, stopAddressText, fitTarget, FIT_PADDING, encodePolyline } from '../../app/lib/loadRoute.js';
import { getRoute, ensureRoute, fillEmptyPlanned } from '../../app/lib/loadRouteServer.js';
import * as MAP from '../../app/api/loads/[id]/map/route.js';

const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');
const OWNER = '00000000-0000-4000-8000-00000000aaaa', L1 = '00000000-0000-4000-8000-0000000000f1';
const env = { ORS_API_KEY: 'test-ors-key-not-real-0000' };
const g = (s, lat, lng) => ({ ...s, lat, lng, geocoded_at: '2026-10-18T20:00:00Z', geocode_address: stopAddressText(s), geocode_precision: 'city' });
const pickup = g({ id: 'p', load_id: L1, stop_type: 'pickup', sequence: 1, address_line1: '10 Test Yard Rd', city: 'Barstow', state: 'CA', zip: '92311' }, 34.9, -117.0);
const delivery = g({ id: 'd', load_id: L1, stop_type: 'delivery', sequence: 2, address_line1: '20 Sample Dock Ave', city: 'Phoenix', state: 'AZ', zip: '85043' }, 33.4, -112.2);
const KEY = routeKey([pickup, delivery]);
const LINE = encodePolyline([[34.9, -117.0], [34.2, -114.6], [33.4, -112.2]]);
const cached = { id: L1, user_id: OWNER, rate: 1000, total_miles: null, miles_source: null, rate_per_mile: null, calculated_miles: 343, route_key: KEY, route_geometry: LINE, route_computed_at: '2026-10-18T20:00:00Z', route_error: null };
const rcDoc = (miles) => ({ id: 'doc1', user_id: OWNER, load_id: L1, doc_type: 'rate_confirmation', ai_extracted_data: { total_miles: miles } });
const mk = (load = {}, docs = []) => fakeSupabase({ tables: { company_profiles: [{ id: 'c', owner_id: OWNER }], loads: [{ ...cached, ...load }], stops: [{ ...pickup }, { ...delivery }], documents: docs }, user: { id: OWNER } });
const noOrs = () => { throw new Error('ORS must not be called'); };

test('reload with empty Planned + cached route → Planned = calculated, saved, no ORS call (SFB-100272 case)', async () => {
  const db = mk();
  const r = await getRoute(db, OWNER, L1, { env });
  assert.deepEqual(r.view.plannedFilled, { miles: 343, source: 'calculated' });
  assert.equal(r.view.load.total_miles, 343); assert.equal(r.view.load.miles_source, 'calculated');
  assert.equal(db.db.loads[0].total_miles, 343); assert.equal(db.db.loads[0].miles_source, 'calculated');
  const upd = db.calls.find((c) => c.t === 'loads' && c.op === 'update');
  assert.deepEqual(upd.eqs, [['id', L1], ['user_id', OWNER], ['is:total_miles', null]], 'only while still empty');
  // Second load: nothing to fill, no write.
  const n = db.calls.filter((c) => c.op === 'update').length;
  assert.equal((await getRoute(db, OWNER, L1, { env })).view.plannedFilled, undefined);
  assert.equal(db.calls.filter((c) => c.op === 'update').length, n);
});

test('POST on a cached route fills too (0 ORS calls), and the API passes plannedFilled to the page', async () => {
  const db = mk();
  const r = await ensureRoute(db, OWNER, L1, { env, fetchImpl: noOrs, take: () => true });
  assert.equal(r.computed, false); assert.equal(r.view.plannedFilled.miles, 343);
  const db2 = mk();
  const j = await (await MAP.GET(new Request(`http://x/api/loads/${L1}/map`, { headers: { authorization: 'Bearer t' } }), { params: { id: L1 }, deps: { mkUserClient: () => db2, authRetryMs: 0, route: { env } } })).json();
  assert.deepEqual(j.plannedFilled, { miles: 343, source: 'calculated' }); assert.equal(j.load.total_miles, 343);
});

test('precedence: an empty Planned takes the rate con miles before the route (typed > rate con > calculated)', async () => {
  const db = mk({}, [rcDoc(320)]);
  const r = await getRoute(db, OWNER, L1, { env });
  assert.deepEqual(r.view.plannedFilled, { miles: 320, source: 'rate_con' });
  assert.equal(db.db.loads[0].total_miles, 320); assert.equal(db.db.loads[0].miles_source, 'rate_con');
  // Another owner's rate con is never read.
  const other = mk({}, [{ ...rcDoc(999), user_id: '00000000-0000-4000-8000-00000000cccc' }]);
  assert.equal((await getRoute(other, OWNER, L1, { env })).view.plannedFilled.miles, 343);
});

test('never overwrites typed or rate con miles; a value typed meanwhile wins (conditional update)', async () => {
  for (const [tm, src] of [[400, 'typed'], [320, 'rate_con']]) {
    const db = mk({ total_miles: tm, miles_source: src });
    await getRoute(db, OWNER, L1, { env });
    assert.equal(db.db.loads[0].total_miles, tm); assert.equal(db.db.loads[0].miles_source, src);
  }
  const db = mk({ total_miles: 400, miles_source: 'typed' });
  const r = await fillEmptyPlanned(db, OWNER, L1, { ...cached }, [pickup, delivery]); // page thought it was empty
  assert.equal(r.filled, null); assert.equal(db.db.loads[0].total_miles, 400); assert.equal(db.db.loads[0].miles_source, 'typed');
});

test('no fill from a route that is not current: addresses changed, a failed route, or no route yet', async () => {
  for (const load of [{ route_key: 'stale0000000000' }, { route_error: 'no_route' }, { route_error: 'upstream' }, { calculated_miles: null }]) {
    const db = mk(load);
    const r = await getRoute(db, OWNER, L1, { env });
    assert.equal(r.view.plannedFilled, undefined, JSON.stringify(load)); assert.equal(db.db.loads[0].total_miles, null);
  }
});

test('before the PR A migration (no miles_source) nothing is filled', async () => {
  const { miles_source, ...noSrc } = cached;
  const db = fakeSupabase({ tables: { loads: [noSrc], stops: [{ ...pickup }, { ...delivery }], documents: [] } });
  const r = await fillEmptyPlanned(db, OWNER, L1, noSrc, [pickup, delivery]);
  assert.equal(r.filled, null); assert.equal(db.calls.filter((c) => c.op === 'update').length, 0);
});

test('a fresh route computed for an empty Planned also respects rate con first', async () => {
  const fresh = { ...cached, calculated_miles: null, route_key: null, route_geometry: null, route_computed_at: null };
  const db = mk(fresh, [rcDoc(320)]);
  const ors = async () => ({ ok: true, status: 200, json: async () => ({ routes: [{ summary: { distance: 343.2 }, geometry: LINE }] }) });
  const r = await ensureRoute(db, OWNER, L1, { env, fetchImpl: ors, take: () => true });
  assert.equal(db.db.loads[0].calculated_miles, 343);
  assert.equal(db.db.loads[0].total_miles, 320); assert.equal(db.db.loads[0].miles_source, 'rate_con');
  assert.deepEqual(r.view.plannedFilled, { miles: 320, source: 'rate_con' });
});

test('clearing Planned on an open page asks the map card to re-check; a fill re-fetches the page', () => {
  const mileage = read('app/components/LoadMileage.js');
  assert.match(mileage, /if \(v == null && m\) onPlannedCleared\?\.\(\);/);
  const page = read('app/loads/[id]/page.js');
  assert.match(page, /onPlannedCleared=\{\(\) => setRouteCheck\(\(n\) => n \+ 1\)\}/);
  assert.match(page, /recheck=\{routeCheck\}/);
  const card = read('app/components/LoadRouteCard.js');
  assert.match(card, /\[loadId, stopsKey, recheck\]\)/);
  assert.match(card, /const filledNow = j\.plannedFilled \|\| first\.plannedFilled;/);
  assert.match(card, /filledNow \|\| \(steps/);
});

// ---------- (2) map framing ----------
test('fitTarget: bounds cover the route line and every pin; one point → point; none → none', () => {
  const pins = [[34.9, -117.0], [33.4, -112.2]];
  const line = [[35.6, -116.1], [33.1, -113.0]]; // the line bulges outside the pins
  assert.deepEqual(fitTarget([...pins, ...line]), { kind: 'bounds', bounds: [[33.1, -117.0], [35.6, -112.2]] });
  assert.deepEqual(fitTarget([[34.9, -117.0]]), { kind: 'point', point: [34.9, -117.0] });
  assert.deepEqual(fitTarget([[34.9, -117.0], [34.9, -117.0]]), { kind: 'point', point: [34.9, -117.0] });
  assert.deepEqual(fitTarget([]), { kind: 'none' }); assert.deepEqual(fitTarget([[NaN, 1], null]), { kind: 'none' });
  assert.ok(FIT_PADDING[0] >= 24 && FIT_PADDING[1] >= 24);
});

test('RouteMap frames only after the container has a size, and again on resize', () => {
  const src = read('app/components/RouteMap.js');
  assert.match(src, /if \(!m \|\| !node \|\| !node\.clientWidth \|\| !node\.clientHeight\) return false;/);
  assert.match(src, /m\.invalidateSize\(\{ animate: false \}\);/);
  assert.match(src, /m\.fitBounds\(b\.bounds, \{ padding: FIT_PADDING/);
  assert.match(src, /requestAnimationFrame\(fit\)/);
  assert.match(src, /new ResizeObserver\(\(\) => \{[\s\S]*?last = k; fit\(\);/);
  assert.ok(src.indexOf('bounds.push(...line)') < src.indexOf('const fit = '), 'line points are part of the bounds');
});
