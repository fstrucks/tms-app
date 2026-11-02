// 20261102000100_facility_rating_prompts.sql against an in-memory Postgres (PGlite, WASM). LOCAL ONLY: never touches Supabase.
// Run: MIG_DIR=<repo>/supabase/migrations/ node tests/sql/facility_rating_prompts.pglite.mjs  (fake data only)
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
const db = new PGlite();
const R = process.env.MIG_DIR || new URL('../../supabase/migrations/', import.meta.url).pathname;
const ok = (c, m) => { if (!c) { console.error('FAIL', m); process.exitCode = 1; } else console.log('ok', m); };
await db.exec(`
create role anon; create role authenticated; create role service_role bypassrls;
create schema auth;
create table auth.users (id uuid primary key);
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
grant usage on schema auth to authenticated, anon, service_role; grant execute on function auth.uid() to authenticated, anon;
grant usage on schema public to authenticated, anon, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
create table public.loads (id uuid primary key, user_id uuid);
create table public.stops (id uuid primary key, load_id uuid references public.loads(id) on delete cascade);
create table public.facilities (id uuid primary key);`);
const mig = readFileSync(R + '20261102000100_facility_rating_prompts.sql', 'utf8');
await db.exec(mig); await db.exec(mig);
ok(true, 'migration applies twice (idempotent)');

const A = '00000000-0000-0000-0000-00000000000a', B = '00000000-0000-0000-0000-00000000000b';
const L = '10000000-0000-0000-0000-000000000001', S1 = '20000000-0000-0000-0000-000000000001', S2 = '20000000-0000-0000-0000-000000000002', F = '30000000-0000-0000-0000-000000000001';
await db.exec(`insert into auth.users values ('${A}'),('${B}'); insert into public.loads values ('${L}','${A}');
  insert into public.stops values ('${S1}','${L}'),('${S2}','${L}'); insert into public.facilities values ('${F}');`);
const as = async (role, sql, uid = A) => { await db.exec(`reset role; select set_config('request.jwt.claim.sub', '${uid}', false); set role ${role};`); try { return await db.query(sql); } finally { await db.exec('reset role'); } };
const err = async (role, sql, uid) => { try { await as(role, sql, uid); return null; } catch (e) { return e.message; } };
const row = (u, s, kind = 'pickup', extra = '') => `insert into public.facility_rating_prompts (user_id, load_id, stop_id, facility_id, kind, remind_at${extra ? ', status' : ''}) values ('${u}','${L}','${s}','${F}','${kind}', now()${extra ? `, '${extra}'` : ''})`;

ok((await as('service_role', row(A, S1))).affectedRows === 1, 'service_role inserts a prompt');
ok((await as('service_role', row(B, S1))).affectedRows === 1, 'service_role inserts B prompt');
ok(/duplicate key|unique/.test(await err('service_role', row(A, S1)) || ''), 'unique (user_id, stop_id, kind)');
ok((await as('service_role', `${row(A, S1)} on conflict (user_id, stop_id, kind) do nothing`)).affectedRows === 0, 'on conflict do nothing is a no-op');
ok(/check constraint/.test(await err('service_role', row(A, S2, 'stop')) || ''), 'kind check');
ok(/check constraint/.test(await err('service_role', row(A, S2, 'pickup', 'shown')) || ''), 'status check');
ok((await as('service_role', `select status, timezone from public.facility_rating_prompts where user_id='${A}'`)).rows[0]?.status === 'pending', 'default status pending');
ok((await as('service_role', `select timezone from public.facility_rating_prompts where user_id='${A}'`)).rows[0]?.timezone === 'America/Chicago', 'default timezone America/Chicago');
ok((await as('service_role', `insert into public.facility_rating_mutes (user_id, facility_id) values ('${A}','${F}')`)).affectedRows === 1, 'service_role inserts a mute');
ok((await as('service_role', `update public.facility_rating_prompts set status='reminded', reminded_at=now() where user_id='${A}'`)).affectedRows === 1, 'service_role updates');

ok((await as('authenticated', 'select user_id from public.facility_rating_prompts')).rows.every((r) => r.user_id === A), 'A reads only own prompts');
ok((await as('authenticated', 'select * from public.facility_rating_prompts')).rows.length === 1, 'A sees exactly 1 row');
ok((await as('authenticated', 'select * from public.facility_rating_mutes', B)).rows.length === 0, 'B sees no mutes of A');
ok((await as('authenticated', 'select * from public.facility_rating_mutes')).rows.length === 1, 'A sees own mute');
for (const t of ['facility_rating_prompts', 'facility_rating_mutes']) {
  ok(/permission denied/.test(await err('authenticated', `delete from public.${t}`) || ''), `authenticated cannot delete ${t}`);
  ok(/permission denied/.test(await err('authenticated', `update public.${t} set created_at = now()`) || ''), `authenticated cannot update ${t}`);
  ok(/permission denied/.test(await err('anon', `select * from public.${t}`) || ''), `anon cannot read ${t}`);
}
ok(/permission denied/.test(await err('authenticated', row(A, S2)) || ''), 'authenticated cannot insert prompts');
ok(/permission denied/.test(await err('authenticated', `insert into public.facility_rating_mutes (user_id, facility_id) values ('${A}','${F}')`) || ''), 'authenticated cannot insert mutes');
ok((await db.query(`select count(*)::int n from pg_proc where proname like 'facility_prompt%'`)).rows[0].n === 0, 'no functions added (nothing to grant)');
await db.exec(`delete from public.stops where id='${S1}'`);
ok((await db.query('select count(*)::int n from public.facility_rating_prompts')).rows[0].n === 0, 'stop delete cascades');
