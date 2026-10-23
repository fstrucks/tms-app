// Migration 20261023000300 (maintenance schedules) against PGlite (in-memory, WASM). LOCAL ONLY, fake TEST data.
// Run: npm i --no-save @electric-sql/pglite && node tests/sql/maintenance_schedules.pglite.mjs
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
const db = new PGlite();
const R = process.env.MIG_DIR || new URL('../../supabase/migrations/', import.meta.url).pathname;
let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.error('FAIL', m); process.exitCode = 1; } else console.log('ok', m); };
await db.exec(`
create role anon; create role authenticated;
create schema auth;
create table auth.users (id uuid primary key, email text);
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
grant usage on schema auth to authenticated, anon; grant execute on function auth.uid() to authenticated, anon;
grant usage on schema public to authenticated, anon;
create table public.trucks (id uuid primary key, user_id uuid not null, unit_number text, odometer integer, make text, model text, year integer, vin text);
alter table public.trucks enable row level security;
create table public.loads (id uuid primary key default gen_random_uuid(), user_id uuid not null, truck_id uuid, assigned_driver_user_id uuid,
  status text default 'booked', broker_name text, broker_load_number text, created_at timestamptz default now(), updated_at timestamptz default now());
alter table public.loads enable row level security;
create policy loads_select_own on public.loads for select to authenticated using (user_id = auth.uid());
grant select, insert, update, delete on public.loads to authenticated;
create table public.expenses (id uuid primary key default gen_random_uuid(), user_id uuid not null, category text, amount numeric, expense_date date,
  description text, load_id uuid, document_id uuid);
alter table public.expenses enable row level security;
create table public.documents (id uuid primary key default gen_random_uuid(), user_id uuid, load_id uuid, truck_id uuid, doc_type text,
  file_path text, original_filename text, created_at timestamptz default now());
alter table public.documents enable row level security;
create policy documents_select_own on public.documents for select to authenticated using (user_id = auth.uid());
create policy documents_insert_own on public.documents for insert to authenticated
  with check (user_id = auth.uid() and split_part(file_path, '/', 1) = auth.uid()::text
    and (load_id is null or exists (select 1 from public.loads l where l.id = documents.load_id and l.user_id = auth.uid())));
grant select on public.documents to authenticated;
grant insert (user_id, load_id, truck_id, doc_type, file_path, original_filename) on public.documents to authenticated;
grant update (load_id, truck_id, doc_type) on public.documents to authenticated;
create table public.drivers (id uuid primary key default gen_random_uuid(), user_id uuid, name text, truck_id uuid, auth_user_id uuid, active boolean default true);
`);
await db.exec(readFileSync(R + '20261015001200_company_profiles.sql', 'utf8'));
await db.exec(readFileSync(R + '20261023000100_maintenance_log.sql', 'utf8'));
await db.exec(readFileSync(R + '20261023000200_maintenance_log_fix.sql', 'utf8'));
const MIG = readFileSync(R + '20261023000300_maintenance_schedules.sql', 'utf8');
ok(!/[^\x00-\x7F]/.test(MIG), '0300 is plain ASCII');
await db.exec(MIG);
await db.exec(MIG);
ok(true, '0300 applies twice');


const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const O = id(1), M = id(2), P = id(3), D = id(4), D2 = id(5), X = id(9);
const C1 = id(101), C2 = id(102), T1 = id(201), T2 = id(202), TX = id(209);
await db.exec(`insert into auth.users (id) values ('${O}'),('${M}'),('${P}'),('${D}'),('${D2}'),('${X}');
insert into public.company_profiles (id, owner_id, legal_name) values ('${C1}','${O}','TEST Trucking Co'),('${C2}','${X}','TEST Other Co');
insert into public.company_members (profile_id, user_id, role) values ('${C1}','${M}','management'),('${C1}','${P}','dispatcher'),('${C1}','${D}','driver'),('${C1}','${D2}','driver');
insert into public.trucks (id, user_id, unit_number, odometer) values ('${T1}','${O}','TEST-T1',400000),('${T2}','${O}','TEST-T2',100000),('${TX}','${X}','TEST-X',1000);
insert into public.drivers (user_id, name, truck_id, auth_user_id) values ('${O}','TEST Linked','${T1}','${D}');`);
const as = async (uid, sql, params = []) => {
  await db.exec(`reset role; set request.jwt.claim.sub = '${uid}'; set role authenticated`);
  try { return { rows: (await db.query(sql, params)).rows }; } catch (e) { return { err: e.message }; } finally { await db.exec('reset role'); }
};
const sys = async (sql, p = []) => (await db.query(sql, p)).rows;

