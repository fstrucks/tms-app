// Migrations 0600 + 0700 + 0800 together against an in-memory Postgres (PGlite, WASM). LOCAL ONLY: never touches Supabase.
// 0700 (dispatch center, applied on prod) lives on the #94 branch until it merges: set MIG_0700=<path to
// 20261018000700_dispatch_center.sql> if it isn't in the migrations folder yet.
// Run: npm i --no-save @electric-sql/pglite && MIG_0700=... node tests/sql/member_role_editor.pglite.mjs
import { PGlite } from '@electric-sql/pglite';
import { readFileSync, existsSync } from 'node:fs';
const db = new PGlite();
const R = process.env.MIG_DIR || new URL('../../supabase/migrations/', import.meta.url).pathname;
const M0700 = existsSync(R + '20261018000700_dispatch_center.sql') ? R + '20261018000700_dispatch_center.sql' : process.env.MIG_0700;
if (!M0700 || !existsSync(M0700)) { console.error('FAIL 0700 not found: set MIG_0700 to the dispatch center migration (from #94)'); process.exit(1); }
const ok = (c, m) => { if (!c) { console.error('FAIL', m); process.exitCode = 1; } else console.log('ok', m); };
await db.exec(`
create role anon; create role authenticated;
create schema auth;
create table auth.users (id uuid primary key, email text);
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
grant usage on schema auth to authenticated, anon; grant execute on function auth.uid() to authenticated, anon;
create table public.loads (id uuid primary key default gen_random_uuid(), user_id uuid not null, truck_id uuid, status text, broker_name text, broker_load_number text,
  rate numeric, rate_per_mile numeric, total_miles numeric, miles_source text, commodity text, weight int, equipment_type text, special_instructions text, notes text,
  route_geometry text, created_at timestamptz default now(), updated_at timestamptz default now());
create table public.stops (id serial primary key, load_id uuid references public.loads(id), stop_type text, sequence int, company_name text, address_line1 text,
  city text, state text, zip text, appointment_start timestamptz, timezone text, notes text, lat double precision, geocode_address text);
create table public.documents (id uuid primary key default gen_random_uuid(), user_id uuid, load_id uuid, doc_type text, file_path text);
grant usage on schema public to authenticated, anon;
`);
await db.exec(readFileSync(R + '20261010000400_loads.sql', 'utf8').split('-- documents.load_id')[0]);
await db.exec(`revoke update on public.loads from authenticated; grant update (user_id, truck_id, status, broker_name, broker_load_number, rate, commodity, weight, equipment_type, special_instructions, total_miles, notes, updated_at, miles_source) on public.loads to authenticated;`);
await db.exec(readFileSync(R + '20261015001200_company_profiles.sql', 'utf8'));
await db.exec(`grant select, insert, update, delete on public.company_profiles, public.company_members to authenticated;`);
await db.exec(readFileSync(R + '20261018000600_load_driver_rate_members.sql', 'utf8'));
await db.exec(readFileSync(M0700, 'utf8'));
const O = '00000000-0000-0000-0000-00000000000a', D = '00000000-0000-0000-0000-00000000000d', P = '00000000-0000-0000-0000-00000000000b',
  M = '00000000-0000-0000-0000-00000000000c', O2 = '00000000-0000-0000-0000-0000000000a2', D2 = '00000000-0000-0000-0000-0000000000d2', X = '00000000-0000-0000-0000-0000000000ee';
const C1 = '11111111-1111-1111-1111-111111111111', C2 = '22222222-2222-2222-2222-222222222222';
await db.exec(`insert into auth.users values ('${O}','owner@example.com'),('${D}','driver@example.com'),('${P}','dispatch@example.com'),('${M}','mgmt@example.com'),
  ('${O2}','owner2@example.com'),('${D2}','driver2@example.com'),('${X}','stranger@example.com');
insert into public.company_profiles (id, owner_id, legal_name) values ('${C1}','${O}','FAKE Co'),('${C2}','${O2}','OTHER FAKE Co');
insert into public.company_members values ('${C1}','${D}','driver'),('${C1}','${P}','dispatcher'),('${C1}','${M}','management'),('${C2}','${D2}','driver');`);
await db.exec(readFileSync(R + '20261018000800_member_role_editor.sql', 'utf8'));

const as = async (uid, sql) => { await db.exec(`reset role; select set_config('request.jwt.claim.sub', '${uid || ''}', false); set role authenticated;`); return (await db.query(sql)).rows; };
const err = async (uid, sql) => { try { await as(uid, sql); return null; } catch (e) { return e.message; } finally { await db.exec('reset role'); } };
const role = async (c, u) => (await db.query(`select role from public.company_members where profile_id='${c}' and user_id='${u}'`)).rows[0]?.role;

