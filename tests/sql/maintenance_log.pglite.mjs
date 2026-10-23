// Migration 20261023000100 (maintenance log) against an in-memory Postgres (PGlite, WASM).
// LOCAL ONLY: never touches Supabase. Fake TEST data only.
// Run: npm i --no-save @electric-sql/pglite && node tests/sql/maintenance_log.pglite.mjs
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
create table public.expenses (id uuid primary key default gen_random_uuid(), user_id uuid not null, category text, amount numeric, expense_date date,
  description text, load_id uuid, document_id uuid);
alter table public.expenses enable row level security;
create policy expenses_select_own on public.expenses for select to authenticated using (user_id = auth.uid());
grant select on public.expenses to authenticated;
create table public.documents (id uuid primary key default gen_random_uuid(), user_id uuid, load_id uuid, doc_type text, file_path text);
alter table public.documents enable row level security;
create policy documents_select_own on public.documents for select to authenticated using (user_id = auth.uid());
create policy documents_insert_own on public.documents for insert to authenticated with check (user_id = auth.uid());
create policy documents_update_own on public.documents for update to authenticated using (user_id = auth.uid());
grant select, insert, update on public.documents to authenticated;
create table public.drivers (id uuid primary key default gen_random_uuid(), user_id uuid, truck_id uuid, auth_user_id uuid, active boolean default true);
`);
await db.exec(readFileSync(R + '20261015001200_company_profiles.sql', 'utf8'));
const MIG = readFileSync(R + '20261023000100_maintenance_log.sql', 'utf8');
await db.exec(MIG);
await db.exec(MIG); // idempotent
ok(true, 'migration applies twice');

const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const O = id(1), M = id(2), P = id(3), D = id(4), D2 = id(5), X = id(6), O2 = id(7);
const C1 = id(101), C2 = id(102), T1 = id(201), T2 = id(202), T9 = id(209), L1 = id(301), L2 = id(302), L9 = id(309);
await db.exec(`insert into auth.users (id) values ('${O}'),('${M}'),('${P}'),('${D}'),('${D2}'),('${X}'),('${O2}');
insert into public.company_profiles (id, owner_id, legal_name) values ('${C1}','${O}','TEST Co'),('${C2}','${O2}','TEST Other Co');
insert into public.company_members (profile_id, user_id, role) values ('${C1}','${M}','management'),('${C1}','${P}','dispatcher'),('${C1}','${D}','driver'),('${C1}','${D2}','driver');
insert into public.trucks values ('${T1}','${O}','101',100000),('${T2}','${O}','102',null),('${T9}','${O2}','901',5);
insert into public.drivers (user_id, truck_id, auth_user_id) values ('${O}','${T1}','${D}');
insert into public.loads (id, user_id, truck_id, assigned_driver_user_id, status) values ('${L1}','${O}','${T1}','${D}','in_transit'),('${L2}','${O}','${T2}','${D2}','dispatched'),('${L9}','${O2}','${T9}',null,'in_transit');`);

const as = async (uid, sql, params = []) => {
  await db.exec(`reset role; set request.jwt.claim.sub = '${uid}'; set role authenticated`);
  try { return { rows: (await db.query(sql, params)).rows }; } catch (e) { return { err: e.message }; } finally { await db.exec('reset role'); }
};
const sys = async (sql, p = []) => (await db.query(sql, p)).rows;
const add = (uid, truck, cost, extra = {}) => as(uid, `insert into public.service_records (truck_id, service_date, odometer, vendor_name, total_cost, load_id, add_to_expenses, entry_source)
  values ($1, '2026-10-20', $2, 'TEST Shop', $3, $4, $5, $6) returning id, owner_id, expense_id`,
  [truck, extra.odo ?? null, cost, extra.load ?? null, extra.exp ?? true, extra.src ?? 'logged']);

// Owner: create, expense once, odometer bump.
let r = await add(O, T1, 250, { odo: 101500, load: L1 });
ok(r.rows?.[0]?.owner_id === O && r.rows[0].expense_id, 'owner adds a visit; owner_id = company owner; expense created');
const R1 = r.rows[0].id;
let ex = await sys(`select * from public.expenses where id = $1`, [r.rows[0].expense_id]);
ok(ex.length === 1 && Number(ex[0].amount) === 250 && ex[0].category === 'maintenance' && ex[0].load_id === L1 && ex[0].user_id === O, 'expense: maintenance, amount, load, owner');
ok((await sys(`select odometer from public.trucks where id = $1`, [T1]))[0].odometer === 101500, 'odometer raised');
await as(O, `update public.service_records set total_cost = 300, load_id = null, notes = 'x' where id = $1`, [R1]);
await as(O, `update public.service_records set notes = 'y' where id = $1`, [R1]);
ex = await sys(`select e.* from public.expenses e`);
ok(ex.length === 1 && Number(ex[0].amount) === 300 && ex[0].load_id === null, 'edits update the same expense (exactly once), load cleared');
r = await add(O, T1, 50, { odo: 90000 });
ok((await sys(`select odometer from public.trucks where id = $1`, [T1]))[0].odometer === 101500, 'lower odometer never lowers the truck');
ok((await sys(`select count(*)::int n from public.expenses`))[0].n === 2, 'second visit → second expense');
await as(O, `update public.service_records set add_to_expenses = false where id = $1`, [r.rows[0].id]);
ok((await sys(`select count(*)::int n from public.expenses`))[0].n === 1, 'unchecking Add to expenses removes its expense');
r = await add(O, T1, 0); ok(r.rows && !r.rows[0].expense_id, '$0 visit: no expense');
r = await add(O, T1, 80, { exp: false }); ok(r.rows && !r.rows[0].expense_id, 'add_to_expenses false: no expense');
r = await add(O, T1, 80, { src: 'baseline' }); ok(r.rows && !r.rows[0].expense_id, 'baseline: no expense');
r = await add(M, T1, 80, { src: 'baseline' }); ok(r.err, 'management cannot add a baseline row');
r = await as(O, `insert into public.service_records (truck_id, service_date, total_cost, expense_id) values ($1, '2026-10-20', 1, $2)`, [T1, id(999)]);
ok(/permission denied/.test(r.err || ''), 'expense_id is not a client column');

// Delete removes the auto expense.
const before = (await sys(`select count(*)::int n from public.expenses`))[0].n;
const R2 = (await add(O, T2, 40)).rows[0].id;
await as(O, `delete from public.service_records where id = $1`, [R2]);
ok((await sys(`select count(*)::int n from public.expenses`))[0].n === before, 'deleting the visit deletes its expense');

// Items: judged through the parent.
r = await as(O, `insert into public.service_record_items (service_record_id, service_type, cost) values ($1, 'oil_filter', 120), ($1, 'grease', 30) returning id`, [R1]);
ok(r.rows?.length === 2, 'owner adds two items to one visit');
r = await as(O, `insert into public.service_record_items (service_record_id, service_type) values ($1, 'oil')`, [R1]);
ok(r.err, 'unknown service type rejected');

// Management: full; Dispatcher: read only.
r = await add(M, T1, 10); ok(r.rows?.length === 1, 'management adds');
ok((await as(M, `update public.service_records set notes = 'm' where id = $1 returning id`, [R1])).rows?.length === 1, 'management edits owner’s row');
ok((await as(P, `select count(*)::int n from public.service_records`)).rows[0].n > 0, 'dispatcher sees visits');
ok((await as(P, `select count(*)::int n from public.service_record_items`)).rows[0].n === 2, 'dispatcher sees items');
ok((await add(P, T1, 10)).err, 'dispatcher cannot add');
ok((await as(P, `update public.service_records set notes = 'p' where id = $1 returning id`, [R1])).rows?.length === 0, 'dispatcher cannot edit');
ok((await as(P, `delete from public.service_records where id = $1 returning id`, [R1])).rows?.length === 0, 'dispatcher cannot delete');

// Driver.
const dSees = (await as(D, `select truck_id from public.service_records`)).rows;
ok(dSees.length > 0 && dSees.every((x) => x.truck_id === T1), 'driver sees only his truck');
r = await add(D, T1, 99, { odo: 102000, load: L1 }); ok(r.rows?.length === 1 && r.rows[0].expense_id, 'driver adds for his truck with his load; expense created');
const RD = r.rows[0].id;
ok((await sys(`select user_id from public.expenses where id = $1`, [r.rows[0].expense_id]))[0].user_id === O, 'driver’s expense belongs to the company owner');
ok((await add(D, T2, 5)).err, 'driver cannot add for another truck');
ok(/load_not_allowed/.test((await add(D, T1, 5, { load: L2 })).err || ''), 'driver cannot pick a load not assigned to him');
ok((await add(D, T1, 5, { src: 'baseline' })).err, 'driver cannot add a baseline');
ok((await as(D, `update public.service_records set notes = 'd' where id = $1 returning id`, [RD])).rows?.length === 1, 'driver edits own entry within 24h');
ok((await as(D, `update public.service_records set notes = 'd' where id = $1 returning id`, [R1])).rows?.length === 0, 'driver cannot edit the owner’s entry');
await db.exec(`alter table public.service_records disable trigger service_records_before`);
await sys(`update public.service_records set created_at = now() - interval '25 hours' where id = $1`, [RD]);
await db.exec(`alter table public.service_records enable trigger service_records_before`);
ok((await as(D, `delete from public.service_records where id = $1 returning id`, [RD])).rows?.length === 0, 'driver cannot delete after 24h');
ok((await as(D2, `select count(*)::int n from public.service_records`)).rows[0].n === 0, 'driver of another truck (load on T2) sees no T1 visits');
const R2b = (await add(D2, T2, 7, { load: L2 })).rows?.[0]?.id; ok(R2b, 'driver linked by an assigned load can add for that truck');
ok((await as(D2, `delete from public.service_records where id = $1 returning id`, [R2b])).rows?.length === 1, 'driver deletes own fresh entry');

// Other companies / strangers.
ok((await as(O2, `select count(*)::int n from public.service_records`)).rows[0].n === 0, 'other company owner sees nothing');
ok((await as(X, `select count(*)::int n from public.service_records`)).rows[0].n === 0, 'stranger sees nothing');
ok((await add(X, T1, 5)).err, 'stranger cannot add');
ok(/load_not_allowed/.test((await add(O, T1, 5, { load: L9 })).err || ''), 'owner cannot link another company’s load');

// Load picker.
const choicesD = (await as(D, `select id from public.maint_load_choices($1)`, [T1])).rows.map((x) => x.id);
ok(choicesD.length === 1 && choicesD[0] === L1, 'driver picker: only his assigned load');
const choicesO = (await as(O, `select id from public.maint_load_choices($1)`, [T1])).rows.map((x) => x.id);
ok(choicesO[0] === L1 && choicesO.includes(L2) && !choicesO.includes(L9), 'owner picker: company loads, this truck first');
ok((await as(P, `select id from public.maint_load_choices($1)`, [T1])).rows.length === 0, 'dispatcher picker: empty (read only)');

// Receipts.
const doc = (await as(D, `insert into public.documents (user_id, doc_type, file_path, service_record_id) values ($1, 'receipt', 'd/r.jpg', $2) returning id, doc_type`, [D, R1]));
ok(/service_record_not_allowed/.test(doc.err || ''), 'driver cannot attach to the owner’s visit');
const own = await as(O, `insert into public.documents (user_id, doc_type, file_path, service_record_id) values ($1, 'receipt', 'o/r.jpg', $2) returning doc_type`, [O, R1]);
ok(own.rows?.[0]?.doc_type === 'maintenance_receipt', 'receipt gets doc_type maintenance_receipt');
ok((await as(P, `select count(*)::int n from public.documents where service_record_id = $1`, [R1])).rows[0].n === 1, 'dispatcher sees the receipt');
for (let i = 0; i < 9; i++) await as(O, `insert into public.documents (user_id, file_path, service_record_id) values ($1, $2, $3)`, [O, `o/${i}.jpg`, R1]);
ok(/too_many_receipts/.test((await as(O, `insert into public.documents (user_id, file_path, service_record_id) values ($1, 'o/x.jpg', $2)`, [O, R1])).err || ''), '11th receipt rejected');

// Manual odometer.
ok((await as(M, `select public.set_truck_odometer($1, 99000) t`, [T1])).rows?.[0]?.t, 'management sets odometer (can lower)');
ok((await sys(`select odometer, odometer_updated_at from public.trucks where id = $1`, [T1]))[0].odometer === 99000, 'odometer saved');
ok((await as(D, `select public.set_truck_odometer($1, 1) t`, [T1])).err, 'driver cannot set odometer');

// Grants.
const g = (await sys(`select has_table_privilege('anon','public.service_records','select') a, has_function_privilege('anon','public.maint_load_choices(uuid)','execute') f, has_function_privilege('authenticated','public.maint_load_choices(uuid)','execute') u`))[0];
ok(!g.a && !g.f && g.u, 'grants: authenticated only');
if (fails) console.error(`${fails} failed`); else console.log('all passed');
