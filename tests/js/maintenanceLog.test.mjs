// Truck maintenance log (migration 20261023000100): input rules, history shape, route behaviour. Fake TEST data only.
// RLS / triggers are covered against real Postgres in tests/sql/maintenance_log.pglite.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fakeSupabase } from './fakeSupabase.mjs';
import { SERVICE_TYPES, RECEIPT_TYPES, receiptType, receiptPath, visitInput, shapeHistory, canChangeVisit, typeLabel, BASELINE_LABEL } from '../../app/lib/maintenance.js';
import * as MAINT from '../../app/api/truck/maintenance/route.js';

const SQL = readFileSync(new URL('../../supabase/migrations/20261023000100_maintenance_log.sql', import.meta.url), 'utf8');
const OWNER = '00000000-0000-4000-8000-0000000000a1', DRV = '00000000-0000-4000-8000-0000000000a4';
const T1 = '00000000-0000-4000-8000-0000000000b1', L1 = '00000000-0000-4000-8000-0000000000c1';
const today = '2026-10-23';

test('service types: same list in the app and the SQL check constraint', () => {
  const m = SQL.match(/service_record_items_type_check check \(service_type in\s*\(([^)]*)\)/);
  const sqlTypes = m[1].match(/'([a-z_]+)'/g).map((x) => x.slice(1, -1));
  assert.deepEqual(sqlTypes, SERVICE_TYPES.map(([k]) => k));
  assert.equal(typeLabel({ service_type: 'other', service_label: 'Wipers' }), 'Wipers');
});

test('visit input: at least one item, item costs, total defaults to the item sum', () => {
  assert.match(visitInput({ serviceDate: today, items: [] }, { today }).error, /at least one/);
  const v = visitInput({ serviceDate: today, odometer: '412,300', vendor: ' TEST  Shop ', items: [{ serviceType: 'oil_filter', cost: '$120.50' }, { serviceType: 'grease', cost: '30' }] }, { today });
  assert.equal(v.visit.total_cost, 150.5); assert.equal(v.visit.odometer, 412300); assert.equal(v.visit.vendor_name, 'TEST Shop');
  assert.equal(v.visit.add_to_expenses, true); assert.equal(v.items.length, 2);
  assert.equal(visitInput({ serviceDate: today, totalCost: '400', items: [{ serviceType: 'tires' }] }, { today }).visit.total_cost, 400);
  assert.match(visitInput({ serviceDate: today, items: [{ serviceType: 'oil' }] }, { today }).error, /from the list/);
  assert.match(visitInput({ serviceDate: today, items: [{ serviceType: 'other' }] }, { today }).error, /Other/);
  assert.match(visitInput({ serviceDate: '2026-12-01', items: [{ serviceType: 'tires' }] }, { today }).error, /future/);
  assert.match(visitInput({ serviceDate: today, totalCost: '-5', items: [{ serviceType: 'tires' }] }, { today }).error, /dollar/);
});

test('load only goes with an expense; baseline: owner only, never an expense', () => {
  const off = visitInput({ serviceDate: today, addToExpenses: false, loadId: L1, items: [{ serviceType: 'brakes' }] }, { today });
  assert.equal(off.visit.load_id, null);
  assert.equal(visitInput({ serviceDate: today, loadId: L1, items: [{ serviceType: 'brakes' }] }, { today }).visit.load_id, L1);
  const b = visitInput({ serviceDate: today, entrySource: 'baseline', totalCost: '99', loadId: L1, items: [{ serviceType: 'coolant' }] }, { today, role: 'owner' });
  assert.equal(b.visit.entry_source, 'baseline'); assert.equal(b.visit.add_to_expenses, false); assert.equal(b.visit.load_id, null);
  assert.match(visitInput({ serviceDate: today, entrySource: 'baseline', items: [{ serviceType: 'coolant' }] }, { today, role: 'management' }).error, /owner/);
});