const r = await as(O, `select * from public.set_member_role('${D}', 'dispatcher')`); await db.exec('reset role');
ok(r[0].old_role === 'driver' && r[0].new_role === 'dispatcher' && r[0].unassigned_loads === 0 && await role(C1, D) === 'dispatcher', 'owner: driver → dispatcher (no loads assigned: 0 unassigned)');
await as(O, `select public.set_member_role('${P}', 'management')`); await db.exec('reset role');
ok(await role(C1, P) === 'management', 'owner: dispatcher → management');
await as(O, `select public.set_member_role('${M}', 'driver')`); await db.exec('reset role');
ok(await role(C1, M) === 'driver', 'owner: management → driver');
ok(/bad_role/.test(await err(O, `select public.set_member_role('${D}', 'owner')`)), 'cannot promote to owner');
ok(/bad_role/.test(await err(O, `select public.set_member_role('${D}', 'admin')`)), 'unknown role rejected');
ok(/bad_role/.test(await err(O, `select public.set_member_role('${D}', null)`)), 'null role rejected');
ok(/owner_locked/.test(await err(O, `select public.set_member_role('${O}', 'driver')`)), 'owner cannot demote themselves');
ok(/not_member/.test(await err(O, `select public.set_member_role('${D2}', 'management')`)), 'member of another company: not_member');
ok(/not_member/.test(await err(O, `select public.set_member_role('${X}', 'driver')`)), 'stranger: not_member');
ok(/not_owner/.test(await err(P, `select public.set_member_role('${D}', 'management')`)), 'management/dispatcher cannot change roles');
ok(/not_owner/.test(await err(D, `select public.set_member_role('${D}', 'management')`)), 'driver cannot promote themselves');
ok(/not_member/.test(await err(O2, `select public.set_member_role('${D}', 'driver')`)), 'another company’s owner can’t reach this company’s members (not_member)');
await db.exec(`insert into public.company_members values ('${C1}','${X}','owner')`);
ok(/owner_locked/.test(await err(O, `select public.set_member_role('${X}', 'driver')`)), 'any owner-role member is not editable (owner_locked)');
await db.exec(`delete from public.company_members where user_id='${X}'`);
ok(await role(C1, X) === undefined, 'a second owner-role row (not the profile owner) can be removed while the owner row remains');
ok(/not_signed_in/.test(await err(null, `select public.set_member_role('${D}', 'driver')`)), 'no session: not_signed_in');
ok(await role(C1, D) === 'dispatcher' && await role(C2, D2) === 'driver', 'rejected calls changed nothing');
// anon cannot execute
let anonErr = null; try { await db.exec(`set role anon; select public.set_member_role('${D}', 'driver')`); } catch (e) { anonErr = e.message; } finally { await db.exec('reset role'); }
ok(/permission denied/.test(anonErr || ''), 'anon: no execute');

// Guard trigger on every write path
ok(/last_owner/.test(await err(O, `update public.company_members set role='driver' where user_id='${O}'`)), 'direct update: owner row cannot be demoted');
ok(/last_owner/.test(await err(O, `delete from public.company_members where user_id='${O}'`)), 'direct delete: owner row cannot be removed');
let svc = null; try { await db.exec(`update public.company_members set role='management' where user_id='${O}'`); } catch (e) { svc = e.message; }
ok(/last_owner/.test(svc || ''), 'service role / superuser also blocked');
ok(await role(C1, O) === 'owner', 'owner row intact');
await as(O, `delete from public.company_members where user_id='${M}'`); await db.exec('reset role');
ok(await role(C1, M) === undefined, 'non-owner members can still be removed (invite cancel path)');
await db.exec(`delete from public.company_profiles where id='${C2}'`);
ok((await db.query(`select 1 from public.company_members where profile_id='${C2}'`)).rows.length === 0, 'deleting a company still cascades its member rows');
await db.exec(`insert into public.company_profiles (id, owner_id, legal_name) values ('${C2}','${O2}','OTHER FAKE Co')`);
let delUser = null; try { await db.exec(`delete from auth.users where id='${O2}'`); } catch (e) { delUser = e.message; }
ok(delUser === null && (await db.query(`select 1 from public.company_profiles where id='${C2}'`)).rows.length === 0, 'deleting the owner’s auth user still cascades');
// Own-row RLS untouched: policies on company tables are the original four + two
const pol = (await db.query(`select policyname from pg_policies where tablename in ('company_members','company_profiles') order by 1`)).rows.map((x) => x.policyname).join(',');
ok(pol === 'company_members_select,company_members_write,company_profiles_delete,company_profiles_insert,company_profiles_select,company_profiles_update', 'policies unchanged');