// Seed.
const cnt = (await sys(`select count(*)::int n, count(*) filter (where is_generic)::int g, count(distinct seed_key)::int k from public.maintenance_interval_templates`))[0];
ok(cnt.n === 196 && cnt.g === 7 && cnt.k === 196, `seed: 196 rows, 7 generic (got ${cnt.n}/${cnt.g})`);
ok((await sys(`select count(*)::int n from public.maintenance_interval_templates where is_generic and maker <> 'GENERIC'`))[0].n === 0, 'seed: only GENERIC rows are generic');
ok((await as(D, `select count(*)::int n from public.maintenance_interval_templates`)).rows[0].n === 196, 'templates: any signed-in user can read');
ok((await as(O, `update public.maintenance_interval_templates set interval_miles = 1`)).err, 'templates: owner cannot write');
ok((await as(O, `insert into public.maintenance_interval_templates (seed_key, maker, model, duty_cycle, seed_service_type, service_type) values ('x','x','x','all','x','oil_filter')`)).err, 'templates: no client insert');
await db.exec(`reset role; set role anon`);
let anonErr = null; try { await db.query(`select 1 from public.maintenance_interval_templates limit 1`); } catch (e) { anonErr = e.message; }
await db.exec('reset role');
ok(anonErr, 'templates: anon cannot read');
const eng = (await as(O, `select maker || ' ' || model m from public.pm_engine_choices()`)).rows.map((r) => r.m);
ok(eng.includes('Detroit DD15') && !eng.includes('Mack MP8') && eng.includes('Mack MP8 (MY2017-2020, 42L pan)') && !eng.some((e) => e.startsWith('GENERIC')), `engine choices (${eng.length})`);
ok((await sys(`select bool_and(public.pm_fuel_ok(r, m) = e) b from (values ('>7.0 mpg; >60k mi/yr', 7.5, true), ('>7.0 mpg; >60k mi/yr', 7.0, false), ('6.0-6.9 mpg', 6.95, true), ('3-4.9 mpg', 5.0, false), ('<=5.0 mpg or <30k mi/yr', 5.0, true), ('idle-time based, not mpg', 4.0, true), ('>=7 mpg', 7, true)) v(r, m, e)`))[0].b, 'pm_fuel_ok parses fuel rules');

// Suggestions.
const sug = async (make, model, duty, mpg) => Object.fromEntries((await sys(`select * from public.pm_suggest($1,$2,$3,$4)`, [make, model, duty, mpg])).map((r) => [r.service_type, r]));
const g = await sug(null, null, 'unknown', null);
ok(Object.values(g).every((r) => r.is_generic) && Object.keys(g).length >= 5, 'unknown engine -> generic rows');
ok(g.fuel_filters && g.fuel_filters.interval_miles === g.oil_filter.interval_miles, 'generic fuel filter follows the oil interval');
const dd = await sug('Detroit', 'DD15', 'long_haul', 7.5), ddLow = await sug('Detroit', 'DD15', 'long_haul', null);
ok(dd.oil_filter && !dd.oil_filter.is_generic, 'DD15 picks maker rows');
ok(ddLow.oil_filter.interval_miles <= dd.oil_filter.interval_miles, `mpg unknown -> most conservative oil interval (${ddLow.oil_filter.interval_miles} <= ${dd.oil_filter.interval_miles})`);
const sev = await sug('Detroit', 'DD15', 'severe', null), unk = await sug('Detroit', 'DD15', 'unknown', null);
ok(unk.oil_filter.template_id === sev.oil_filter.template_id, 'duty unknown -> severe rows');
// Synthetic engine with no severe rows: unknown duty pools every duty and the shortest wins.
await sys(`insert into public.maintenance_interval_templates (seed_key, maker, model, duty_cycle, seed_service_type, service_type, interval_miles, fuel_rule) values
  ('t|sh', 'Testco', 'T1', 'short_haul', 'oil', 'oil_filter', 40000, null),
  ('t|lh-hi', 'Testco', 'T1', 'long_haul', 'oil', 'oil_filter', 25000, '>7.0 mpg'),
  ('t|lh-lo', 'Testco', 'T1', 'long_haul', 'oil', 'oil_filter', 20000, '<=5.0 mpg')`);
