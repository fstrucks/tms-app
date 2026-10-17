import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fakeSupabase } from './fakeSupabase.mjs';
import { fillLinkedLoadWeight } from '../../app/lib/loadWeightFill.js';
import { weightChecks } from '../../app/lib/truckFields.js';
import * as LT from '../../app/api/loads/[id]/scale-tickets/route.js';

const OWNER = '00000000-0000-4000-8000-00000000aaaa', OTHER = '00000000-0000-4000-8000-00000000cccc';
const DISPATCH = '00000000-0000-4000-8000-00000000dddd', DRIVER = '00000000-0000-4000-8000-00000000bbbb';
const L1 = '00000000-0000-4000-8000-0000000000c1', L2 = '00000000-0000-4000-8000-0000000000c2', LX = '00000000-0000-4000-8000-0000000009c1';
const T1 = '00000000-0000-4000-8000-0000000000a1', TR1 = '00000000-0000-4000-8000-0000000000b1', TX = '00000000-0000-4000-8000-0000000009a1';

// ---------- 1. re-extraction fills the linked load's weight ----------
test('1: empty load weight gets filled from the re-extracted rate con', async () => {
  const db = fakeSupabase({ tables: { loads: [{ id: L1, user_id: OWNER, weight: null }] } });
  const r = await fillLinkedLoadWeight(db, { loadId: L1, userId: OWNER, weight: 38500 });
  assert.deepEqual(r, { filled: true, weight: 38500 });
  assert.equal(db.db.loads[0].weight, 38500);
});

test('1: an existing weight (typed or copied) is kept, never overwritten', async () => {
  for (const kept of [41000, 1]) {
    const db = fakeSupabase({ tables: { loads: [{ id: L1, user_id: OWNER, weight: kept }] } });
    const r = await fillLinkedLoadWeight(db, { loadId: L1, userId: OWNER, weight: '38,500 lbs' });
    assert.equal(r.filled, false); assert.equal(r.skipped, 'kept_existing');
    assert.equal(db.db.loads[0].weight, kept);
  }
});

test('1: matched by the rate con link (documents.load_id) and the caller only; nothing else changes', async () => {
  const db = fakeSupabase({ tables: { loads: [{ id: L1, user_id: OWNER, weight: null }, { id: L2, user_id: OWNER, weight: null }, { id: LX, user_id: OTHER, weight: null }] } });
  await fillLinkedLoadWeight(db, { loadId: L2, userId: OWNER, weight: 38500 });
  assert.deepEqual(db.db.loads.map((l) => l.weight), [null, 38500, null]);
  assert.equal((await fillLinkedLoadWeight(db, { loadId: LX, userId: OWNER, weight: 38500 })).filled, false); // another owner's load
  assert.equal(db.db.loads[2].weight, null);
  assert.equal((await fillLinkedLoadWeight(db, { loadId: null, userId: OWNER, weight: 38500 })).skipped, 'no_linked_load');
  assert.equal((await fillLinkedLoadWeight(db, { loadId: L1, userId: OWNER, weight: null })).skipped, 'no_weight');
  const q = db.calls.find((c) => c.op === 'update');
  assert.deepEqual(q.eqs, [['id', L2], ['user_id', OWNER], ['is:weight', null]]);
});

test('1: the extract route reads documents.load_id and fills only an empty weight after a (re-)run', () => {
  const src = readFileSync(new URL('../../app/api/extract/route.js', import.meta.url), 'utf8');
  assert.match(src, /select\('id, user_id, doc_type, file_path, original_filename, ai_extracted_data, load_id'\)/);
  assert.match(src, /fillLinkedLoadWeight\(userDb, \{ loadId: doc\.load_id, userId: user\.id, weight: extracted\.weight_lb \}\)/);
  assert.ok(src.indexOf('fillLinkedLoadWeight(userDb') > src.indexOf("update({ ai_extracted_data: extracted })"), 'runs after the extraction is saved');
});