// ---------- Driver unassignment (Taylor's bug) + 0700's unchanged-driver skip, with 0600 + 0700 + 0800 together ----------
const D3 = '00000000-0000-0000-0000-0000000000d3', D4 = '00000000-0000-0000-0000-0000000000d4', D5 = '00000000-0000-0000-0000-0000000000d5';
const L1 = 'aaaaaaaa-0000-0000-0000-000000000001', L2 = 'aaaaaaaa-0000-0000-0000-000000000002', L3 = 'aaaaaaaa-0000-0000-0000-000000000003', L4 = 'aaaaaaaa-0000-0000-0000-000000000004', XL = 'aaaaaaaa-0000-0000-0000-0000000000ff';
await db.exec(`reset role; insert into auth.users values ('${D3}','driver3@example.com'),('${D4}','driver4@example.com'),('${D5}','driver5@example.com'),('${O2}','owner2b@example.com') on conflict do nothing;
insert into public.company_profiles (id, owner_id, legal_name) values ('${C2}','${O2}','OTHER FAKE Co') on conflict do nothing;
insert into public.company_members values ('${C1}','${D3}','driver'),('${C1}','${D4}','driver'),('${C1}','${D5}','driver'),('${C2}','${D3}','driver') on conflict do nothing;
insert into public.loads (id, user_id, status, rate, total_miles, assigned_driver_user_id, show_rate_to_driver) values
 ('${L1}','${O}','booked',1800,720,'${D3}',true), ('${L2}','${O}','delivered',900,600,'${D3}',false), ('${L3}','${O}','booked',700,350,'${D4}',true),
 ('${L4}','${O}','booked',500,250,'${D5}',false), ('${XL}','${O2}','booked',5000,1000,'${D3}',true);`);
const load = async (id) => { await db.exec('reset role'); return (await db.query(`select assigned_driver_user_id as d, show_rate_to_driver as s, notes from public.loads where id='${id}'`)).rows[0]; };

ok((await as(O, `select public.member_assigned_load_count('${D3}') as n`))[0].n === 2, 'count for the confirmation: 2 of this company’s loads (other company’s load not counted)');
await db.exec('reset role');
ok(/not_owner/.test(await err(P, `select public.member_assigned_load_count('${D3}')`)), 'count: management/dispatcher refused');
ok(/not_member/.test(await err(O, `select public.member_assigned_load_count('${X}')`)), 'count: non-member refused');
let anonCount = null; try { await db.exec(`set role anon; select public.member_assigned_load_count('${D3}')`); } catch (e) { anonCount = e.message; } finally { await db.exec('reset role'); }
ok(/permission denied/.test(anonCount || ''), 'count: anon has no execute');

const u = await as(O, `select * from public.set_member_role('${D3}', 'dispatcher')`); await db.exec('reset role');
ok(u[0].unassigned_loads === 2, 'driver → dispatcher returns 2 loads unassigned');
const l1 = await load(L1), l2 = await load(L2);
ok(l1.d === null && l1.s === false && l2.d === null && l2.s === false, 'their loads (active and past): driver null, show rate off');
ok((await load(XL)).d === D3 && (await load(XL)).s === true, 'another company’s load is untouched (still a driver there)');
ok((await load(L3)).d === D4, 'other drivers’ loads untouched');
ok((await as(P, `select public.dispatch_update_load('${L1}', '{"notes":"after the role change"}'::jsonb)`)) && (await load(L1)).notes === 'after the role change', 'dispatcher can save the formerly-assigned load');
await db.exec('reset role');
await as(O, `select public.set_load_driver_settings('${L1}', '${D4}', true)`); await db.exec('reset role');
ok((await load(L1)).d === D4, 'owner can assign a real driver to it again');
const z = await as(O, `select * from public.set_member_role('${P}', 'dispatcher')`); await db.exec('reset role');
ok(z[0].unassigned_loads === 0, 'management → dispatcher: 0 unassigned (wasn’t a driver)');

// Pre-0800 data: D5 demoted outside the editor, still assigned to L4. 0700's guard skips unchanged drivers.
await db.exec(`update public.company_members set role='management' where profile_id='${C1}' and user_id='${D5}'`);
ok(!(await err(P, `select public.dispatch_update_load('${L4}', '{"notes":"stale driver, unchanged"}'::jsonb)`)), '0700: dispatch save with the stale driver unchanged succeeds');
ok(!(await err(P, `select public.dispatch_update_load('${L4}', '{"assigned_driver_user_id":"${D5}"}'::jsonb)`)), '0700: re-sending the same stale driver succeeds');
ok(!(await err(O, `select public.set_load_driver_settings('${L4}', '${D5}', true)`)), '0600 owner Driver card: same stale driver + toggle show succeeds');
ok(!(await err(O, `update public.loads set notes='owner edit' where id='${L4}'`)), 'owner own-row edit of another field succeeds');
ok(/assigned_driver_not_driver/.test(await err(O, `select public.set_load_driver_settings('${L3}', '${D5}', false)`) || ''), 'guard still blocks NEWLY assigning a non-driver');
ok(/assigned_driver_not_driver/.test(await err(P, `select public.dispatch_update_load('${L3}', '{"assigned_driver_user_id":"${M}"}'::jsonb)`) || ''), 'guard still blocks it through the dispatch RPC');
console.log(process.exitCode ? 'FAILED' : 'all passed');
