// Migration 20261019000200 (rate con email-in) against an in-memory Postgres (PGlite, WASM). LOCAL ONLY: never touches Supabase.
// Run: npm i --no-save @electric-sql/pglite && node tests/sql/ratecon_email_in.pglite.mjs
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
const db = new PGlite();
const R = process.env.MIG_DIR || new URL('../../supabase/migrations/', import.meta.url).pathname;
const ok = (c, m) => { if (!c) { console.error('FAIL', m); process.exitCode = 1; } else console.log('ok', m); };
await db.exec(`
create role anon; create role authenticated; create role service_role;
create schema auth;
create table auth.users (id uuid primary key, email text);
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
grant usage on schema auth to authenticated, anon, service_role; grant execute on function auth.uid() to authenticated, anon, service_role;
create table public.documents (id uuid primary key default gen_random_uuid(), user_id uuid not null default auth.uid(), load_id uuid, truck_id uuid, doc_type text,
  file_path text, original_filename text, ai_extracted_data jsonb, created_at timestamptz default now());
create table public.company_profiles (id uuid primary key, owner_id uuid);
create table public.company_members (profile_id uuid, user_id uuid, role text);
grant usage on schema public to authenticated, anon, service_role;
`);
await db.exec(readFileSync(R + '20261010000100_documents_table_rls.sql', 'utf8'));
await db.exec(readFileSync(R + '20261010000200_documents_update_rls.sql', 'utf8').replace(/^.*extraction_runs[\s\S]*$/m, ''));
await db.exec(readFileSync(R + '20261015001300_packets_inbound.sql', 'utf8'));
const MIG = readFileSync(R + '20261019000200_ratecon_email_in.sql', 'utf8');
await db.exec(MIG);
await db.exec(MIG); // re-runnable
const A = '00000000-0000-0000-0000-00000000000a', B = '00000000-0000-0000-0000-00000000000b';
await db.exec(`insert into auth.users values ('${A}','a@example.com'),('${B}','b@example.com');`);

const as = async (role, uid, sql) => { await db.exec(`reset role; select set_config('request.jwt.claim.sub', '${uid || ''}', false); set role ${role};`); try { return (await db.query(sql)).rows; } finally { await db.exec('reset role'); } };
const err = async (role, uid, sql) => { try { await as(role, uid, sql); return null; } catch (e) { return e.message; } };

const a1 = (await as('authenticated', A, 'select * from public.ratecon_address_get()'))[0];
ok(/^[a-f0-9]{32}$/.test(a1.token) && a1.allowed_senders.length === 0, 'get creates a 32-hex token, empty allowlist');
const a2 = (await as('authenticated', A, 'select * from public.ratecon_address_get()'))[0];
ok(a2.token === a1.token, 'get is stable (same token on second call)');
const b1 = (await as('authenticated', B, 'select * from public.ratecon_address_get()'))[0];
ok(b1.token !== a1.token, 'each user has their own token');
const seen = await as('authenticated', A, 'select user_id from public.ratecon_inbound_addresses');
ok(seen.length === 1 && seen[0].user_id === A, 'RLS: a user only sees their own address');
ok(await err('authenticated', A, `update public.ratecon_inbound_addresses set token = 'f' || substr(token, 2)`) !== null, 'no direct update by users');
ok(await err('authenticated', A, `insert into public.ratecon_inbound_addresses (user_id, token) values ('${B}', '${'c'.repeat(32)}')`) !== null, 'no direct insert by users');
ok(await err('anon', null, 'select * from public.ratecon_address_get()') !== null, 'anon cannot call get');
ok(/not_signed_in/.test(await err('authenticated', null, 'select * from public.ratecon_address_get()') || ''), 'no session: not_signed_in');

