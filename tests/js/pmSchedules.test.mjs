// Maintenance schedules (migration 20261023000300): input helpers, labels, VIN decode, routes. Fake TEST data only.
// Status math, RLS and the seed run against real Postgres in tests/sql/maintenance_schedules.pglite.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fakeSupabase } from './fakeSupabase.mjs';
import { engineInput, checklistInput, orderBySchedule, intervalInput, decodeVin, sourceText, intervalText, dueText, VPIC_URL } from '../../app/lib/pmSchedule.js';
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

test('setup: owner saves engine, odometer, one baseline visit (no expense), schedules with start states', async () => {
  const c = ctx('owner', OWNER);
  const r = await call(c, 'POST', { action: 'setup', truckId: T1, values: { engine: 'Detroit|DD15', dutyCycle: 'long_haul', odometer: '412,000', items: [
    { serviceType: 'oil_filter', done: true, date: '2026-10-01', miles: '411000' }, { serviceType: 'coolant', done: true, dateUnknown: true }, { serviceType: 'grease', done: false }] } });
  assert.equal(r.status, 200, JSON.stringify(r.j)); assert.equal(r.j.visits, 1); assert.equal(r.j.schedules, 8);
  const odo = c.calls.find(([f]) => f === 'set_truck_odometer'); assert.equal(odo[1].p_odometer, 412000);
  const setup = c.calls.find(([f]) => f === 'pm_setup_schedules'); assert.deepEqual(setup[1].p_start, { coolant: 'unknown', grease: 'due' });
  const tr = await c.uc.from('trucks').select('*').eq('id', T1).maybeSingle();
  assert.equal(tr.data.engine_model, 'DD15'); assert.ok(tr.data.maint_setup_at);
  const recs = (await c.uc.from('service_records').select('*')).data;
  assert.equal(recs.length, 1); assert.equal(recs[0].entry_source, 'baseline'); assert.equal(recs[0].add_to_expenses, false); assert.equal(recs[0].total_cost, 0);
  assert.deepEqual((await c.uc.from('service_record_items').select('*')).data.map((x) => x.service_type), ['oil_filter']);
});

test('setup: management gets schedules but no baseline visit', async () => {
  const c = ctx('management', MGR);
  const r = await call(c, 'POST', { action: 'setup', truckId: T1, values: { engine: 'not_sure', items: [{ serviceType: 'oil_filter', done: true, date: '2026-10-01' }] } });
  assert.equal(r.status, 200); assert.equal(r.j.visits, 0);
  assert.equal((await c.uc.from('service_records').select('*')).data.length, 0);
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