test('history: newest first, items grouped, baseline flagged; driver 24 h edit window', () => {
  const h = shapeHistory(
    [{ id: 'a', service_date: '2026-09-01', created_at: '1' }, { id: 'b', service_date: '2026-10-01', created_at: '2', entry_source: 'baseline' }],
    [{ service_record_id: 'a', service_type: 'grease' }, { service_record_id: 'a', service_type: 'oil_filter' }],
    [{ id: 'd', service_record_id: 'a' }]);
  assert.deepEqual(h.map((x) => x.id), ['b', 'a']);
  assert.equal(h[0].baseline, true); assert.equal(BASELINE_LABEL, 'Starting point (entered by owner)');
  assert.deepEqual(h[1].items.map((i) => i.service_type), ['oil_filter', 'grease']); assert.equal(h[1].receipts.length, 1);
  const now = Date.parse('2026-10-23T12:00:00Z');
  assert.equal(canChangeVisit('driver', DRV, { created_by: DRV, created_at: '2026-10-23T00:00:00Z' }, now), true);
  assert.equal(canChangeVisit('driver', DRV, { created_by: DRV, created_at: '2026-10-22T11:00:00Z' }, now), false);
  assert.equal(canChangeVisit('driver', DRV, { created_by: OWNER, created_at: '2026-10-23T11:00:00Z' }, now), false);
  assert.equal(canChangeVisit('dispatcher', DRV, { created_by: DRV, created_at: '2026-10-23T11:00:00Z' }, now), false);
  assert.equal(canChangeVisit('management', DRV, { created_by: OWNER, created_at: '2020-01-01' }, now), true);
});