const tu = await sug('Testco', 'T1', 'unknown', null), tn = await sug('Testco', 'T1', null, null);
ok(tu.oil_filter.interval_miles === 20000, `duty + mpg unknown, no severe rows -> shortest across duties (${tu.oil_filter.interval_miles})`);
ok(tn.oil_filter.interval_miles === 20000, 'null duty behaves like unknown');
ok((await sug('Testco', 'T1', 'unknown', 7.5)).oil_filter.interval_miles === 25000, 'duty unknown, mpg known -> matching fuel row');
ok((await sug('Testco', 'T1', 'short_haul', null)).oil_filter.interval_miles === 40000, 'known duty keeps its own rows');
ok((await sug('Testco', 'T1', 'long_haul', null)).oil_filter.interval_miles === 20000, 'mpg unknown -> shortest fuel-rule interval');
await sys(`delete from public.maintenance_interval_templates where maker = 'Testco'`);
const mp8 = await sug('Mack', 'MP8 (MY2017-2020, 42L pan)', 'long_haul', null);
ok(mp8.valve_adjustment && mp8.oil_filter, 'MP8 variant also gets the base MP8 valve row');
const x12 = await sug('Cummins', 'X12 (2020)', 'short_haul', null);
ok(x12.oil_filter && !x12.oil_filter.is_generic, 'missing duty falls back to another duty, not generic');

// Setup + RLS.
await sys(`update public.trucks set engine_make = 'Detroit', engine_model = 'DD15', duty_cycle = 'long_haul', mpg = 7.5 where id = $1`, [T1]);
ok((await as(D, `select public.pm_setup_schedules($1)`, [T1])).err, 'setup: driver denied');
ok((await as(P, `select public.pm_setup_schedules($1)`, [T1])).err, 'setup: dispatch denied');
ok((await as(X, `select public.pm_setup_schedules($1)`, [T1])).err, 'setup: other company denied');
const n1 = (await as(O, `select public.pm_setup_schedules($1, '{"coolant":"unknown"}'::jsonb) n`, [T1])).rows[0].n;
ok(n1 >= 5, `setup: owner creates ${n1} suggested schedules`);
ok((await as(M, `select public.pm_setup_schedules($1) n`, [T2])).rows?.[0].n >= 5, 'setup: management can set up (T2 -> generic)');
ok((await sys(`select bool_and(t.is_generic) b from public.pm_schedules s join public.maintenance_interval_templates t on t.id = s.template_id where s.truck_id = $1`, [T2]))[0].b, 'T2 without engine uses generic templates');
for (const [u, who] of [[O, 'owner'], [M, 'management'], [P, 'dispatch'], [D, 'driver on the truck']]) {
  ok((await as(u, `select count(*)::int n from public.pm_schedules where truck_id = $1`, [T1])).rows[0].n === n1, `read: ${who} sees T1 schedules`);
}
ok((await as(D2, `select count(*)::int n from public.pm_schedules where truck_id = $1`, [T1])).rows[0].n === 0, 'read: driver not on the truck sees none');
ok((await as(X, `select count(*)::int n from public.pm_schedules`)).rows[0].n === 0, 'read: other company sees none');
ok((await as(X, `select count(*)::int n from public.pm_status_for($1)`, [T1])).rows[0].n === 0, 'status: other company gets nothing');
const upd = async (u) => as(u, `update public.pm_schedules set interval_miles = 50000 where truck_id = $1 and service_type = 'oil_filter' returning source`, [T1]);
ok(((await upd(D)).rows || []).length === 0, 'write: driver cannot edit');
ok(((await upd(P)).rows || []).length === 0, 'write: dispatch cannot edit');
ok((await upd(M)).rows?.[0]?.source === 'custom', 'write: management edit -> source custom');
ok((await as(D, `insert into public.pm_schedules (truck_id, owner_id, service_type, interval_miles) values ($1,$2,'tires',100000)`, [T1, O])).err, 'write: driver cannot insert');
ok(!(await as(O, `insert into public.pm_schedules (truck_id, owner_id, service_type, interval_miles) values ($1,$2,'tires',100000)`, [T1, O])).err, 'write: owner can add a custom schedule');
ok((await as(O, `insert into public.pm_schedules (truck_id, owner_id, service_type, source) values ($1,$2,'brakes','suggested')`, [T1, O])).err, 'suggested needs a template');
await as(O, `select public.pm_setup_schedules($1)`, [T1]);
ok((await sys(`select interval_miles, source from public.pm_schedules where truck_id = $1 and service_type = 'oil_filter'`, [T1]))[0].interval_miles === 50000, 're-run setup keeps custom schedules');

// Baseline: no expense, owner only.
const exp0 = (await sys(`select count(*)::int n from public.expenses`))[0].n;
ok((await as(M, `insert into public.service_records (truck_id, owner_id, service_date, odometer, total_cost, entry_source) values ($1,$2,'2026-09-01',390000,0,'baseline')`, [T1, O])).err, 'baseline: management cannot record');
const b = await as(O, `insert into public.service_records (truck_id, owner_id, service_date, odometer, total_cost, entry_source) values ($1,$2,'2026-09-01',390000,500,'baseline') returning id, expense_id`, [T1, O]);
ok(b.rows && b.rows[0].expense_id === null, 'baseline: owner records, no expense link');
await as(O, `insert into public.service_record_items (service_record_id, service_type) values ($1,'fuel_filters'),($1,'air_filter'),($1,'coolant_filter')`, [b.rows[0].id]);
ok((await sys(`select count(*)::int n from public.expenses`))[0].n === exp0, 'baseline: expenses unchanged');
ok((await sys(`select count(*)::int n from public.service_record_items where service_type = 'coolant_filter'`))[0].n === 1, 'coolant_filter is an allowed item type');

