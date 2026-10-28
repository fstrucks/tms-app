// 20261018000100_bug_reports.sql then 20261028000300_bug_reports_profile.sql against an in-memory Postgres (PGlite, WASM).
// LOCAL ONLY: never touches Supabase. Run: MIG_DIR=<repo>/supabase/migrations/ node tests/sql/bug_reports_profile.pglite.mjs (fake data only)
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
await db.exec(readFileSync(R + '20261018000100_bug_reports.sql', 'utf8'));
const OA = '00000000-0000-0000-0000-0000000000a1', OB = '00000000-0000-0000-0000-0000000000b1',
  DUAL = '00000000-0000-0000-0000-0000000000d1', LATE = '00000000-0000-0000-0000-0000000000e1', X = '00000000-0000-0000-0000-0000000000f1';
const PA = '11111111-1111-1111-1111-111111111111', PB = '22222222-2222-2222-2222-222222222222', PC = '33333333-3333-3333-3333-333333333333';
await db.exec(`insert into auth.users values ('${OA}','oa@example.com'),('${OB}','ob@example.com'),('${DUAL}','d@example.com'),('${LATE}','l@example.com'),('${X}','x@example.com');
insert into public.company_profiles (id, owner_id, legal_name) values ('${PA}','${OA}','FAKE A'),('${PB}','${OB}','FAKE B'),('${PC}','${X}','FAKE C');
insert into public.company_members (profile_id, user_id, role) values ('${PA}','${DUAL}','driver'),('${PB}','${DUAL}','driver'),('${PB}','${LATE}','driver');
-- a report saved before the new migration (no profile_id column yet)
insert into public.bug_reports (user_id, what_happened) values ('${DUAL}','legacy report');`);
const mig = readFileSync(R + '20261028000300_bug_reports_profile.sql', 'utf8');
await db.exec(mig); await db.exec(mig);
ok(true, 'applies after 20261018000100, twice (idempotent)');
const col = (await db.query(`select is_nullable from information_schema.columns where table_name='bug_reports' and column_name='profile_id'`)).rows[0];
ok(col?.is_nullable === 'YES', 'profile_id nullable');
ok((await db.query(`select confdeltype from pg_constraint where conrelid='public.bug_reports'::regclass and contype='f' and conkey = array[(select attnum from pg_attribute where attrelid='public.bug_reports'::regclass and attname='profile_id')]::int2[]`)).rows.map((r) => r.confdeltype).join() === 'n', 'one FK to company_profiles, on delete set null');
ok((await db.query(`select profile_id from public.bug_reports where what_happened='legacy report'`)).rows[0].profile_id === null, 'old rows: profile_id null (no backfill)');
ok((await db.query(`select count(*)::int n from pg_policies where tablename='bug_reports' and policyname='bug_reports_insert_own'`)).rows[0].n === 1, 'one insert policy');

const as = async (uid, sql) => { await db.exec(`reset role; select set_config('request.jwt.claim.sub', '${uid}', false); set role authenticated;`); try { return await db.query(sql); } finally { await db.exec('reset role'); } };
const err = async (uid, sql) => { try { await as(uid, sql); return null; } catch (e) { return e.message; } };
const ins = (uid, what, pid, extra = '') => `insert into public.bug_reports (user_id, what_happened, profile_id${extra ? ', status' : ''}) values ('${uid}', '${what}', ${pid ? `'${pid}'` : 'null'}${extra ? `, '${extra}'` : ''})`;

ok(await err(DUAL, ins(DUAL, 'dual under A', PA)) === null, 'member inserts with their company profile_id (A)');
ok(await err(DUAL, ins(DUAL, 'dual under B', PB)) === null, 'two-company user inserts under B');
ok(await err(LATE, ins(LATE, 'late old report', PB)) === null, 'later joiner files a report under B (before joining A)');
ok(await err(OA, ins(OA, 'owner own', PA)) === null, 'owner inserts under own company');
ok((await as(DUAL, `select profile_id from public.bug_reports where what_happened='dual under A'`)).rows[0]?.profile_id === PA, 'profile_id is stored as set on insert');
ok(/row-level security/.test(await err(DUAL, ins(DUAL, 'wrong co', PC)) || ''), 'cannot file under a company you do not belong to');
ok(/row-level security/.test(await err(DUAL, ins(OA, 'spoof', PA)) || ''), 'cannot insert as another user');
for (const s of ['seen', 'fixed', 'wont_fix']) ok(/row-level security/.test(await err(DUAL, ins(DUAL, 'st', PA, s)) || ''), `status '${s}' on insert rejected`);
ok(await err(DUAL, ins(DUAL, 'explicit new', PA, 'new')) === null, "status 'new' accepted");
ok(/permission denied/.test(await err(DUAL, `update public.bug_reports set status='fixed'`) || ''), 'users still cannot update');

const mine = async (uid) => (await as(uid, `select what_happened w from public.bug_reports order by w`)).rows.map((r) => r.w);
ok((await mine(LATE)).join() === 'late old report', 'a user reads only their own reports');
ok(!(await mine(OA)).includes('dual under A'), 'owners do not read members’ rows directly (server lists them)');

// Later: LATE joins company A. Owner view = service read filtered by profile_id (bugReportsAdmin.js).
await db.exec(`insert into public.company_members (profile_id, user_id, role) values ('${PA}','${LATE}','driver')`);
const ownerList = async (pid) => (await db.query(`select what_happened w from public.bug_reports where profile_id = '${pid}' order by w`)).rows.map((r) => r.w);
const a = await ownerList(PA), b = await ownerList(PB);
ok(a.join() === 'dual under A,explicit new,owner own', 'owner A sees only profile_id A reports');
ok(!a.includes('dual under B') && b.includes('dual under B'), 'two-company user’s B report is not visible to owner A');
ok(!a.includes('late old report'), 'later joiner does not expose older reports to the new company');
ok(!a.includes('legacy report') && !b.includes('legacy report'), 'null profile_id rows show to no owner');
await db.exec(`delete from public.company_profiles where id='${PB}'`);
ok((await db.query(`select count(*)::int n from public.bug_reports where what_happened in ('dual under B','late old report') and profile_id is null`)).rows[0].n === 2, 'company deleted → report kept, profile_id null');
if (!process.exitCode) console.log('all passed');
