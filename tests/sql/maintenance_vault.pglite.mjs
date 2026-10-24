// Migration 20261024000400 (maintenance vault) against PGlite (in-memory, WASM). LOCAL ONLY, fake TEST data.
// Run: npm i --no-save @electric-sql/pglite && node tests/sql/maintenance_vault.pglite.mjs
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
create function auth.role() returns text language sql stable as $$ select nullif(current_setting('request.jwt.claim.role', true), '')::text $$;
grant usage on schema auth to authenticated, anon; grant execute on function auth.uid() to authenticated, anon; grant execute on function auth.role() to authenticated, anon;
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
create policy documents_update_own on public.documents for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy documents_delete_own on public.documents for delete to authenticated using (user_id = auth.uid());
grant select, delete on public.documents to authenticated;
grant insert (user_id, load_id, truck_id, doc_type, file_path, original_filename) on public.documents to authenticated;
grant update (load_id, truck_id, doc_type) on public.documents to authenticated;
create table public.drivers (id uuid primary key default gen_random_uuid(), user_id uuid, name text, truck_id uuid, auth_user_id uuid, active boolean default true);
create schema storage;
create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text, owner uuid);
alter table storage.objects enable row level security;
create policy objects_own on storage.objects for select to authenticated using (split_part(name, '/', 1) = auth.uid()::text);
grant usage on schema storage to authenticated; grant select on storage.objects to authenticated;
`);
for (const f of ['20261015001200_company_profiles.sql', '20261023000100_maintenance_log.sql', '20261023000200_maintenance_log_fix.sql',
  '20261023000300_maintenance_schedules.sql']) await db.exec(readFileSync(R + f, 'utf8'));
const MIG = readFileSync(R + '20261024000400_maintenance_vault.sql', 'utf8');
ok(!/[^\x00-\x7F]/.test(MIG), 'vault migration is plain ASCII');
await db.exec(MIG);
await db.exec(MIG);
ok(true, 'vault migration applies twice');

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
const add = (uid, truck, path, name = 'TEST invoice.pdf', notes = null) =>
  as(uid, `select public.maint_vault_add($1, $2, $3, $4) v`, [truck, path, name, notes]);
const count = async (uid) => (await as(uid, `select public.maintenance_vault_count() n`)).rows[0].n;
const list = async (uid, truck = null, q = null) => (await as(uid, `select * from public.maint_vault_list($1, $2)`, [truck, q])).rows || [];

// Add.
let r = await add(O, T1, `${O}/maint/a.pdf`, 'TEST Joes Diesel WO.pdf');
ok(r.rows, 'owner adds a vault doc');
const A = r.rows[0].v;
r = await add(M, T1, `${M}/maint/b.jpg`, 'TEST photo.jpg', 'TEST left steer tire');
ok(r.rows, 'management adds a vault doc');
const B = r.rows[0].v;
r = await add(M, T2, `${M}/maint/c.pdf`);
const Cdoc = r.rows[0].v;
ok((await add(P, T1, `${P}/maint/x.pdf`)).err?.includes('vault_not_allowed'), 'dispatcher cannot add');
ok((await add(D, T1, `${D}/maint/x.pdf`)).err?.includes('vault_not_allowed'), 'driver cannot add');
ok((await add(X, T1, `${X}/maint/x.pdf`)).err?.includes('vault_not_allowed'), 'other company cannot add to T1');
ok((await add(O, TX, `${O}/maint/x.pdf`)).err?.includes('vault_not_allowed'), 'owner cannot add to another company truck');
ok((await add(M, T1, `${O}/maint/x.pdf`)).err?.includes('bad_file_path'), 'path must be in the caller folder');
r = await sys(`select doc_type, user_id, truck_id from public.documents where id = $1`, [A]);
ok(r[0].doc_type === 'maintenance_doc' && r[0].user_id === O && r[0].truck_id === T1, 'row stored as maintenance_doc for T1');
ok((await as(X, `select public.maint_vault_add($1,$2,$3,null)`, [TX, `${X}/m/x.pdf`, 'TEST X.pdf'])).rows, 'other company adds to its own truck');

// Direct client writes are blocked by the guard.
ok((await as(D, `insert into public.documents (user_id, truck_id, doc_type, file_path) values ($1, $2, 'maintenance_doc', $3)`, [D, T1, `${D}/x.pdf`])).err?.includes('vault_not_allowed'), 'driver direct insert of maintenance_doc blocked');
ok((await as(P, `insert into public.documents (user_id, truck_id, doc_type, file_path) values ($1, $2, 'bol', $3)`, [P, T1, `${P}/bol.pdf`])).rows, 'other doc types unaffected');
ok((await as(P, `update public.documents set doc_type = 'maintenance_doc' where user_id = $1`, [P])).err?.includes('vault_not_allowed'), 'dispatcher cannot retype own doc into the vault');
ok((await as(M, `update public.documents set truck_id = $2 where id = $1`, [B, TX])).err?.includes('vault_not_allowed'), 'cannot move a vault doc to another company truck');
ok((await as(M, `update public.documents set truck_id = $2 where id = $1 returning id`, [B, T2])).rows?.length === 1, 'management can move own upload between own trucks');
await sys(`update public.documents set truck_id = $2 where id = $1`, [B, T1]);
ok((await as(O, `select public.maint_vault_save($1, 'TEST Hacker', null, null, null, null)`, [id(888)])).err, 'save of unknown doc fails');

// Save details.
ok((await as(O, `select public.maint_vault_save($1, '  TEST Joe''s Diesel  ', '2026-09-14', 612.40, 401250, 'TEST PM-A', 'INVOICE 4471 OIL FILTER FUEL FILTER DEF', true)`, [A])).rows, 'owner saves details');
r = (await sys(`select maint_vendor v, maint_doc_date::text d, maint_total::text t, maint_odometer o, maint_text x, maint_scanned_at is not null s from public.documents where id = $1`, [A]))[0];
ok(r.v === "TEST Joe's Diesel" && r.d === '2026-09-14' && r.t === '612.40' && r.o === 401250 && r.s, 'details stored and trimmed');
ok((await as(M, `select public.maint_vault_save($1, 'TEST Joe''s Diesel', '2026-09-14', 612.40, 401250, 'TEST PM-A edited', null, false)`, [A])).rows, 'management edits');
ok((await sys(`select maint_text x from public.documents where id = $1`, [A]))[0].x.includes('OIL FILTER'), 'null text keeps scanned text');
ok((await as(D, `select public.maint_vault_save($1, 'x', null, null, null, null)`, [A])).err?.includes('vault_not_allowed'), 'driver cannot edit');
ok((await as(P, `select public.maint_vault_save($1, 'x', null, null, null, null)`, [A])).err?.includes('vault_not_allowed'), 'dispatcher cannot edit');
ok((await as(X, `select public.maint_vault_save($1, 'x', null, null, null, null)`, [A])).err?.includes('vault_not_allowed'), 'other company cannot edit');
ok((await as(O, `select public.maint_vault_save($1, null, null, -1, null, null)`, [A])).err, 'negative total rejected');
ok((await as(O, `update public.documents set maint_vendor = 'x' where id = $1`, [A])).err, 'maint_* columns not client-writable');

// Visibility and count.
ok(await count(O) === 3 && await count(M) === 3 && await count(P) === 3, 'owner / management / dispatcher count 3');
ok(await count(D) === 2, 'driver of T1 counts only T1 docs (2)');
ok(await count(D2) === 0, 'driver without a truck counts 0');
ok(await count(X) === 1, 'other company sees only its own (1)');
ok((await list(D)).every((d) => d.truck_id === T1) && (await list(D)).length === 2, 'driver lists only T1');
ok((await list(O, T2)).length === 1 && (await list(O, T2))[0].id === Cdoc, '?truck filter');
ok((await list(X, T1)).length === 0, 'other company cannot list T1');
ok((await as(D, `select id from public.documents where doc_type = 'maintenance_doc'`)).rows.length === 2, 'driver selects T1 vault rows through RLS');
ok((await as(X, `select id from public.documents where id = $1`, [A])).rows.length === 0, 'other company cannot select the row');
ok((await as(M, `select id from public.documents where id = $1`, [A])).rows.length === 1, 'management selects the owner upload');
const L = (await list(O)).find((d) => d.id === A);
ok(L.can_manage === true && L.scanned === true && L.unit_number === 'TEST-T1', 'list returns can_manage / scanned / unit');
ok((await list(D)).every((d) => d.can_manage === false), 'driver can_manage false');
const tr = (await as(D, `select * from public.maint_vault_trucks()`)).rows;
ok(tr.length === 1 && tr[0].id === T1 && tr[0].doc_count === 2, 'driver truck list is T1 only');
ok((await as(O, `select * from public.maint_vault_trucks()`)).rows.length === 2, 'owner truck list has both trucks');

// Storage.
await sys(`insert into storage.objects (bucket_id, name) values ('documents', $1), ('documents', $2), ('documents', $3)`, [`${O}/maint/a.pdf`, `${M}/maint/b.jpg`, `${M}/maint/c.pdf`]);
ok((await as(D, `select name from storage.objects`)).rows.length === 2, 'driver reads T1 files only');
ok((await as(X, `select name from storage.objects`)).rows.length === 0, 'other company reads no files');
ok((await as(P, `select name from storage.objects`)).rows.length === 3, 'dispatcher reads all company files');

// Search.
const q = async (s, uid = O) => (await list(uid, null, s)).map((d) => d.id).sort();
ok((await q('joe')).join() === A, 'search vendor');
ok((await q('2026-09-14')).join() === A && (await q('09/14/2026')).join() === A && (await q('9/14/2026')).join() === A, 'search date formats');
ok((await q('september')).join() === A, 'search month name');
ok((await q('fuel filter')).join() === A, 'search scanned text, all words');
ok((await q('steer')).join() === B, 'search notes');
ok((await q('photo')).join() === B, 'search file name');
ok((await q('joe steer')).length === 0, 'words are ANDed');
ok((await q('%')).length === 0 && (await q('_')).length === 0, 'wildcards are literal');
ok((await q('')).length === 3 && (await q(null)).length === 3, 'empty search lists all');
ok((await q('joe', X)).length === 0, 'search never crosses companies');

// Link to a visit.
r = await as(O, `insert into public.service_records (truck_id, service_date, odometer, vendor_name, total_cost, add_to_expenses) values ($1, '2026-09-14', 401250, 'TEST Joe''s Diesel', 612.40, false) returning id`, [T1]);
const V = r.rows[0].id;
const V2 = (await as(O, `insert into public.service_records (truck_id, service_date, total_cost, add_to_expenses) values ($1, '2026-09-01', 10, false) returning id`, [T2])).rows[0].id;
ok((await as(D, `select public.maint_vault_link($1, $2)`, [A, V])).err?.includes('vault_not_allowed'), 'driver cannot link');
ok((await as(O, `select public.maint_vault_link($1, $2)`, [A, V2])).err?.includes('record_other_truck'), 'cannot link to another truck visit');
ok((await as(M, `select public.maint_vault_link($1, $2)`, [A, V])).rows, 'management links to the visit');
r = (await sys(`select doc_type, service_record_id from public.documents where id = $1`, [A]))[0];
ok(r.doc_type === 'maintenance_doc' && r.service_record_id === V, 'linked doc keeps maintenance_doc');
ok((await list(O)).find((d) => d.id === A).service_date === '2026-09-14' || String((await list(O)).find((d) => d.id === A).service_date).startsWith('2026-09-14') || (await list(O)).find((d) => d.id === A).service_date instanceof Date, 'list shows the linked visit');
ok((await as(O, `insert into public.documents (user_id, truck_id, doc_type, file_path, service_record_id) values ($1, $2, 'maintenance_receipt', $3, $4) returning doc_type`, [O, T1, `${O}/r.jpg`, V])).rows?.[0]?.doc_type === 'maintenance_receipt', 'receipts still link');
ok((await sys(`select count(*)::int n from public.documents where service_record_id = $1`, [V]))[0].n === 2, 'visit has vault doc + receipt');
await as(O, `delete from public.service_records where id = $1`, [V]);
r = await sys(`select id, service_record_id from public.documents where id = $1`, [A]);
ok(r.length === 1 && r[0].service_record_id === null, 'deleting the visit keeps the vault doc, unlinked');
ok((await sys(`select count(*)::int n from public.documents where file_path = $1`, [`${O}/r.jpg`]))[0].n === 0, 'receipt still deleted with the visit');

// Delete.
ok((await as(D, `select public.maint_vault_delete($1)`, [B])).err?.includes('vault_not_allowed'), 'driver cannot delete');
ok((await as(P, `delete from public.documents where id = $1 returning id`, [B])).rows?.length === 0, 'dispatcher direct delete affects nothing');
r = await as(O, `select public.maint_vault_delete($1) p`, [B]);
ok(r.rows?.[0]?.p === `${M}/maint/b.jpg`, 'owner deletes a management upload and gets the path');
ok(await count(O) === 2, 'count after delete');

// Review fixes (Sam, #146).
r = await sys(`select indexdef from pg_indexes where schemaname = 'public' and indexname = 'documents_maint_file_path_idx'`);
ok(r.length === 1 && /\(file_path\)/.test(r[0].indexdef) && /maintenance_doc/.test(r[0].indexdef), 'partial file_path index for the storage policy');
// Receipt cap counts receipts only; a linked vault doc is neither counted nor capped.
const V3 = (await as(O, `insert into public.service_records (truck_id, service_date, total_cost, add_to_expenses) values ($1, '2026-10-01', 10, false) returning id`, [T1])).rows[0].id;
const VA = (await add(O, T1, `${O}/maint/cap-a.pdf`)).rows[0].v;
ok((await as(O, `select public.maint_vault_link($1, $2)`, [VA, V3])).rows, 'vault doc links to an empty visit');
for (let i = 0; i < 10; i++) await as(O, `insert into public.documents (user_id, truck_id, doc_type, file_path, service_record_id) values ($1, $2, 'maintenance_receipt', $3, $4)`, [O, T1, `${O}/cap-r${i}.jpg`, V3]);
ok((await sys(`select count(*)::int n from public.documents where service_record_id = $1 and doc_type = 'maintenance_receipt'`, [V3]))[0].n === 10, '10 receipts fit next to a linked vault doc');
ok((await as(O, `insert into public.documents (user_id, truck_id, doc_type, file_path, service_record_id) values ($1, $2, 'maintenance_receipt', $3, $4)`, [O, T1, `${O}/cap-r10.jpg`, V3])).err?.includes('too_many_receipts'), '11th receipt still blocked');
const VB = (await add(O, T1, `${O}/maint/cap-b.pdf`)).rows[0].v;
ok((await as(O, `select public.maint_vault_link($1, $2)`, [VB, V3])).rows, 'vault doc links to a visit that already has 10 receipts');
// Anon never gets the server bypass in the guard.
await db.exec(`grant select, insert on public.documents to anon; create policy documents_anon_test on public.documents for insert to anon with check (true)`);
await db.exec(`reset role; reset request.jwt.claim.sub; set request.jwt.claim.role = 'anon'; set role anon`);
let anonIns = null; try { await db.query(`insert into public.documents (user_id, truck_id, doc_type, file_path) values ($1, $2, 'maintenance_doc', 'anon/x.pdf')`, [O, T1]); } catch (e) { anonIns = e.message; }
await db.exec(`reset role; reset request.jwt.claim.role`);
await db.exec(`drop policy documents_anon_test on public.documents; revoke select, insert on public.documents from anon`);
ok(anonIns?.includes('vault_not_allowed'), 'anon insert of maintenance_doc blocked by the guard');
ok((await sys(`insert into public.documents (user_id, truck_id, doc_type, file_path) values ($1, $2, 'maintenance_doc', $3) returning id`, [O, T1, `${O}/maint/server.pdf`])).length === 1, 'server (no user, not anon) still bypasses');
// Company filter: a user with no company and no trucks sees nothing; the other company never sees TEST-T1.
const U = id(77); await sys(`insert into auth.users (id) values ('${U}')`);
ok(await count(U) === 0 && (await list(U)).length === 0, 'stranger sees no vault docs');
ok((await list(X)).every((d) => d.truck_id === TX) && (await list(X, T1)).length === 0, 'other company never sees TEST-T1 docs');
// Membership in a second company adds that company; the filter does not hide own trucks.
await sys(`insert into public.company_members (profile_id, user_id, role) values ('${C2}','${U}','management')`);
ok((await list(U)).every((d) => d.truck_id === TX), 'member of second company sees only that company');

// Grants.
await db.exec(`reset role; set role anon`);
let anonErr = null; try { await db.query(`select public.maintenance_vault_count()`); } catch (e) { anonErr = e.message; }
await db.exec('reset role');
ok(anonErr, 'anon cannot call maintenance_vault_count');
r = (await sys(`select pg_get_function_result('public.maintenance_vault_count()'::regprocedure) t`))[0].t;
ok(r === 'integer', 'maintenance_vault_count() returns integer');

console.log(fails ? `${fails} FAILED` : 'all passed');
