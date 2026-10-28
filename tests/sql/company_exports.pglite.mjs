// 20261028000400_company_exports.sql against an in-memory Postgres (PGlite, WASM). LOCAL ONLY: never touches Supabase.
// Run: MIG_DIR=<repo>/supabase/migrations/ node tests/sql/company_exports.pglite.mjs  (fake data only)
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
const db = new PGlite();
const R = process.env.MIG_DIR || new URL('../../supabase/migrations/', import.meta.url).pathname;
const ok = (c, m) => { if (!c) { console.error('FAIL', m); process.exitCode = 1; } else console.log('ok', m); };
// Supabase-like setup, including its default grants on new public tables (so the migration's revokes matter).
await db.exec(`
create role anon; create role authenticated; create role service_role bypassrls;
create schema auth; create schema storage;
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
grant usage on schema auth to authenticated, anon; grant execute on function auth.uid() to authenticated, anon;
grant usage on schema public to authenticated, anon, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
create table storage.buckets (id text primary key, name text not null, public boolean default false, file_size_limit bigint, allowed_mime_types text[]);
create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text);
alter table storage.objects enable row level security;`);
const mig = readFileSync(R + '20261028000400_company_exports.sql', 'utf8');
await db.exec(mig); await db.exec(mig);
ok(true, 'migration applies twice (idempotent)');

const U = '00000000-0000-0000-0000-00000000000a', C = '11111111-1111-1111-1111-111111111111';
const H = 'a'.repeat(64);
const as = async (role, sql, uid = U) => { await db.exec(`reset role; select set_config('request.jwt.claim.sub', '${uid}', false); set role ${role};`); try { return await db.query(sql); } finally { await db.exec('reset role'); } };
const err = async (role, sql) => { try { await as(role, sql); return null; } catch (e) { return e.message; } };

const ins = `insert into public.export_jobs (company_profile_id, owner_id, requested_by, token_hash) values ('${C}','${U}','${U}','${H}') returning id`;
const job = (await as('service_role', ins)).rows[0]?.id;
ok(!!job, 'service_role inserts a job');
ok((await as('service_role', `select status, trigger, cursor, parts from public.export_jobs where id='${job}'`)).rows[0]?.status === 'queued', 'defaults: queued');
ok((await as('service_role', `insert into public.export_link_events (job_id, kind) values ('${job}','email_sent') returning id`)).rows.length === 1, 'service_role inserts a link event');
ok((await as('service_role', `update public.export_jobs set status='ready', token_hash=null, cleaned_at=now() where id='${job}'`)).affectedRows === 1, 'service_role updates (cleanup clears token)');

for (const role of ['anon', 'authenticated']) {
  for (const t of ['export_jobs', 'export_link_events']) {
    ok(/permission denied/.test(await err(role, `select * from public.${t}`) || ''), `${role} cannot read ${t}`);
    ok(/permission denied/.test(await err(role, `delete from public.${t}`) || ''), `${role} cannot delete ${t}`);
  }
  ok(/permission denied/.test(await err(role, ins) || ''), `${role} cannot insert a job`);
  ok(/permission denied/.test(await err(role, `insert into public.export_link_events (job_id, kind) values ('${job}','url_minted')`) || ''), `${role} cannot insert a link event`);
  ok(/permission denied/.test(await err(role, `update public.export_jobs set status='failed'`) || ''), `${role} cannot update jobs`);
}
ok((await db.query(`select count(*)::int n from pg_class where relname in ('export_jobs','export_link_events') and relrowsecurity`)).rows[0].n === 2, 'RLS enabled on both');
ok((await db.query(`select count(*)::int n from pg_policies where tablename in ('export_jobs','export_link_events')`)).rows[0].n === 0, 'no client policies');

// Constraints
const bad = async (vals, re, m) => ok(re.test(await err('service_role', `insert into public.export_jobs (company_profile_id, owner_id, requested_by, ${vals[0]}) values ('${C}','${U}', ${vals[1]})`) || ''), m);
await bad(['status', `'${U}','done'`], /export_jobs_status_check/, 'status check');
await bad(['trigger', `'${U}','auto'`], /export_jobs_trigger_check/, 'trigger check');
await bad(['token_hash', `'${U}','not-a-hash'`], /export_jobs_token_hash_shape/, 'token hash must be hex sha256');
await bad(['status', `'00000000-0000-0000-0000-0000000000ff','queued'`], /export_jobs_owner_only/, 'requested_by must be the owner');
ok(/export_link_events_kind_check/.test(await err('service_role', `insert into public.export_link_events (job_id, kind) values ('${job}','x')`) || ''), 'event kind check');

// One open job per company; a finished one doesn't block a new one.
const j2 = (await as('service_role', `insert into public.export_jobs (company_profile_id, owner_id, requested_by) values ('${C}','${U}','${U}') returning id`)).rows[0].id;
ok(/export_jobs_one_open_per_company/.test(await err('service_role', `insert into public.export_jobs (company_profile_id, owner_id, requested_by, status) values ('${C}','${U}','${U}','running')`) || ''), 'second open job for the company is refused');
ok((await db.query(`select count(*)::int n from pg_indexes where indexname='export_jobs_token_hash_key'`)).rows[0].n === 1, 'token_hash unique index');
ok((await as('service_role', `delete from public.export_jobs where id='${j2}'`)).affectedRows === 1, 'service_role deletes');
ok((await as('service_role', `delete from public.export_jobs where id='${job}'`)).affectedRows === 1 && (await db.query(`select count(*)::int n from public.export_link_events`)).rows[0].n === 0, 'events cascade with the job');

// Bucket
const b = (await db.query(`select * from storage.buckets where id='company-exports'`)).rows;
ok(b.length === 1 && b[0].public === false && Number(b[0].file_size_limit) === 524288000 && b[0].allowed_mime_types.join() === 'application/zip', 'private bucket, 500 MB, zip only');
await db.exec(`update storage.buckets set public = true where id='company-exports'`); await db.exec(mig);
ok((await db.query(`select public from storage.buckets where id='company-exports'`)).rows[0].public === false, 're-run forces the bucket back to private');
ok((await db.query(`select count(*)::int n from pg_policies where schemaname='storage'`)).rows[0].n === 0, 'no storage.objects policies added');
if (!process.exitCode) console.log('all passed');