function ctx(role, userId, { missing = false, drives = true } = {}) {
  const tables = { company_profiles: [{ id: 'p1', owner_id: OWNER }], trucks: [{ id: T1, user_id: OWNER, odometer: 1000, odometer_updated_at: '2026-10-20T00:00:00Z' }],
    service_records: [], service_record_items: [], documents: [] };
  const uc = fakeSupabase({ tables, user: { id: userId }, role, missing: missing ? ['service_records'] : [] });
  const calls = [];
  uc.rpc = async (fn, a) => {
    calls.push([fn, a]);
    if (fn === 'packet_role') return { data: a?.p_owner === OWNER ? role : null, error: null };
    if (fn === 'maint_load_choices') return { data: [{ id: L1, status: 'in_transit', truck_id: T1 }], error: null };
    if (fn === 'maint_drives_truck') return { data: drives, error: null };
    if (fn === 'set_truck_odometer') return { data: '2026-10-23T15:00:00Z', error: null };
    return { data: null, error: null };
  };
  return { uc, calls, deps: { mkUserClient: () => uc, sb: uc } };
}
const rq = (method, body, q = '') => new Request(`http://x/api/truck/maintenance${q}`, { method, headers: { authorization: 'Bearer t', 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
const call = async (c, m, body, q) => { const r = await MAINT[m](rq(m, body, q), { deps: c.deps }); return { status: r.status, j: await r.json() }; };

test('route: section hidden (available:false) when the migration is not applied', async () => {
  const c = ctx('owner', OWNER, { missing: true });
  const r = await call(c, 'GET', null, `?truckId=${T1}`);
  assert.equal(r.status, 200); assert.equal(r.j.available, false);
});

test('route: owner logs a visit with items through his own token; picker comes from the RPC', async () => {
  const c = ctx('owner', OWNER);
  const r = await call(c, 'POST', { action: 'create', truckId: T1, values: { serviceDate: '2026-10-20', totalCost: '150', loadId: L1, items: [{ serviceType: 'oil_filter' }, { serviceType: 'grease' }] } });
  assert.equal(r.status, 200, JSON.stringify(r.j));
  assert.equal(c.uc.db.service_records.length, 1);
  const rec = c.uc.db.service_records[0];
  assert.equal(rec.load_id, L1); assert.equal(rec.add_to_expenses, true); assert.equal(rec.expense_id, undefined, 'expense is the trigger’s job, never sent');
  assert.equal(c.uc.db.service_record_items.length, 2);
  const g = await call(c, 'GET', null, `?truckId=${T1}`);
  assert.equal(g.j.available, true); assert.equal(g.j.visits[0].items.length, 2); assert.equal(g.j.loads[0].id, L1);
  assert.equal(g.j.odometer, 1000); assert.ok(g.j.canSetOdometer);
  assert.ok(c.calls.some(([fn, a]) => fn === 'maint_load_choices' && a.p_truck === T1));
});

test('route: dispatcher read only; driver cannot set odometer; owner can', async () => {
  const p = ctx('dispatcher', DRV);
  assert.equal((await call(p, 'POST', { action: 'create', truckId: T1, values: { serviceDate: '2026-10-20', items: [{ serviceType: 'tires' }] } })).status, 403);
  const pg = await call(p, 'GET', null, `?truckId=${T1}`);
  assert.equal(pg.j.canLog, false); assert.deepEqual(pg.j.loads, []);
  const d = ctx('driver', DRV);
  assert.equal((await call(d, 'POST', { action: 'set_odometer', truckId: T1, odometer: 5 })).status, 403);
  assert.equal((await call(d, 'POST', { action: 'create', truckId: T1, values: { serviceDate: '2026-10-20', entrySource: 'baseline', items: [{ serviceType: 'tires' }] } })).status, 422);
  const o = ctx('owner', OWNER);
  const r = await call(o, 'POST', { action: 'set_odometer', truckId: T1, odometer: '120,000' });
  assert.equal(r.status, 200); assert.equal(r.j.odometer, 120000);
});

test('migration: idempotent shape, grants to authenticated only, definer helpers pin search_path', () => {
  assert.doesNotMatch(SQL, /create table public\./i);
  for (const fn of SQL.matchAll(/create or replace function (public\.\w+)[\s\S]*?security definer([^\n]*)/g)) assert.match(fn[2], /set search_path = public/, fn[1]);
  assert.doesNotMatch(SQL, /grant [^;]* to anon/i);
  assert.match(SQL, /add_to_expenses boolean not null default true/);
  assert.match(SQL, /entry_source text not null default 'logged' check \(entry_source in \('logged', 'baseline'\)\)/);
  assert.match(SQL, /load_id uuid references public\.loads\(id\) on delete set null/);
});

// ---- QA fixes (migration 20261023000200) ----
const FIX = readFileSync(new URL('../../supabase/migrations/20261023000200_maintenance_log_fix.sql', import.meta.url), 'utf8');

test('item costs can’t exceed the visit total (app side)', () => {
  const v = (total, costs) => visitInput({ serviceDate: '2026-10-20', totalCost: total, items: costs.map((c, i) => ({ serviceType: SERVICE_TYPES[i][0], cost: c })) }, { today });
  assert.match(v('100', ['150']).error, /more than the whole visit/);
  assert.match(v('100', ['60', '50']).error, /add up to more than the total/);
  assert.ok(!v('100', ['60', '40']).error);
  assert.ok(!v('', ['60', '50']).error, 'blank total = item sum');
  assert.equal(v('', ['60', '50']).visit.total_cost, 110);
});

test('blank miles saves no odometer; blank manual odometer is refused, never 0', async () => {
  const r = visitInput({ serviceDate: '2026-10-20', odometer: '', items: [{ serviceType: 'tires' }] }, { today });
  assert.equal(r.visit.odometer, null);
  const o = ctx('owner', OWNER);
  const b = await call(o, 'POST', { action: 'set_odometer', truckId: T1, odometer: '' });
  assert.equal(b.status, 422); assert.match(b.j.error, /Enter the miles/);
  assert.ok(!o.calls.some(([fn]) => fn === 'set_truck_odometer'));
});

test('driver without access: no Log service, no picker, no edit buttons', async () => {
  const d = ctx('driver', DRV, { drives: false });
  const g = await call(d, 'GET', null, `?truckId=${T1}`);
  assert.equal(g.j.canLog, false); assert.deepEqual(g.j.loads, []);
  const ok = await call(ctx('driver', DRV), 'GET', null, `?truckId=${T1}`);
  assert.equal(ok.j.canLog, true); assert.equal(ok.j.loads.length, 1);
});

test('receipts: types match the bucket, path is the uploader’s folder and unique', () => {
  assert.deepEqual(RECEIPT_TYPES, ['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']);
  assert.equal(receiptType({ type: 'image/jpeg', name: 'a.jpg' }), 'image/jpeg');
  assert.equal(receiptType({ type: '', name: 'IMG_1.HEIC' }), 'image/heic');
  assert.equal(receiptType({ type: 'image/gif', name: 'a.gif' }), null);
  const a = receiptPath(DRV, 'my receipt.jpg'), b = receiptPath(DRV, 'my receipt.jpg');
  assert.ok(a.startsWith(`${DRV}/`)); assert.notEqual(a, b); assert.match(a, /my_receipt\.jpg$/);
  const ui = readFileSync(new URL('../../app/truck/MaintenanceSection.js', import.meta.url), 'utf8');
  assert.match(ui, /user_id: user\.id, doc_type: 'maintenance_receipt'/); assert.doesNotMatch(ui, /load_id: /);
});

test('fix migration: ASCII, receipt column grant, picker + driver rule, cost triggers', () => {
  assert.ok(!/[^\x00-\x7F]/.test(FIX));
  assert.match(FIX, /grant insert \(service_record_id\) on public\.documents to authenticated/);
  assert.match(FIX, /concat_ws\(' - '/);
  assert.match(FIX, /maint_load_ok_for\(new\.truck_id, new\.load_id\)/);
  assert.match(FIX, /l\.truck_id is null\s+and l\.assigned_driver_user_id = auth\.uid\(\)/);
  for (const t of ['service_record_items_cost_check', 'service_records_cost_check']) assert.match(FIX, new RegExp(`drop trigger if exists ${t}`));
  assert.equal((FIX.match(/security definer set search_path = public/g) || []).length, (FIX.match(/security definer/g) || []).length);
});
