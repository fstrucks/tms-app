// Maintenance schedules (migration 20261023000300): input helpers, labels, VIN decode, routes. Fake TEST data only.
// Status math, RLS and the seed run against real Postgres in tests/sql/maintenance_schedules.pglite.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fakeSupabase } from './fakeSupabase.mjs';
import { engineInput, checklistInput, orderBySchedule, intervalInput, decodeVin, sourceText, intervalText, dueText, VPIC_URL, patchRow, defaultToday, setupDefaults, withLiveCustom } from '../../app/lib/pmSchedule.js';
import { SERVICE_TYPES } from '../../app/lib/maintenance.js';
import * as SCHED from '../../app/api/truck/schedules/route.js';
import * as MAINT from '../../app/api/truck/maintenance/route.js';

const SQL = readFileSync(new URL('../../supabase/migrations/20261023000300_maintenance_schedules.sql', import.meta.url), 'utf8');
const OWNER = '00000000-0000-4000-8000-0000000000a1', MGR = '00000000-0000-4000-8000-0000000000a2', DRV = '00000000-0000-4000-8000-0000000000a4';
const T1 = '00000000-0000-4000-8000-0000000000b1', S1 = '00000000-0000-4000-8000-0000000000d1', TP = '00000000-0000-4000-8000-0000000000e1';
const ENGINES = [{ maker: 'Detroit', model: 'DD15' }, { maker: 'Cummins', model: 'X15' }, { maker: 'Mack', model: 'MP8 (EPA2010+)' }];
const today = '2026-10-23';

