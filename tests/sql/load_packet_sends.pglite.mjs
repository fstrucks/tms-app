// Migration 20261025000200 (load_packet_sends) against an in-memory Postgres (PGlite, WASM). LOCAL ONLY: never touches Supabase.
// Run: npm i --no-save @electric-sql/pglite && node tests/sql/load_packet_sends.pglite.mjs
// Fake data only.
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
const db = new PGlite();
const R = process.env.MIG_DIR || new URL('../../supabase/migrations/', import.meta.url).pathname;
const ok = (c, m) => { if (!c) { console.error('FAIL', m); process.exitCode = 1; } else console.log('ok', m); };
await db.exec(`
create role anon; create role authenticated; create role service_role bypassrls; -- as in Supabase
create schema auth;
create table auth.users (id uuid primary key, email text);
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
grant usage on schema auth to authenticated, anon; grant execute on function auth.uid() to authenticated, anon;
create table public.loads (id uuid primary key default gen_random_uuid(), user_id uuid not null, status text, broker_name text, broker_load_number text, rate numeric);
create table public.invoices (id uuid primary key default gen_random_uuid(), owner_id uuid not null, load_id uuid);
grant usage on schema public to authenticated, anon;
`);
await db.exec(readFileSync(R + '20261015001200_company_profiles.sql', 'utf8'));
// packet_role exactly as 20261015001300 defines it (that file needs tables this test does not stand up)
const inbound = readFileSync(R + '20261015001300_packets_inbound.sql', 'utf8');
await db.exec(/create or replace function public\.packet_role[\s\S]*?\$\$;\n/.exec(inbound)[0]);
const O = '00000000-0000-0000-0000-00000000000a', D = '00000000-0000-0000-0000-00000000000d', P = '00000000-0000-0000-0000-00000000000b',
  M = '00000000-0000-0000-0000-00000000000c', O2 = '00000000-0000-0000-0000-0000000000a2';
const C1 = '11111111-1111-1111-1111-111111111111', C2 = '22222222-2222-2222-2222-222222222222';
const L1 = '33333333-3333-3333-3333-333333333331', LX = '33333333-3333-3333-3333-333333333339', I1 = '44444444-4444-4444-4444-444444444441';
await db.exec(`insert into auth.users values ('${O}','owner@example.com'),('${D}','driver@example.com'),('${P}','dispatch@example.com'),('${M}','mgmt@example.com'),('${O2}','owner2@example.com');
insert into public.company_profiles (id, owner_id, legal_name) values ('${C1}','${O}','FAKE Trucking LLC'),('${C2}','${O2}','OTHER FAKE Co');
insert into public.company_members values ('${C1}','${D}','driver'),('${C1}','${P}','dispatcher'),('${C1}','${M}','management');
insert into public.loads (id, user_id, status, broker_load_number) values ('${L1}','${O}','delivered','TEST-1001'),('${LX}','${O2}','delivered','OTHER-1');
insert into public.invoices (id, owner_id, load_id) values ('${I1}','${O}','${L1}');`);
const MIG = readFileSync(R + '20261025000200_load_packet_sends.sql', 'utf8');
await db.exec(MIG);
await db.exec(MIG); // idempotent

// server (table owner here; service_role in Supabase) writes
await db.exec(`insert into public.load_packet_sends (owner_id, load_id, sent_by, to_emails, with_invoice, invoice_id, note, size_bytes)
  values ('${O}','${L1}','${P}','{qa@fstrucks.com}', true, '${I1}', 'FAKE note', 12345),
         ('${O2}','${LX}','${O2}','{qa2@example.com}', false, null, null, 100);`);
await db.exec(`set role service_role; insert into public.load_packet_sends (owner_id, load_id, to_emails, with_invoice) values ('${O}','${L1}','{svc@fstrucks.com}', false); reset role;`);
ok(true, 'service_role can insert');