// ---------- 2. load page tickets ----------
const seed = () => ({
  company_profiles: [{ id: 'p1', owner_id: OWNER }],
  loads: [{ id: L1, user_id: OWNER, broker_load_number: 'SFB-100245', weight: 38500 }, { id: LX, user_id: OTHER, broker_load_number: 'OTHER', weight: 1000 }],
  trucks: [{ id: T1, user_id: OWNER, unit_number: '104', empty_weight_lb: 19850, current_trailer_id: TR1 }, { id: TX, user_id: OTHER, unit_number: 'X', empty_weight_lb: 1 }],
  trailers: [{ id: TR1, user_id: OWNER, unit_number: 'T-22', empty_weight_lb: 14600 }],
  scale_tickets: [
    { id: 'k1', user_id: OWNER, truck_id: T1, trailer_id: TR1, load_id: L1, ticket_date: '2026-10-17', gross_weight_lb: 81240, steer_axle_lb: 12340, drive_axle_lb: 33800, trailer_axle_lb: 35100, confirmed: true, created_at: '2026-10-17T18:00:00Z' },
    { id: 'k2', user_id: OWNER, truck_id: T1, trailer_id: TR1, load_id: null, ticket_date: '2026-10-16', gross_weight_lb: 70000, confirmed: true, created_at: '2026-10-16T18:00:00Z' },
    { id: 'kx', user_id: OTHER, truck_id: TX, load_id: L1, ticket_date: '2026-10-17', gross_weight_lb: 99999, confirmed: true, created_at: '2026-10-17T18:00:00Z' }],
});
const req = () => new Request(`http://x/api/loads/${L1}/scale-tickets`, { headers: { authorization: 'Bearer t' } });
function ctx(role, userId) {
  const data = fakeSupabase({ tables: seed(), user: { id: userId }, role });
  if (userId === OWNER) return { data, deps: { mkUserClient: () => data } };
  const uc = fakeSupabase({ tables: { company_profiles: [{ id: 'p1', owner_id: OWNER }] }, user: { id: userId }, role });
  return { data, uc, deps: { mkUserClient: () => uc, sb: data } };
}

test('2: load page tickets use the shared weightChecks with the load weight (no duplicated logic)', async () => {
  const { deps } = ctx('owner', OWNER);
  const r = await LT.GET(req(), { params: { id: L1 }, deps });
  const j = await r.json();
  assert.equal(r.status, 200);
  assert.deepEqual(j.tickets.map((t) => t.id), ['k1']); // only this load's tickets, only the owner's
  const t = j.tickets[0];
  const expected = weightChecks({ ticket: seed().scale_tickets[0], truckEmpty: 19850, trailerEmpty: 14600, loadWeight: 38500 });
  assert.equal(t.net, expected.net); assert.deepEqual(t.warnings, expected.warnings);
  assert.deepEqual(t.warnings.map((w) => w.code), ['gross_over', 'steer_axle_over', 'trailer_axle_over', 'load_mismatch']);
  assert.match(t.warnings.at(-1).text, /rate con weight \(38,500 lb\)/);
  assert.equal(t.truck_number, '104'); assert.equal(j.loadWeight, 38500); assert.equal(j.canEdit, true);
  const comp = readFileSync(new URL('../../app/components/LoadScaleTickets.js', import.meta.url), 'utf8');
  assert.doesNotMatch(comp, /80000|12000|34000|weightChecks|LOAD_DIFF/); // UI renders server results only
  assert.match(readFileSync(new URL('../../app/loads/[id]/page.js', import.meta.url), 'utf8'), /<LoadScaleTickets supabase=\{supabase\} loadId=\{load\.id\} loadWeight=\{load\.weight\}/);
});

test('2: no load weight → no rate con check (other warnings still show)', async () => {
  const tables = seed(); tables.loads[0].weight = null;
  const data = fakeSupabase({ tables, user: { id: OWNER }, role: 'owner' });
  const j = await (await LT.GET(req(), { params: { id: L1 }, deps: { mkUserClient: () => data } })).json();
  assert.ok(!j.tickets[0].warnings.some((w) => w.code === 'load_mismatch'));
  assert.ok(j.tickets[0].warnings.some((w) => w.code === 'gross_over'));
});

test('2: dispatcher and driver (service key) are scoped to the owner; driver is read-only; foreign load → 404', async () => {
  for (const [role, uid, canEdit] of [['dispatcher', DISPATCH, true], ['driver', DRIVER, false]]) {
    const { data, uc, deps } = ctx(role, uid);
    const j = await (await LT.GET(req(), { params: { id: L1 }, deps })).json();
    assert.deepEqual(j.tickets.map((t) => t.id), ['k1']); assert.equal(j.canEdit, canEdit);
    for (const c of data.calls.filter((c) => ['loads', 'scale_tickets', 'trucks', 'trailers'].includes(c.t))) {
      assert.ok(c.eqs.some(([k, v]) => k === 'user_id' && v === OWNER), `${c.t} scoped to owner`);
      assert.equal(c.op, 'select', 'read-only endpoint');
    }
    assert.deepEqual([...new Set(uc.calls.map((c) => c.t))], ['company_profiles']);
    assert.equal((await LT.GET(req(), { params: { id: LX }, deps })).status, 404);
  }
  assert.equal(typeof LT.POST, 'undefined'); // nothing to write from the load page
});

test('2: migration missing → empty list, no crash', async () => {
  const data = fakeSupabase({ tables: seed(), user: { id: OWNER }, role: 'owner', missing: ['scale_tickets'] });
  const j = await (await LT.GET(req(), { params: { id: L1 }, deps: { mkUserClient: () => data } })).json();
  assert.equal(j.setupNeeded, true); assert.deepEqual(j.tickets, []);
});
