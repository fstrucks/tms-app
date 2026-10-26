// 20261026000100_company_reply_to.sql against an in-memory Postgres (PGlite, WASM). LOCAL ONLY: never touches Supabase.
// Run: MIG_DIR=<repo>/supabase/migrations/ node tests/sql/company_reply_to.pglite.mjs  (fake data only)
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
const db = new PGlite();
const R = process.env.MIG_DIR || new URL('../../supabase/migrations/', import.meta.url).pathname;
const ok = (c, m) => { if (!c) { console.error('FAIL', m); process.exitCode = 1; } else console.log('ok', m); };
await db.exec(`
create role anon; create role authenticated; create schema auth;
create table auth.users (id uuid primary key, email text);
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
grant usage on schema auth to authenticated, anon; grant execute on function auth.uid() to authenticated, anon;
grant usage on schema public to authenticated, anon;`);
await db.exec(readFileSync(R + '20261015001200_company_profiles.sql', 'utf8'));
await db.exec(`grant select, insert, update, delete on public.company_profiles, public.company_members to authenticated;`);
const O = '00000000-0000-0000-0000-00000000000a', D = '00000000-0000-0000-0000-00000000000d', P = '00000000-0000-0000-0000-00000000000b',
  M = '00000000-0000-0000-0000-00000000000c', O2 = '00000000-0000-0000-0000-0000000000a2';
const C1 = '11111111-1111-1111-1111-111111111111', C2 = '22222222-2222-2222-2222-222222222222';
await db.exec(`insert into auth.users values ('${O}','o@example.com'),('${D}','d@example.com'),('${P}','p@example.com'),('${M}','m@example.com'),('${O2}','o2@example.com');
insert into public.company_profiles (id, owner_id, legal_name) values ('${C1}','${O}','FAKE Co'),('${C2}','${O2}','OTHER FAKE Co');
insert into public.company_members values ('${C1}','${D}','driver'),('${C1}','${P}','dispatcher'),('${C1}','${M}','management');`);
const mig = readFileSync(R + '20261026000100_company_reply_to.sql', 'utf8');
await db.exec(mig); await db.exec(mig);
ok(true, 'migration applies twice (idempotent)');
const col = (await db.query(`select is_nullable, column_default from information_schema.columns where table_name='company_profiles' and column_name='reply_to_email'`)).rows[0];
ok(col?.is_nullable === 'YES' && col.column_default == null, 'nullable, no default');
ok((await db.query(`select count(*)::int n from pg_constraint where conname='company_profiles_reply_to_email_shape'`)).rows[0].n === 1, 'one shape check (not duplicated)');
ok((await db.query(`select count(*)::int n from public.company_profiles where reply_to_email is not null`)).rows[0].n === 0, 'no backfill');

const as = async (uid, sql) => { await db.exec(`reset role; select set_config('request.jwt.claim.sub', '${uid}', false); set role authenticated;`); try { return await db.query(sql); } finally { await db.exec('reset role'); } };
const err = async (uid, sql) => { try { await as(uid, sql); return null; } catch (e) { return e.message; } };
const val = async () => (await db.query(`select reply_to_email v from public.company_profiles where id='${C1}'`)).rows[0].v;
const upd = (uid, v) => as(uid, `update public.company_profiles set reply_to_email = ${v === null ? 'null' : `'${v}'`} where id='${C1}'`);

ok((await upd(O, 'office@fake-test.com')).affectedRows === 1 && await val() === 'office@fake-test.com', 'owner sets it');
ok((await upd(M, 'mgmt@fake-test.com')).affectedRows === 1 && await val() === 'mgmt@fake-test.com', 'management sets it (existing update policy)');
ok((await upd(P, 'disp@fake-test.com')).affectedRows === 1 && await val() === 'disp@fake-test.com', 'dispatcher sets it (same editors as the rest of the profile)');
ok((await upd(D, 'driver@fake-test.com')).affectedRows === 0 && await val() === 'disp@fake-test.com', 'driver cannot change it (0 rows)');
ok((await upd(O2, 'x@fake-test.com')).affectedRows === 0 && await val() === 'disp@fake-test.com', 'another company’s owner cannot change it');
ok((await as(D, `select reply_to_email from public.company_profiles where id='${C1}'`)).rows[0]?.reply_to_email === 'disp@fake-test.com', 'members can read it');
for (const bad of ['not an email', 'a@b', '@fake-test.com', 'a b@fake-test.com', 'a@@fake-test.com', 'x'.repeat(250) + '@f.com'])
  ok(/company_profiles_reply_to_email_shape/.test(await err(O, `update public.company_profiles set reply_to_email='${bad}' where id='${C1}'`)), `shape check rejects ${bad.slice(0, 20)}`);
ok((await upd(O, null)).affectedRows === 1 && await val() === null, 'owner clears it (null allowed)');
if (!process.exitCode) console.log('all passed');