const as = async (role, uid, sql) => { await db.exec(`reset role; select set_config('request.jwt.claim.sub', '${uid || ''}', false); set role ${role};`); try { return (await db.query(sql)).rows; } finally { await db.exec('reset role'); } };
const err = async (role, uid, sql) => { try { await as(role, uid, sql); return null; } catch (e) { return e.message; } };
const sel = 'select owner_id from public.load_packet_sends';
ok((await as('authenticated', O, sel)).length === 2, 'owner reads own company rows');
ok((await as('authenticated', M, sel)).length === 2, 'management reads');
ok((await as('authenticated', P, sel)).length === 2, 'dispatcher reads');
ok((await as('authenticated', D, sel)).length === 0, 'driver reads nothing');
ok((await as('authenticated', O2, sel)).every((r) => r.owner_id === O2), 'other company sees only its own row');
ok((await err('anon', null, sel)) !== null, 'anon denied');
for (const [u, n] of [[O, 'owner'], [P, 'dispatcher']]) {
  ok((await err('authenticated', u, `insert into public.load_packet_sends (owner_id, load_id, to_emails, with_invoice) values ('${O}','${L1}','{x@fstrucks.com}', false)`)) !== null, `${n} insert denied`);
  ok((await err('authenticated', u, `update public.load_packet_sends set note='x'`)) !== null, `${n} update denied`);
  ok((await err('authenticated', u, `delete from public.load_packet_sends`)) !== null, `${n} delete denied`);
}
ok((await err('anon', null, `insert into public.load_packet_sends (owner_id, to_emails, with_invoice) values ('${O}','{x@fstrucks.com}', false)`)) !== null, 'anon insert denied');
const pols = (await db.query(`select cmd from pg_policies where tablename='load_packet_sends'`)).rows;
ok(pols.length === 1 && pols[0].cmd === 'SELECT', 'only a select policy');

// fk: deleting the load keeps the rows (cap and history survive), link cleared
await db.exec(`delete from public.invoices where id='${I1}'; delete from public.loads where id='${L1}';`);
const left = (await db.query(`select load_id, invoice_id from public.load_packet_sends where owner_id='${O}'`)).rows;
ok(left.length === 2 && left.every((r) => r.load_id === null && r.invoice_id === null), 'load/invoice delete → SET NULL, rows kept');
const cap = (await db.query(`select count(*)::int n from public.load_packet_sends where sent_at >= now() - interval '1 day'`)).rows[0].n;
ok(cap === 3, 'cap count unchanged after load deletion');
const idx = (await db.query(`select indexname, indexdef from pg_indexes where tablename='load_packet_sends'`)).rows;
ok(idx.some((i) => i.indexname === 'load_packet_sends_owner_sent_idx' && /\(owner_id, sent_at\)/.test(i.indexdef)), 'index (owner_id, sent_at)');
ok(idx.some((i) => i.indexname === 'load_packet_sends_load_idx'), 'index on load_id');
// Dakota's post-apply check file: SELECT only, and it runs.
const CHK = readFileSync(new URL('../../supabase/checks/20261025000200_load_packet_sends_check.sql', import.meta.url), 'utf8').split(';').map((q) => q.trim()).filter(Boolean);
ok(CHK.length === 6 && CHK.every((q) => /^select\b/i.test(q) && !/\b(insert|update|delete|alter|create|drop|grant|revoke|truncate)\b/i.test(q)), 'check file is SELECT only');
const out = []; for (const q of CHK) out.push((await db.query(q)).rows);
ok(out[0][0].table_exists && out[1][0].rls_enabled, 'check: table + RLS');
ok(out[2].length === 1 && out[2][0].cmd === 'SELECT', 'check: one select policy');
ok(out[3].every((g) => g.grantee === 'authenticated' && g.privilege_type === 'SELECT'), 'check: only select granted to authenticated, nothing to anon');
ok(out[5].find((f) => f.column_name === 'load_id')?.delete_rule === 'SET NULL', 'check: load_id SET NULL');
console.log(process.exitCode ? 'FAILED' : 'all passed');
