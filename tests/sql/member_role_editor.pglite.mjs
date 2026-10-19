// Migration 20261018000800 against an in-memory Postgres (PGlite, WASM). LOCAL ONLY: never touches Supabase.
// Run: npm i --no-save @electric-sql/pglite && node tests/sql/member_role_editor.pglite.mjs
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
const db = new PGlite();
const R = process.env.MIG_DIR || new URL('../../supabase/migrations/', import.meta.url).pathname;
const ok = (c, m) => { if (!c) { console.error('FAIL', m); process.exitCode = 1; } else console.log('ok', m); };
await db.exec(`
create role anon; create role authenticated;
create schema auth;
create table auth.users (id uuid primary key, email text);
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
grant usage on schema auth to authenticated, anon; grant execute on function auth.uid() to authenticated, anon;
grant usage on schema public to authenticated, anon;
`);
await db.exec(readFileSync(R + '20261015001200_company_profiles.sql', 'utf8'));
await db.exec(`grant select, insert, update, delete on public.company_profiles, public.company_members to authenticated;`);
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
ok(r[0].old_role === 'driver' && r[0].new_role === 'dispatcher' && await role(C1, D) === 'dispatcher', 'owner: driver → dispatcher');
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
console.log(process.exitCode ? 'FAILED' : 'all passed');