test('migration: ASCII, one seed block of 196 rows, idempotent DDL, no anon grants', () => {
  assert.ok(/^[\x00-\x7f]*$/.test(SQL));
  const seed = SQL.slice(SQL.indexOf('-- SEED BEGIN'), SQL.indexOf('-- SEED END'));
  assert.equal((seed.match(/^\s*\('/gm) || []).length, 196);
  assert.match(SQL, /on conflict \(seed_key\) do update/);
  assert.doesNotMatch(SQL, /grant [^;]* to anon/i);
  assert.doesNotMatch(SQL, /create table public\.(?!.*if not exists)/i);
  for (const fn of SQL.matchAll(/create or replace function (public\.\w+)[\s\S]*?security definer([^\n]*)/g)) assert.match(fn[2], /set search_path = public/, fn[1]);
});

test('engine input: listed engine or not sure; duty, year and mpg rules', () => {
  assert.deepEqual(engineInput({ engine: 'Detroit|DD15', dutyCycle: 'long_haul', engineYear: '2019', mpg: '7.25' }, ENGINES).patch,
    { engine_make: 'Detroit', engine_model: 'DD15', engine_year: 2019, duty_cycle: 'long_haul', mpg: 7.3 });
  assert.deepEqual(engineInput({ engine: 'not_sure' }, ENGINES).patch, { engine_make: null, engine_model: null, engine_year: null, duty_cycle: 'unknown', mpg: null });
  assert.match(engineInput({}, ENGINES).error, /engine/);
  assert.match(engineInput({ engine: 'Acme|Z9' }, ENGINES).error, /list/);
  assert.match(engineInput({ engine: 'not_sure', dutyCycle: 'racing' }, ENGINES).error, /used/);
  assert.match(engineInput({ engine: 'not_sure', engineYear: '19' }, ENGINES).error, /year/);
  assert.match(engineInput({ engine: 'not_sure', mpg: '40' }, ENGINES).error, /MPG/);
});

test('checklist: done+date → baseline grouped by date and miles; unknown date → unknown; unchecked → due', () => {
  const r = checklistInput([
    { serviceType: 'oil_filter', done: true, date: '2026-10-01', miles: '400,000' },
    { serviceType: 'fuel_filters', done: true, date: '2026-10-01', miles: '400000' },
    { serviceType: 'coolant', done: true, dateUnknown: true },
    { serviceType: 'air_filter', done: true, date: '2026-09-01', milesUnknown: true },
    { serviceType: 'differential', done: false },
  ], { role: 'owner', today, odometer: 410000 });
  assert.deepEqual(r.baseline, [{ service_date: '2026-10-01', odometer: 400000, items: ['oil_filter', 'fuel_filters'] }, { service_date: '2026-09-01', odometer: null, items: ['air_filter'] }]);
  assert.deepEqual(r.start, { coolant: 'unknown', differential: 'due' });
  const m = checklistInput([{ serviceType: 'oil_filter', done: true, date: '2026-10-01' }], { role: 'management', today });
  assert.deepEqual(m, { baseline: [], start: { oil_filter: 'unknown' } }); // only the owner records past service
  assert.match(checklistInput([{ serviceType: 'oil_filter', done: true, date: '2026-11-01' }], { today }).error, /future/);
  assert.match(checklistInput([{ serviceType: 'oil_filter', done: true, date: '' }], { today }).error, /date/);
  assert.match(checklistInput([{ serviceType: 'oil_filter', done: true, date: today, miles: '500000' }], { today, odometer: 1000 }).error, /more miles/);
  assert.match(checklistInput([{ serviceType: 'other', done: false }], { today }).error, /Unknown/);
});

test('Log service order: overdue, due, due soon, unknown, OK, then unscheduled; due ones marked', () => {
  const o = orderBySchedule(SERVICE_TYPES, [{ service_type: 'grease', status: 'ok' }, { service_type: 'coolant', status: 'due_soon' }, { service_type: 'brakes', status: 'overdue' }, { service_type: 'tires', status: 'unknown' }]);
  assert.deepEqual(o.slice(0, 5).map((x) => x.key), ['brakes', 'coolant', 'tires', 'grease', 'oil_filter']);
  assert.equal(o.length, SERVICE_TYPES.length);
  assert.deepEqual(o.filter((x) => x.isDue).map((x) => x.key), ['brakes', 'coolant']);
  assert.deepEqual(orderBySchedule(SERVICE_TYPES, []).map((x) => x.key), SERVICE_TYPES.map(([k]) => k));
});

test('labels: source text, intervals, due text', () => {
  assert.equal(sourceText({ source: 'suggested', source_title: 'TEST Maker Guide', as_of_date: '2026-01-15' }), 'Suggested from TEST Maker Guide, as of 01/15/2026');
  assert.equal(sourceText({ source: 'suggested', is_generic: true }), 'General estimate');
  assert.equal(sourceText({ source: 'custom', is_generic: true }), 'Custom interval');
  assert.equal(intervalText({ interval_miles: 50000, interval_days: 365 }), 'Every 50,000 mi or 1 yr, whichever first');
  assert.equal(intervalText({ interval_days: 90 }), 'Every 3 mo');
  assert.equal(dueText({ status: 'overdue', miles_left: -1200, days_left: 3 }), '1,200 mi over · 3 days left');
  assert.equal(dueText({ status: 'due' }), 'Not done yet');
  assert.deepEqual(intervalInput({ intervalMiles: '25,000', intervalDays: '' }), { interval_miles: 25000, interval_days: null });
  assert.match(intervalInput({}).error, /miles, days/);
  assert.match(intervalInput({ intervalDays: '9999' }).error, /Days/);
});

test('VIN decode: pre-fills year, make and a matching engine; bad answers are errors', () => {
  assert.equal(VPIC_URL('1XKYD49X0LJ000000'), 'https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVinValues/1XKYD49X0LJ000000?format=json');
  const d = decodeVin({ Results: [{ Make: 'KENWORTH', Model: 'T680', ModelYear: '2020', EngineManufacturer: 'Cummins', EngineModel: 'X15 Efficiency' }] }, ENGINES);
  assert.equal(d.year, 2020); assert.equal(d.make, 'KENWORTH'); assert.equal(d.engine, 'Cummins|X15');
  assert.equal(decodeVin({ Results: [{ Make: 'MACK', ModelYear: '2018', EngineManufacturer: 'Mack', EngineModel: 'MP8' }] }, ENGINES).engine, 'Mack|MP8 (EPA2010+)');
  assert.equal(decodeVin({ Results: [{ Make: 'X', ModelYear: '2018', EngineModel: 'Not Applicable' }] }, ENGINES).engine, null);
  assert.ok(decodeVin({ Results: [{ ErrorText: 'bad' }] }, ENGINES).error);
  assert.ok(decodeVin({}, ENGINES).error);
});

function ctx(role, userId, { missing = false, setupAt = null } = {}) {
  const tables = { company_profiles: [{ id: 'p1', owner_id: OWNER }], trucks: [{ id: T1, user_id: OWNER, unit_number: '7', odometer: 410000, maint_setup_at: setupAt }],
    service_records: [], service_record_items: [], pm_schedules: [{ id: S1, truck_id: T1, interval_miles: 25000, interval_days: null }],
    maintenance_interval_templates: [{ id: TP, source_title: 'TEST Guide', as_of_date: '2026-01-15', notes: null }] };
  const uc = fakeSupabase({ tables, user: { id: userId }, role });
  const calls = [];
  uc.rpc = async (fn, a) => {
    calls.push([fn, a]);
    if (missing && fn.startsWith('pm_')) return { data: null, error: { code: '42883', message: 'function public.pm_x does not exist' } };
    if (fn === 'packet_role') return { data: a?.p_owner === OWNER ? role : null, error: null };
    if (fn === 'pm_today') return { data: '2026-10-22', error: null };
    if (fn === 'pm_save_baseline') return role === 'owner' ? { data: a.p_groups.length, error: null } : { data: null, error: { code: '42501', message: 'not_allowed' } };
    if (fn === 'pm_engine_choices') return { data: ENGINES, error: null };
    if (fn === 'pm_suggest') return { data: [{ service_type: 'oil_filter', template_id: TP, interval_miles: 50000, interval_days: 365, is_generic: false }], error: null };
    if (fn === 'pm_setup_schedules') return role === 'owner' || role === 'management' ? { data: 8, error: null } : { data: null, error: { code: '42501', message: 'not_allowed' } };
    if (fn === 'pm_status_for') return { data: [{ schedule_id: S1, service_type: 'oil_filter', status: 'overdue', source: 'suggested', source_title: 'TEST Guide', as_of_date: '2026-01-15', is_generic: false, miles_left: -10, days_left: null }], error: null };
    if (fn === 'pm_due_list') return { data: [{ truck_id: T1, unit_number: '7', service_type: 'oil_filter', status: 'overdue' }], error: null };
    if (fn === 'set_truck_odometer') return { data: 'x', error: null };
    if (fn === 'maint_drives_truck') return { data: true, error: null };
    return { data: [], error: null };
  };
  return { uc, calls, db: uc._db || null, deps: { mkUserClient: () => uc, sb: uc } };
}
const rq = (path, method, body, q = '') => new Request(`http://x/api/truck/${path}${q}`, { method, headers: { authorization: 'Bearer t', 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
const call = async (c, m, body, q, extra = {}) => { const r = await SCHED[m](rq('schedules', m, body, q), { deps: c.deps, ...extra }); return { status: r.status, j: await r.json() }; };

test('schedules GET: status rows with source text; needsSetup; due list; hidden before the migration', async () => {
  const r = await call(ctx('owner', OWNER), 'GET', null, `?truckId=${T1}`);
  assert.equal(r.status, 200); assert.equal(r.j.needsSetup, true); assert.equal(r.j.canBaseline, true);
  assert.equal(r.j.schedule[0].sourceText, 'Suggested from TEST Guide, as of 01/15/2026'); assert.equal(r.j.schedule[0].label, 'Oil & filter');
  const due = await call(ctx('driver', DRV), 'GET', null, '?due=1');
  assert.equal(due.j.due[0].status, 'overdue');
  assert.equal((await call(ctx('owner', OWNER, { missing: true }), 'GET', null, `?truckId=${T1}`)).j.available, false);
  assert.deepEqual((await call(ctx('owner', OWNER, { missing: true }), 'GET', null, '?due=1')).j, { available: false, due: [] });
});

test('schedules POST: drivers and dispatch cannot change; preview shows source', async () => {
  for (const role of ['driver', 'dispatcher']) assert.equal((await call(ctx(role, DRV), 'POST', { action: 'preview', truckId: T1, values: { engine: 'not_sure' } })).status, 403);
  const p = await call(ctx('owner', OWNER), 'POST', { action: 'preview', truckId: T1, values: { engine: 'Detroit|DD15', dutyCycle: 'long_haul' } });
  assert.equal(p.status, 200); assert.equal(p.j.items[0].sourceText, 'Suggested from TEST Guide, as of 01/15/2026');
});

test('setup: owner saves engine, odometer, baseline via pm_save_baseline, schedules with start states', async () => {
  const c = ctx('owner', OWNER);
  const r = await call(c, 'POST', { action: 'setup', truckId: T1, values: { engine: 'Detroit|DD15', dutyCycle: 'long_haul', odometer: '412,000', items: [
    { serviceType: 'oil_filter', done: true, date: '2026-10-01', miles: '411000' }, { serviceType: 'coolant', done: true, dateUnknown: true }, { serviceType: 'grease', done: false }] } });
  assert.equal(r.status, 200, JSON.stringify(r.j)); assert.equal(r.j.visits, 1); assert.equal(r.j.schedules, 8);
  const bl = c.calls.filter(([f]) => f === 'pm_save_baseline');
  assert.equal(bl.length, 1); assert.deepEqual(bl[0][1], { p_truck: T1, p_groups: [{ service_date: '2026-10-01', odometer: 411000, items: ['oil_filter'] }] });
  assert.ok(c.calls.findIndex(([f]) => f === 'pm_save_baseline') < c.calls.findIndex(([f]) => f === 'pm_setup_schedules'), 'baseline saved before schedules');
  const odo = c.calls.find(([f]) => f === 'set_truck_odometer'); assert.equal(odo[1].p_odometer, 412000);
  const setup = c.calls.find(([f]) => f === 'pm_setup_schedules'); assert.deepEqual(setup[1].p_start, { coolant: 'unknown', grease: 'due' });
  const tr = await c.uc.from('trucks').select('*').eq('id', T1).maybeSingle();
  assert.equal(tr.data.engine_model, 'DD15'); assert.ok(tr.data.maint_setup_at);
  assert.equal((await c.uc.from('service_records').select('*')).data.length, 0, 'no direct inserts: the database function saves baseline visits');
});

test('setup: management gets schedules but no baseline visit', async () => {
  const c = ctx('management', MGR);
  const r = await call(c, 'POST', { action: 'setup', truckId: T1, values: { engine: 'not_sure', items: [{ serviceType: 'oil_filter', done: true, date: '2026-10-01' }] } });
  assert.equal(r.status, 200); assert.equal(r.j.visits, 0);
  assert.equal((await c.uc.from('service_records').select('*')).data.length, 0);
  assert.ok(!c.calls.some(([f]) => f === 'pm_save_baseline'));
  assert.deepEqual(c.calls.find(([f]) => f === 'pm_setup_schedules')[1].p_start, { oil_filter: 'unknown' });
});

test('save_schedule and decode_vin', async () => {
  const c = ctx('owner', OWNER);
  assert.equal((await call(c, 'POST', { action: 'save_schedule', truckId: T1, id: S1, values: { intervalMiles: '30000' } })).status, 200);
  assert.equal((await c.uc.from('pm_schedules').select('*').eq('id', S1).maybeSingle()).data.interval_miles, 30000);
  assert.equal((await call(c, 'POST', { action: 'save_schedule', truckId: T1, id: S1, values: {} })).status, 422);
  assert.equal((await call(c, 'POST', { action: 'decode_vin', vin: 'short' })).status, 422);
  let url;
  const fetchImpl = async (u) => { url = u; return new Response(JSON.stringify({ Results: [{ Make: 'KENWORTH', ModelYear: '2020', EngineManufacturer: 'Cummins', EngineModel: 'X15' }] })); };
  const v = await call(c, 'POST', { action: 'decode_vin', vin: '1xkyd49x0lj000000' }, '', { fetchImpl });
  assert.equal(v.status, 200); assert.equal(v.j.decoded.engine, 'Cummins|X15'); assert.match(url, /DecodeVinValues\/1XKYD49X0LJ000000\?format=json$/);
  const down = await call(c, 'POST', { action: 'decode_vin', vin: '1XKYD49X0LJ000000' }, '', { fetchImpl: async () => { throw new Error('net'); } });
  assert.equal(down.status, 502);
});

test('maintenance GET includes schedule status for the checklist order', async () => {
  const c = ctx('owner', OWNER);
  const r = await MAINT.GET(rq('maintenance', 'GET', null, `?truckId=${T1}`), { deps: c.deps });
  const j = await r.json();
  assert.deepEqual(j.schedule, [{ service_type: 'oil_filter', status: 'overdue' }]);
});

test('pm_suggest: unknown or null duty → severe, else every duty pooled; known duty keeps its fallback order', () => {
  const fn = SQL.slice(SQL.indexOf('function public.pm_suggest'), SQL.indexOf('function public.pm_setup_schedules'));
  assert.match(fn, /coalesce\(p_duty, 'unknown'\) = 'unknown'/);
  assert.match(fn, /when p\.duty_cycle = 'severe' then 1 else 2/);
  assert.match(fn, /array\[p_duty, 'severe', 'short_haul', 'long_haul', 'all'\]/);
  assert.match(fn, /b\.interval_miles nulls last/);
});

test('setup: management sees "Owner can confirm last service." beside checked items, owner gets date fields', () => {
  const src = readFileSync(new URL('../../app/truck/TruckSetup.js', import.meta.url), 'utf8');
  assert.match(src, /x\.done && !canBaseline && <p data-testid=\{`setup-owner-note-\$\{x\.serviceType\}`\} style=\{\{ \.\.\.s\.muted[^>]*>Owner can confirm last service\.<\/p>/);
  assert.match(src, /x\.done && canBaseline && \(/);
});

const FIX = readFileSync(new URL('../../supabase/migrations/20261023000400_maintenance_schedules_fix.sql', import.meta.url), 'utf8');

test('0400: ASCII, guard on 0300, no anon grants, definer functions pin search_path, 0300 untouched', () => {
  assert.ok(/^[\x00-\x7f]*$/.test(FIX));
  assert.match(FIX.slice(0, FIX.indexOf('create or replace')), /to_regclass\('public\.pm_schedules'\) is null[\s\S]*raise exception/);
  assert.doesNotMatch(FIX, /grant [^;]* to anon/i);
  for (const fn of FIX.matchAll(/create or replace function (public\.\w+)[\s\S]*?security definer([^\n]*)/g)) assert.match(fn[2], /set search_path = public/, fn[1]);
  assert.match(FIX, /drop function if exists public\.pm_la_today\(\)/);
  assert.match(FIX, /'America\/Chicago'/);
  assert.match(FIX, /ml::bigint \* 10 <= d\.interval_miles or d\.dl <= 14/);
  assert.doesNotMatch(SQL, /pm_today|pm_save_baseline/);
});

test('company day: server asks pm_today, never sends an LA date', async () => {
  const c = ctx('owner', OWNER);
  const r = await call(c, 'GET', null, `?truckId=${T1}`);
  assert.equal(r.j.today, '2026-10-22');
  const st = c.calls.find(([f]) => f === 'pm_status_for'); assert.deepEqual(st[1], { p_truck: T1 });
  const due = ctx('owner', OWNER); await call(due, 'GET', null, '?due=1');
  assert.deepEqual(due.calls.find(([f]) => f === 'pm_due_list')[1], {});
  const m = ctx('owner', OWNER); await MAINT.GET(rq('maintenance', 'GET', null, `?truckId=${T1}`), { deps: m.deps });
  assert.deepEqual(m.calls.find(([f]) => f === 'pm_status_for')[1], { p_truck: T1 });
  assert.equal(defaultToday(new Date('2026-10-24T04:30:00Z')), '2026-10-23'); // 11:30 PM in Chicago
  assert.equal(defaultToday(new Date('2026-10-24T05:30:00Z')), '2026-10-24');
});

test('setup with a future date by company day is refused before any write', async () => {
  const c = ctx('owner', OWNER);
  const r = await call(c, 'POST', { action: 'setup', truckId: T1, values: { engine: 'not_sure', items: [{ serviceType: 'oil_filter', done: true, date: '2026-10-23' }] } });
  assert.equal(r.status, 422); assert.match(r.j.error, /future/);
  assert.ok(!c.calls.some(([f]) => f === 'pm_save_baseline' || f === 'pm_setup_schedules'));
});

test('setup rows: toggling "not sure" on one row leaves every other row as it was', () => {
  const rows = [
    { serviceType: 'oil_filter', done: true, date: '2026-10-01', dateUnknown: false, miles: '400000', milesUnknown: false },
    { serviceType: 'valve_adjustment', done: true, date: '2026-10-01', dateUnknown: false, miles: '400000', milesUnknown: false },
    { serviceType: 'coolant', done: true, date: '2026-09-01', dateUnknown: false, miles: '390000', milesUnknown: false },
  ];
  const snap = JSON.stringify(rows);
  let r = patchRow(rows, 'valve_adjustment', { dateUnknown: true });
  r = patchRow(r, 'valve_adjustment', { milesUnknown: true });
  assert.equal(JSON.stringify(rows), snap, 'input not mutated');
  assert.equal(r[0], rows[0]); assert.equal(r[2], rows[2]);
  assert.deepEqual(r[1], { ...rows[1], dateUnknown: true, milesUnknown: true });
  r = patchRow(r, 'valve_adjustment', { dateUnknown: false });
  assert.equal(r[1].miles, '400000'); assert.equal(r[1].date, '2026-10-01');
});

test('schedule card keeps a separate draft per row (opening Valve does not drop the Oil draft)', () => {
  const src = readFileSync(new URL('../../app/truck/PmSchedules.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /setEdit\(\{ \.\.\.edit/);
  assert.match(src, /setEdits\(\(o\) =>/);
  assert.match(src, /edits\[r\.schedule_id\]/);
});

test('truck page: newest load wins, no cache, refetch after setup; driver banner names the right roles', () => {
  const src = readFileSync(new URL('../../app/truck/page.js', import.meta.url), 'utf8');
  assert.match(src, /n !== loadSeq\.current/);
  assert.match(src, /_=\$\{Date\.now\(\)\}/);
  assert.match(src, /onSetupDone=\{\(\) => \{ setSetupFor\(null\); load\(truck\.id\); \}\}/);
  assert.match(src, /Only the owner or management can change the maintenance schedule\./);
  assert.doesNotMatch(src, /Ask the owner or dispatcher/);
});

test('redo setup: form starts from the saved truck, mpg included (number or numeric string)', () => {
  const t = { engine_make: 'Cummins', engine_model: 'X15', engine_year: 2021, duty_cycle: 'long_haul', mpg: 8, odometer: 502900 };
  assert.deepEqual(setupDefaults(t), { engine: 'Cummins|X15', engineYear: 2021, dutyCycle: 'long_haul', mpg: '8', odometer: 502900 });
  assert.equal(setupDefaults({ ...t, mpg: '8.0' }).mpg, '8');
  assert.equal(setupDefaults({ ...t, mpg: '6.5' }).mpg, '6.5');
  assert.equal(setupDefaults({ ...t, mpg: null }).mpg, '');
  assert.deepEqual(setupDefaults(null), { engine: '', engineYear: '', dutyCycle: '', mpg: '', odometer: '' });
  const src = readFileSync(new URL('../../app/truck/TruckSetup.js', import.meta.url), 'utf8');
  assert.match(src, /useState\(\(\) => setupDefaults\(truck\)\)/);
  assert.match(src, /id="setup-mpg"[^>]*value=\{v\.mpg\}/);
});

test('setup checklist shows the truck\'s custom interval, marked Custom; suggested rows unchanged', async () => {
  const items = [{ serviceType: 'fuel_filters', intervalMiles: 60000, intervalDays: null, sourceText: 'Suggested from X' }, { serviceType: 'oil_filter', intervalMiles: 50000, intervalDays: 365, sourceText: 'Suggested from X' }];
  const out = withLiveCustom(items, [{ service_type: 'fuel_filters', interval_miles: 3000, interval_days: null, source: 'custom' }, { service_type: 'oil_filter', interval_miles: 1, interval_days: 1, source: 'suggested' }]);
  assert.deepEqual(out[0], { serviceType: 'fuel_filters', intervalMiles: 3000, intervalDays: null, sourceText: 'Custom interval', isCustom: true });
  assert.deepEqual(out[1], items[1]);
  const c = ctx('owner', OWNER);
  await c.uc.from('pm_schedules').insert({ truck_id: T1, service_type: 'oil_filter', interval_miles: 4000, interval_days: null, source: 'custom' });
  const p = await call(c, 'POST', { action: 'preview', truckId: T1, values: { engine: 'Detroit|DD15', dutyCycle: 'long_haul' } });
  assert.equal(p.status, 200);
  assert.equal(p.j.items[0].intervalMiles, 4000); assert.equal(p.j.items[0].intervalDays, null);
  assert.equal(p.j.items[0].isCustom, true); assert.equal(p.j.items[0].sourceText, 'Custom interval');
  const src = readFileSync(new URL('../../app/truck/TruckSetup.js', import.meta.url), 'utf8');
  assert.match(src, /x\.isCustom && <span data-testid=\{`setup-custom-/);
});
