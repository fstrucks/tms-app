import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { isLoadId, buildNewLoad, createManualLoad, EMPTY_NEW_LOAD } from '../../app/lib/loadNew.js';

const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');
const good = { ...EMPTY_NEW_LOAD, broker_name: 'Sample Freight', broker_load_number: 'SFB-100300', rate: '$1,280',
  pu_city: 'Ontario', pu_state: 'ca', pu_zip: '91761', del_city: 'Phoenix', del_state: 'AZ', del_zip: '85043' };

test('/loads/new is its own static route, so [id] never receives "new"', () => {
  assert.ok(existsSync(new URL('../../app/loads/new/page.js', import.meta.url)));
  const src = read('app/loads/new/page.js');
  assert.match(src, /export default function NewLoadPage/);
  assert.doesNotMatch(src, /Loading load…/);
});

test('[id] rejects a non-UUID id before querying (no endless "Loading load…")', () => {
  const src = read('app/loads/[id]/page.js');
  const guard = src.indexOf('if (!isLoadId(id))');
  assert.ok(guard > 0, 'guard present');
  assert.ok(guard < src.indexOf(".from('loads').select('*, stops(*)')"), 'guard runs before the load query');
  assert.equal(isLoadId('new'), false);
  assert.equal(isLoadId(''), false);
  assert.equal(isLoadId(undefined), false);
  assert.equal(isLoadId('11b5baf7-7985-400f-92d5-71fd1f497101'), true);
});

test('/loads has a "+ New load" link to /loads/new', () => {
  assert.match(read('app/loads/page.js'), /href="\/loads\/new"[^>]*>\+ New load</);
});

test('buildNewLoad: required fields and friendly errors', () => {
  const r = buildNewLoad(EMPTY_NEW_LOAD, { userId: 'u1' });
  assert.equal(r.load, null);
  assert.deepEqual(Object.keys(r.errors).sort(), ['del_city', 'del_state', 'pu_city', 'pu_state', 'rate']);
  const bad = buildNewLoad({ ...good, rate: 'abc', miles: '-5', pu_state: 'Calif', del_zip: '850', weight: 'x' }, { userId: 'u1' });
  assert.deepEqual(Object.keys(bad.errors).sort(), ['del_zip', 'miles', 'pu_state', 'rate', 'weight']);
});

test('buildNewLoad: typed miles are marked typed; empty miles left for the route calculation', () => {
  const a = buildNewLoad({ ...good, miles: '327', weight: '38,500' }, { userId: 'u1', timezone: 'America/Los_Angeles' });
  assert.deepEqual(a.errors, {});
  assert.equal(a.load.user_id, 'u1');
  assert.equal(a.load.rate, 1280);
  assert.equal(a.load.total_miles, 327);
  assert.equal(a.load.miles_source, 'typed');
  assert.equal(a.load.weight, 38500);
  assert.equal(a.load.status, 'booked');
  assert.ok(!('rate_per_mile' in a.load), 'rate_per_mile is set by the DB trigger');
  assert.deepEqual(a.stops.map((s) => [s.stop_type, s.sequence, s.city, s.state, s.zip]), [['pickup', 1, 'Ontario', 'CA', '91761'], ['delivery', 2, 'Phoenix', 'AZ', '85043']]);
  const b = buildNewLoad(good, { userId: 'u1' });
  assert.ok(!('total_miles' in b.load) && !('miles_source' in b.load));
  assert.equal(b.stops[0].appointment_start, null);
  assert.equal(b.stops[0].timezone, null);
});

function fakeSb({ failLoad, failStops, missingMilesSource } = {}) {
  const calls = [];
  const sb = {
    from: (t) => ({
      insert: (rows) => {
        calls.push(['insert', t, rows]);
        if (t === 'loads') {
          const err = failLoad ? { message: 'boom' } : (missingMilesSource && 'miles_source' in rows ? { message: "Could not find the 'miles_source' column of 'loads'" } : null);
          return { select: () => ({ single: async () => (err ? { data: null, error: err } : { data: { id: 'L-new' }, error: null }) }) };
        }
        return Promise.resolve({ error: failStops ? { message: 'stops boom' } : null });
      },
      delete: () => ({ eq: async (c, v) => { calls.push(['delete', t, v]); return { error: null }; } }),
    }),
  };
  return { sb, calls };
}

test('createManualLoad: inserts load then both stops linked to it', async () => {
  const { sb, calls } = fakeSb();
  const r = await createManualLoad(sb, buildNewLoad({ ...good, miles: '327' }, { userId: 'u1' }));
  assert.deepEqual(r, { ok: true, id: 'L-new' });
  assert.deepEqual(calls.map((c) => c[1]), ['loads', 'stops']);
  assert.ok(calls[1][2].every((s) => s.load_id === 'L-new'));
});

test('createManualLoad: a stops failure removes the half-made load', async () => {
  const { sb, calls } = fakeSb({ failStops: true });
  const r = await createManualLoad(sb, buildNewLoad(good, { userId: 'u1' }));
  assert.equal(r.ok, false);
  assert.match(r.error, /not created/);
  assert.deepEqual(calls.at(-1), ['delete', 'loads', 'L-new']);
});

test('createManualLoad: load insert failure is reported, nothing else written', async () => {
  const { sb, calls } = fakeSb({ failLoad: true });
  const r = await createManualLoad(sb, buildNewLoad(good, { userId: 'u1' }));
  assert.equal(r.ok, false);
  assert.equal(calls.length, 1);
});

test('createManualLoad: tolerates a database without loads.miles_source', async () => {
  const { sb, calls } = fakeSb({ missingMilesSource: true });
  const r = await createManualLoad(sb, buildNewLoad({ ...good, miles: '327' }, { userId: 'u1' }));
  assert.equal(r.ok, true);
  assert.equal(calls.filter((c) => c[1] === 'loads').length, 2);
  assert.ok(!('miles_source' in calls[1][2]) && calls[1][2].total_miles === 327);
});
