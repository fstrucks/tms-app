// "Rescan rate con" (Nov 2): fills only empty fields, preview first, save re-plans. Fake fixture only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeRateConStops } from '../../app/lib/rateconStops.js';
import { rescanScan, cleanScan, planRescan, rescanUpdates, streetIsFillable, notesWithPickup, splitAddress } from '../../app/lib/rateconRescan.js';
import { POST } from '../../app/api/loads/[id]/rescan-ratecon/route.js';

const fixture = () => JSON.parse(readFileSync(new URL('../fixtures/ratecon/uber-freight-fake.json', import.meta.url), 'utf8'));
const src = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const scanOf = (f) => { const { document_kind, heading_text, _comment, _rescan_load, ...d } = f; return rescanScan(normalizeRateConStops(d)); };
const LOAD = () => fixture()._rescan_load;
const PU = '00000000-0000-4000-8000-0000000000c1';
const DL = '00000000-0000-4000-8000-0000000000d2';
const by = (cs) => Object.fromEntries(cs.map((c) => [c.key, c.to]));

test('fake Uber Freight rescan: fills city-only street, empty zip/state, pickup # and the PU# ref only', () => {
  const ch = by(planRescan(LOAD(), scanOf(fixture())));
  assert.deepEqual(ch, {
    [`${PU}:address_line1`]: '100 Example Industrial Way',
    [`${PU}:zip`]: '98660',
    [`${PU}:pickup_number`]: '88123',
    [`${DL}:state`]: 'PA',
    [`${DL}:zip`]: '17331',
    notes: 'Driver: call ahead (FAKE)\nRefs: PO 55-TEST, PU# 88123',
  });
});

test('never overwrites: a typed street, a street-bearing value, filled city/state/zip or pickup #', () => {
  const l = LOAD();
  l.stops[0] = { ...l.stops[0], address_line1: '9 Other St', zip: '11111', pickup_number: 'TYPED-1' };
  l.stops[1] = { ...l.stops[1], state: 'MD', zip: '21000' };
  l.notes = 'PU 88123 confirmed';
  const cs = planRescan(l, scanOf(fixture()));
  assert.deepEqual(cs, []);
});

test('street fillable only when empty or just the city', () => {
  assert.equal(streetIsFillable({ address_line1: '', city: 'X' }), true);
  assert.equal(streetIsFillable({ address_line1: 'Vancouver', city: 'Vancouver' }), true);
  assert.equal(streetIsFillable({ address_line1: 'vancouver, wa 98660', city: 'Vancouver', state: 'WA' }), true);
  assert.equal(streetIsFillable({ address_line1: '100 Main St', city: 'Vancouver' }), false);
  assert.equal(streetIsFillable({ address_line1: 'Gate 4', city: 'Vancouver' }), false);
  assert.equal(streetIsFillable({ address_line1: 'Main Warehouse', city: 'Vancouver' }), false);
});

test('a scan without a street never fills the street; bad state/zip ignored', () => {
  const s = cleanScan({ pickup: { street: 'Vancouver', city: 'Vancouver', state: 'Washington', zip: '9866' }, pickup_number: '' });
  assert.deepEqual(s.pickup, { street: '', city: 'Vancouver', state: '', zip: '' });
  assert.deepEqual(planRescan(LOAD(), s), []);
  assert.deepEqual(splitAddress('1 A St, Town, wa 12345'), { street: '1 A St', city: 'Town', state: 'WA', zip: '12345' });
});

test('notes: PU# only when absent; new Refs line when none', () => {
  assert.equal(notesWithPickup(null, '88123'), 'Refs: PU# 88123');
  assert.equal(notesWithPickup('call first', '88123'), 'call first\nRefs: PU# 88123');
  assert.equal(notesWithPickup('Refs: PU# 88123', '88123'), null);
  assert.equal(notesWithPickup('ref 188123', '88123'), 'ref 188123\nRefs: PU# 88123');
});

test('only accepted keys are saved', () => {
  const cs = planRescan(LOAD(), scanOf(fixture()));
  const u = rescanUpdates(cs, [`${PU}:zip`, 'notes']);
  assert.deepEqual(u.stops, { [PU]: { zip: '98660' } });
  assert.ok(u.notes);
});

