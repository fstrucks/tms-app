// Migrations 20261023000100 + 20261023000200 (maintenance log fixes after QA) against PGlite (in-memory, WASM).
// LOCAL ONLY: never touches Supabase. Fake TEST data only. The setup mirrors prod where it matters:
//   - loads: driver = loads.assigned_driver_user_id (auth uid); dispatch leaves loads.truck_id null
//   - drivers: truck-tab roster, auth_user_id usually null
//   - documents: column-level INSERT grants + insert policy (own user_id, file under {auth uid}/)
// Run: npm i --no-save @electric-sql/pglite && node tests/sql/maintenance_log_fix.pglite.mjs
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
create table public.trucks (id uuid primary key, user_id uuid not null, unit_number text, odometer integer);
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

const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const O = id(1), M = id(2), D = id(4), D2 = id(5), D3 = id(8);
const C1 = id(101), T1 = id(201), T2 = id(202), T3 = id(203);
await db.exec(`insert into auth.users (id) values ('${O}'),('${M}'),('${D}'),('${D2}'),('${D3}');
insert into public.company_profiles (id, owner_id, legal_name) values ('${C1}','${O}','TEST Trucking Co');
insert into public.company_members (profile_id, user_id, role) values ('${C1}','${M}','management'),('${C1}','${D}','driver'),('${C1}','${D2}','driver'),('${C1}','${D3}','driver');
insert into public.trucks values ('${T1}','${O}','TEST-T1',160000),('${T2}','${O}','TEST-T2',50000),('${T3}','${O}','TEST-T3',70000);
insert into public.drivers (user_id, name, truck_id, auth_user_id) values ('${O}','TEST Roster Driver','${T1}',null),('${O}','TEST Linked','${T3}','${D3}');`);

const as = async (uid, sql, params = []) => {
  await db.exec(`reset role; set request.jwt.claim.sub = '${uid}'; set role authenticated`);
  try { return { rows: (await db.query(sql, params)).rows }; } catch (e) { return { err: e.message }; } finally { await db.exec('reset role'); }
};
const sys = async (sql, p = []) => (await db.query(sql, p)).rows;
const add = (uid, truck, cost, extra = {}) => as(uid, `insert into public.service_records (truck_id, service_date, odometer, vendor_name, total_cost, load_id, add_to_expenses, entry_source)
  values ($1, '2026-10-20', $2, 'TEST Shop', $3, $4, $5, 'logged') returning id, expense_id`, [truck, extra.odo ?? null, cost, extra.load ?? null, extra.exp ?? true]);
const load = (n, { truck = null, driver = null, status = 'booked', days = 0 } = {}) => sys(`insert into public.loads (id, user_id, truck_id, assigned_driver_user_id, status, broker_load_number, created_at, updated_at)
  values ($1, $2, $3, $4, $5, $6, now() - make_interval(days => $7), now() - make_interval(days => $7))`, [id(300 + n), O, truck, driver, status, `TEST-${4700 + n}`, days]);

// Before the fix (0100 only): reproduce Taylor's 403 with the real assignment shape.
await load(1, { driver: D, status: 'dispatched' });          // TEST-4701 as dispatch creates it: no truck
ok((await add(D, T1, 1)).err, 'repro (0100 only): driver with a dispatched load (truck_id null) is denied');
ok((await as(D, `select count(*)::int n from public.maint_load_choices($1)`, [T1])).rows[0].n === 0, 'repro (0100 only): his load picker is empty');
// Receipt insert repro: column grant missing.
const Rown = (await add(O, T2, 10)).rows[0].id;
ok(/permission denied/.test((await as(O, `insert into public.documents (user_id, doc_type, file_path, original_filename, truck_id, service_record_id) values ($1, 'maintenance_receipt', $4, 'r.jpg', $2, $3)`, [O, T2, Rown, `${O}/1-r.jpg`])).err || ''), 'repro (0100 only): receipt row insert -> permission denied');

const FIX = readFileSync(R + '20261023000200_maintenance_log_fix.sql', 'utf8');
ok(!/[^\x00-\x7F]/.test(FIX), '0200 is plain ASCII');
await db.exec(`update public.expenses set description = 'Maintenance ' || chr(194) || chr(183) || ' Truck #TEST-T2 ' || chr(183) || ' TEST Shop'`);
await db.exec(FIX);
await db.exec(FIX); // idempotent
ok(true, '0200 applies twice');

// 3. Separator.
ok((await sys(`select description from public.expenses`))[0].description === 'Maintenance - Truck #TEST-T2 - TEST Shop', '3: existing garbled description repaired');
const v3 = (await add(O, T2, 20)).rows[0];
ok((await sys(`select description from public.expenses where id = $1`, [v3.expense_id]))[0].description === 'Maintenance - Truck #TEST-T2 - TEST Shop', '3: new description uses " - "');