const rot = (await as('authenticated', A, 'select public.ratecon_address_regenerate() t'))[0].t;
ok(/^[a-f0-9]{32}$/.test(rot) && rot !== a1.token, 'regenerate gives a new token');
const svcOld = await as('service_role', null, `select * from public.ratecon_owner_for_token('${a1.token}')`);
const svcNew = await as('service_role', null, `select * from public.ratecon_owner_for_token('${rot.toUpperCase()}')`);
ok(svcOld.length === 0, 'old token no longer resolves after regenerate');
ok(svcNew.length === 1 && svcNew[0].user_id === A, 'service role resolves the new token (case-insensitive)');
ok(await err('authenticated', A, `select * from public.ratecon_owner_for_token('${rot}')`) !== null, 'authenticated cannot resolve tokens');
ok(await err('anon', null, `select * from public.ratecon_owner_for_token('${rot}')`) !== null, 'anon cannot resolve tokens');

const al = (await as('authenticated', A, `select public.ratecon_set_allowed_senders(array[' Broker@Example.com ', '@freight.example', '', 'broker@example.com']) v`))[0].v;
ok(JSON.stringify(al) === JSON.stringify(['@freight.example', 'broker@example.com']), 'allowlist trimmed, lowercased, de-duplicated');
ok((await as('service_role', null, `select allowed_senders from public.ratecon_owner_for_token('${rot}')`))[0].allowed_senders.length === 2, 'webhook sees the allowlist');
ok(/bad_sender/.test(await err('authenticated', A, `select public.ratecon_set_allowed_senders(array['not an email'])`) || ''), 'bad sender rejected');
ok(/too_many/.test(await err('authenticated', A, `select public.ratecon_set_allowed_senders(array(select 'u'||g||'@example.com' from generate_series(1,21) g))`) || ''), 'more than 20 rejected');
await as('authenticated', A, `select public.ratecon_set_allowed_senders('{}')`);
ok((await as('service_role', null, `select allowed_senders from public.ratecon_owner_for_token('${rot}')`))[0].allowed_senders.length === 0, 'allowlist can be cleared');

// documents columns: defaults, checks, users can't set them.
await as('authenticated', A, `insert into public.documents (user_id, doc_type, file_path) values ('${A}', 'rate_confirmation', '${A}/x.pdf')`);
const d = (await db.query(`select source, extraction_status from public.documents`)).rows[0];
ok(d.source === 'upload' && d.extraction_status === null, 'existing upload path: source=upload, extraction_status null');
ok(await err('authenticated', A, `insert into public.documents (user_id, doc_type, file_path, source) values ('${A}', 'rate_confirmation', '${A}/y.pdf', 'email')`) !== null, 'users cannot insert source=email');
ok(await err('authenticated', A, `update public.documents set extraction_status = 'done'`) !== null, 'users cannot set extraction_status');
ok((await err('postgres', null, `insert into public.documents (user_id, file_path, source) values ('${A}', 'z', 'fax')`) || '').includes('documents_source_check'), 'source check');
ok((await err('postgres', null, `insert into public.documents (user_id, file_path, extraction_status) values ('${A}', 'z', 'maybe')`) || '').includes('extraction_status_check'), 'extraction_status check');

// inbound_emails: kind + dedupe on (provider, message_id).
await db.exec(`insert into public.inbound_emails (owner_id, kind, message_id, from_email) values ('${A}', 'ratecon', 'ratecon:pm-1', 'broker@example.com')`);
ok((await err('postgres', null, `insert into public.inbound_emails (owner_id, kind, message_id, from_email) values ('${A}', 'ratecon', 'ratecon:pm-1', 'broker@example.com')`) || '').includes('inbound_emails_message_unique'), 'same Postmark MessageID twice: unique violation (idempotent)');
ok((await db.query(`select kind from public.inbound_emails where message_id is not null and kind = 'packet'`)).rows.length === 0 && (await err('postgres', null, `insert into public.inbound_emails (kind, message_id, from_email) values ('fax', 'm2', 'x@example.com')`) || '').includes('kind_check'), 'kind check');
ok(!/\b(drop table|drop column|truncate|delete from)\b/i.test(MIG), 'migration is additive');
if (!process.exitCode) console.log('ALL OK');