// ---- route with fake clients ----
function fakeDb(state, calls) {
  const q = (table) => {
    const f = { table, filters: [], op: 'select' };
    const api = {
      select() { return api; }, order() { return api; }, limit() { return api; },
      eq(k, v) { f.filters.push([k, v]); return api; }, is(k, v) { f.filters.push([k, v]); return api; },
      update(p) { f.op = 'update'; f.patch = p; return api; },
      maybeSingle() { return Promise.resolve({ data: table === 'loads' ? state.load : null, error: null }); },
      then(res) {
        if (f.op === 'update') { calls.push(f); return Promise.resolve({ error: null }).then(res); }
        if (table === 'documents') return Promise.resolve({ data: state.docs, error: null }).then(res);
        return Promise.resolve({ data: null, error: null }).then(res);
      },
    };
    return api;
  };
  return {
    from: q,
    auth: { getUser: async () => ({ data: { user: state.user }, error: null }) },
    storage: { from: () => ({ download: async () => ({ data: new Blob([Buffer.from('fake')], { type: 'image/png' }), error: null }) }) },
    rpc: async (name) => { calls.push({ rpc: name }); return { data: state.slot, error: null }; },
  };
}
const req = (body) => new Request('http://x/api', { method: 'POST', headers: { authorization: 'Bearer fake', 'content-type': 'application/json' }, body: JSON.stringify(body) });

function setup(over = {}) {
  const load = LOAD();
  const state = { user: { id: load.user_id }, load, docs: [{ id: 'doc1', user_id: load.user_id, doc_type: 'rate_confirmation', file_path: `${load.user_id}/rc.png` }], slot: 'run1', ...over };
  const calls = [];
  const db = fakeDb(state, calls);
  let modelCalls = 0;
  const deps = { userDb: db, admin: db, apiKey: 'test', callModel: async () => { modelCalls++; return { ok: true, extracted: fixture() }; } };
  return { state, calls, deps, load, models: () => modelCalls };
}

test('preview: claims a scan slot, returns changes, writes nothing to the load', async () => {
  const t = setup();
  const r = await POST(req({ mode: 'preview' }), { params: { id: t.load.id }, deps: t.deps });
  const j = await r.json();
  assert.equal(r.status, 200);
  assert.equal(t.models(), 1);
  assert.ok(t.calls.some((c) => c.rpc === 'claim_extraction_slot'));
  assert.ok(!t.calls.some((c) => c.op === 'update' && (c.table === 'stops' || c.table === 'loads')));
  assert.equal(j.changes.length, 6);
});

test('preview: limit reached → 429; no rate con → 404; never scans', async () => {
  let t = setup({ slot: null });
  assert.equal((await POST(req({ mode: 'preview' }), { params: { id: t.load.id }, deps: t.deps })).status, 429);
  assert.equal(t.models(), 0);
  t = setup({ docs: [] });
  assert.equal((await POST(req({ mode: 'preview' }), { params: { id: t.load.id }, deps: t.deps })).status, 404);
  t = setup({ load: null });
  assert.equal((await POST(req({ mode: 'preview' }), { params: { id: '00000000-0000-4000-8000-0000000000a1' }, deps: t.deps })).status, 404);
});

test('apply: re-plans against current values, saves accepted keys only, no scan', async () => {
  const t = setup();
  const scan = scanOf(fixture());
  t.state.load.stops[0].zip = '99999'; // typed after the preview: kept
  const r = await POST(req({ mode: 'apply', scan, accept: [`${PU}:zip`, `${PU}:pickup_number`, 'notes'] }), { params: { id: t.load.id }, deps: t.deps });
  const j = await r.json();
  assert.equal(t.models(), 0);
  assert.deepEqual(j.applied.sort(), [`${PU}:pickup_number`, 'notes'].sort());
  assert.deepEqual(j.skipped, [`${PU}:zip`]);
  const stopUp = t.calls.filter((c) => c.table === 'stops');
  assert.deepEqual(stopUp.map((c) => c.patch), [{ pickup_number: '88123' }]);
});

test('component: preview + confirm, theme vars only, user-facing copy', () => {
  const s = src('../../app/components/RateConRescan.js');
  assert.match(s, /mode: 'preview'/);
  assert.match(s, /mode: 'apply'/);
  assert.match(s, /ratecon-rescan-save/);
  assert.doesNotMatch(s, /#[0-9a-f]{3,6}\b|rgba?\(/i);
  assert.doesNotMatch(s, /\b(AI|bot|GPT|OpenAI|model)\b/);
  const page = src('../../app/loads/[id]/page.js');
  assert.match(page, /<RateConRescan [^>]*owner=\{owner\}/);
});