// 1. Driver access with the real shape.
const r1 = await add(D, T1, 1, { load: id(301) });
ok(!r1.err && r1.rows[0].id, '1: driver with dispatched TEST-4701 (no truck) logs service on TEST-T1 with that load');
await load(2, { driver: D, status: 'in_transit', days: 1 });
ok((await as(D, `select public.maint_drives_truck($1) d`, [T1])).rows[0].d === true, '1: maint_drives_truck true');
ok((await as(D, `select count(*)::int n from public.maint_load_choices($1)`, [T1])).rows[0].n === 2, '1: picker shows his 2 open loads');
ok((await as(D, `select public.maint_drives_truck($1) d`, [T3])).rows[0].d === false, '1: not a truck linked to another driver login');
ok((await as(D3, `select public.maint_drives_truck($1) d`, [T3])).rows[0].d === true, '1: linked driver row (drivers.auth_user_id) still works');
ok((await as(D3, `select public.maint_drives_truck($1) d`, [T2])).rows[0].d === false, '1: linked driver is limited to his truck');
await sys(`update public.loads set status = 'delivered' where assigned_driver_user_id = $1`, [D]);
ok((await as(D, `select public.maint_drives_truck($1) d`, [T1])).rows[0].d === false, '1: after delivery no access (UI hides Log service)');
ok((await add(D, T1, 1)).err, '1: …and insert is denied');
await load(3, { truck: T2, driver: D2, status: 'dispatched' });
ok((await as(D2, `select public.maint_drives_truck($1) d`, [T2])).rows[0].d === true, '1: load with truck_id set → that truck');
ok((await as(D2, `select public.maint_drives_truck($1) d`, [T1])).rows[0].d === false, '1: …not another truck');

// 4. Picker: this truck only; unassigned fallback; status / 30-day window; newest first.
await sys(`delete from public.loads`);
await load(10, { truck: T1, status: 'booked', days: 3 });
await load(11, { truck: T1, status: 'in_transit', days: 1 });
await load(12, { truck: T1, status: 'delivered', days: 10 });
await load(13, { truck: T1, status: 'paid', days: 45 });     // too old
await load(14, { truck: T1, status: 'cancelled', days: 0 }); // never
await load(15, { truck: T2, status: 'booked', days: 0 });    // other truck
await load(16, { status: 'booked', days: 0 });               // unassigned
let ch = (await as(O, `select broker_load_number n from public.maint_load_choices($1)`, [T1])).rows.map((x) => x.n);
ok(JSON.stringify(ch) === JSON.stringify(['TEST-4711', 'TEST-4710', 'TEST-4712']), `4: T1 → own current + recent, newest first (${ch})`);
ch = (await as(O, `select broker_load_number n from public.maint_load_choices($1)`, [T3])).rows.map((x) => x.n);
ok(JSON.stringify(ch) === JSON.stringify(['TEST-4716']), `4: T3 has none → unassigned loads only (${ch})`);
ok(/load_not_allowed/.test((await add(O, T1, 5, { load: id(315) })).err || ''), '4: trigger rejects another truck\'s load');
ok(/load_not_allowed/.test((await add(O, T1, 5, { load: id(313) })).err || ''), '4: …and an old one');
ok(!(await add(O, T1, 5, { load: id(312) })).err, '4: recent delivered load accepted');

// 5. Item costs vs total.
const v5 = (await add(O, T1, 100, { exp: false })).rows[0].id;
const item = (uid, rec, type, cost) => as(uid, `insert into public.service_record_items (service_record_id, service_type, cost) values ($1, $2, $3)`, [rec, type, cost]);
ok(/item_over_total/.test((await item(O, v5, 'tires', 150)).err || ''), '5: item above total rejected');
ok(!(await item(O, v5, 'tires', 60)).err, '5: item within total ok');
ok(/items_over_total/.test((await item(O, v5, 'brakes', 50)).err || ''), '5: sum above total rejected');
ok(!(await item(O, v5, 'brakes', 40)).err, '5: sum equal to total ok');
ok(/items_over_total|item_over_total/.test((await as(O, `update public.service_records set total_cost = 90 where id = $1`, [v5])).err || ''), '5: lowering total below items rejected');

// 6. Blank odometer: visit stores null, truck unchanged.
const before = (await sys(`select odometer from public.trucks where id = $1`, [T1]))[0].odometer;
const v6 = (await add(O, T1, 0)).rows[0].id;
ok((await sys(`select odometer from public.service_records where id = $1`, [v6]))[0].odometer === null && (await sys(`select odometer from public.trucks where id = $1`, [T1]))[0].odometer === before, '6: blank miles → null on visit, truck odometer unchanged');

// 2. Receipt upload as the app does it (own folder, user_id = auth uid, no load_id).
await load(20, { driver: D, status: 'dispatched' });
const vD = (await add(D, T1, 0)).rows[0].id;
const ins = (uid, path, rec) => as(uid, `insert into public.documents (user_id, doc_type, file_path, original_filename, truck_id, service_record_id) values ($1, 'maintenance_receipt', $2, 'r.jpg', $3, $4) returning id, load_id`, [uid, path, T1, rec]);
let d = await ins(D, `${D}/1-abc-r.jpg`, vD);
ok(!d.err && d.rows[0].load_id === null, `2: driver receipt row inserted, no load_id ${d.err || ''}`);
d = await ins(O, `${O}/1-abc-r.jpg`, v6);
ok(!d.err, `2: owner receipt row inserted ${d.err || ''}`);
ok((await ins(D, `${O}/x.jpg`, vD)).err, '2: path outside own folder rejected');
ok((await as(M, `select count(*)::int n from public.documents where service_record_id = $1`, [vD])).rows[0].n === 1, '2: management sees the driver\'s receipt');

// Grants.
const g = (await sys(`select has_function_privilege('anon','public.maint_load_ok_for(uuid,uuid)','execute') a, has_function_privilege('authenticated','public.maint_check_item_costs(uuid)','execute') c,
  has_column_privilege('authenticated','public.documents','service_record_id','insert') i, has_column_privilege('authenticated','public.documents','service_record_id','update') u`))[0];
ok(!g.a && !g.c && g.i && !g.u, 'grants: insert(service_record_id) only; helpers not public');
if (fails) console.error(`${fails} failed`); else console.log('all passed');