// Next-due math (today fixed 2026-10-23, truck at 400,000).
const oilRec = (await as(O, `insert into public.service_records (truck_id, owner_id, service_date, odometer, total_cost, entry_source) values ($1,$2,'2026-05-01',352000,0,'baseline') returning id`, [T1, O])).rows[0].id;
await as(O, `insert into public.service_record_items (service_record_id, service_type) values ($1,'oil_filter'),($1,'def_filter')`, [oilRec]);
await sys(`update public.pm_schedules set interval_miles = 50000, interval_days = 365 where truck_id = $1 and service_type = 'oil_filter'`, [T1]);
await sys(`update public.pm_schedules set interval_miles = 40000, interval_days = null where truck_id = $1 and service_type = 'def_filter'`, [T1]);
await sys(`update public.pm_schedules set interval_miles = null, interval_days = 60 where truck_id = $1 and service_type = 'fuel_filters'`, [T1]);
await sys(`update public.pm_schedules set interval_miles = 500000, interval_days = 3650 where truck_id = $1 and service_type = 'air_filter'`, [T1]);
const st = Object.fromEntries((await as(D, `select * from public.pm_status_for($1, '2026-10-23')`, [T1])).rows.map((r) => [r.service_type, r]));
ok(st.oil_filter.next_due_odometer === 402000 && st.oil_filter.miles_left === 2000 && st.oil_filter.status === 'due_soon', `oil: 2,000 mi left of 50,000 -> due soon (${st.oil_filter.status})`);
ok(st.oil_filter.next_due_date === '2027-05-01' || String(st.oil_filter.next_due_date).startsWith('2027-05-01') || new Date(st.oil_filter.next_due_date).toISOString().startsWith('2027-05-01'), 'oil: next date = last + 365 days');
ok(st.def_filter.miles_left === -8000 && st.def_filter.status === 'overdue', 'def: past the miles -> overdue');
ok(st.fuel_filters.days_left === 8 && st.fuel_filters.status === 'due_soon', `fuel: 8 days left -> due soon (${st.fuel_filters.days_left})`);
ok(st.air_filter.status === 'ok', 'air: far off -> ok');
ok(st.coolant.status === 'unknown', 'coolant: no record, marked not sure -> unknown');
ok(st.valve_adjustment && st.valve_adjustment.status === 'unknown', 'valve: no record, no start state -> unknown');
ok(st.tires.status === 'unknown' && st.oil_filter.source === 'custom', 'custom source shown');
await sys(`update public.pm_schedules set start_state = 'due' where truck_id = $1 and service_type = 'valve_adjustment'`, [T1]);
const due = (await as(O, `select * from public.pm_due_list('2026-10-23')`)).rows;
ok(due.some((r) => r.service_type === 'def_filter' && r.status === 'overdue') && due.some((r) => r.status === 'due') && !due.some((r) => r.status === 'ok' || r.status === 'unknown'), `due list: overdue / due / due soon only (${due.length})`);
ok(due[0].status === 'overdue', 'due list: overdue first');
ok((await as(X, `select count(*)::int n from public.pm_due_list('2026-10-23')`)).rows[0].n === 0, 'due list: other company sees none');
ok((await as(D2, `select count(*)::int n from public.pm_due_list('2026-10-23')`)).rows[0].n === 0, 'due list: driver not on any truck sees none');
// Days boundary: 14 days = due soon, 15 = ok.
await sys(`update public.pm_schedules set interval_days = 66 where truck_id = $1 and service_type = 'fuel_filters'`, [T1]);
ok((await as(O, `select status from public.pm_status_for($1, '2026-10-23') where service_type = 'fuel_filters'`, [T1])).rows[0].status === 'due_soon', '14 days left -> due soon');
await sys(`update public.pm_schedules set interval_days = 67 where truck_id = $1 and service_type = 'fuel_filters'`, [T1]);
ok((await as(O, `select status from public.pm_status_for($1, '2026-10-23') where service_type = 'fuel_filters'`, [T1])).rows[0].status === 'ok', '15 days left -> ok');

await db.exec(MIG);
ok((await sys(`select count(*)::int n from public.maintenance_interval_templates`))[0].n === 196 && (await sys(`select count(*)::int n from public.pm_schedules where truck_id = $1`, [T1]))[0].n === n1 + 1, 're-applying 0300 keeps data');
console.log(fails ? `${fails} FAILED` : 'all passed');
