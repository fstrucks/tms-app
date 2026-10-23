// Migration 20261022250000 (create_load_from_company_upload) against an in-memory Postgres (PGlite, WASM).
// LOCAL ONLY: never touches Supabase. Fake data only.
// Run: npm i --no-save @electric-sql/pglite && node tests/sql/ratecon_upload_company_owner.pglite.mjs
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
const db = new PGlite();
const R = process.env.MIG_DIR || new URL('../../supabase/migrations/', import.meta.url).pathname;
const fn = (file, name) => { const t = readFileSync(R + file, 'utf8'); const i = t.indexOf(`create or replace function public.${name}(`); return t.slice(i, t.indexOf('$$;', t.indexOf('$$', t.indexOf('$$', i) + 2)) + 3); };
let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.error('FAIL', m); process.exitCode = 1; } else console.log('ok', m); };
await db.exec(`
create role anon; create role authenticated;
create schema auth;
create table auth.users (id uuid primary key, email text);
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
grant usage on schema auth to authenticated, anon; grant execute on function auth.uid() to authenticated, anon;
create table public.loads (id uuid primary key default gen_random_uuid(), user_id uuid not null, status text, broker_name text, broker_load_number text,
  rate numeric, total_miles numeric, miles_source text, weight numeric, equipment_type text, notes text, created_at timestamptz default now());
create table public.stops (id serial primary key, load_id uuid references public.loads(id), stop_type text, sequence int, company_name text, address_line1 text,
  city text, state text, zip text, appointment_start timestamptz, timezone text, notes text);
create table public.documents (id uuid primary key default gen_random_uuid(), user_id uuid, load_id uuid, ai_extracted_data jsonb, file_path text, doc_type text);
alter table public.documents enable row level security;
create policy documents_select_own on public.documents for select to authenticated using (user_id = auth.uid());
grant select, insert, update on public.documents to authenticated; grant select, insert on public.loads, public.stops to authenticated;
grant usage, select on sequence public.stops_id_seq to authenticated;
grant usage on schema public to authenticated, anon;
`);
await db.exec(fn('20261010000660_stop_timezones.sql', 'us_state_tz'));
await db.exec(fn('20261012000740_address_parser_fixes.sql', 'parse_us_address'));
await db.exec(readFileSync(R + '20261015001200_company_profiles.sql', 'utf8'));
await db.exec(`create function public.create_load_from_company_upload(p_document uuid, p_tz text) returns uuid language sql as $$ select null::uuid $$;`); // the earlier draft
await db.exec(readFileSync(R + '20261022250000_ratecon_upload_company_owner.sql', 'utf8'));
await db.exec(readFileSync(R + '20261022250000_ratecon_upload_company_owner.sql', 'utf8')); // idempotent

const O = '00000000-0000-0000-0000-00000000000a', P = '00000000-0000-0000-0000-00000000000b', D = '00000000-0000-0000-0000-00000000000d', X = '00000000-0000-0000-0000-0000000000ee';
const C1 = '11111111-1111-1111-1111-111111111111', C2 = '22222222-2222-2222-2222-222222222222', O2 = '00000000-0000-0000-0000-0000000000a2';
const x = JSON.stringify({ broker_name: 'FAKE Broker', load_number: 'T-1', rate: 1500, equipment_type: 'Van', weight_lb: 40000,
  shipper: { name: 'FAKE Shipper', address: '100 Test Rd, Joliet, IL 60431' }, receiver: { name: 'FAKE Receiver', address: '1 Main St, Gary, IN 46402' },
  pickup: { date: '2026-10-23', time: '08:00' }, delivery: { date: '2026-10-24' } });
await db.exec(`insert into auth.users values ('${O}','o@example.com'),('${P}','p@example.com'),('${D}','d@example.com'),('${X}','x@example.com');
insert into auth.users values ('${O2}','o2@example.com');
insert into public.company_profiles (id, owner_id, legal_name) values ('${C1}','${O}','FAKE Co'),('${C2}','${O2}','OTHER FAKE Co');
insert into public.company_members (profile_id, user_id, role) values ('${C1}','${P}','dispatcher'),('${C1}','${D}','driver');`);
const doc = async (owner) => (await db.query(`insert into public.documents (user_id, ai_extracted_data) values ($1, $2::jsonb) returning id`, [owner, x])).rows[0].id;
const as = async (uid, docId, profile = null) => { await db.exec(`reset role; set request.jwt.claim.sub = '${uid}'`); try { return { id: (await db.query(`select public.create_load_from_company_upload($1, 'America/Chicago', $2) as id`, [docId, profile])).rows[0].id }; } catch (e) { return { err: e.message }; } };
const ownerOf = async (id) => (await db.query(`select user_id from public.loads where id = $1`, [id])).rows[0]?.user_id;

let r = await as(P, await doc(P));
ok(r.id && (await ownerOf(r.id)) === O, 'dispatcher upload → load owned by the company owner');
const st = (await db.query(`select stop_type, company_name, state from public.stops where load_id = $1 order by sequence`, [r.id])).rows;
ok(st.length === 2 && st[0].company_name === 'FAKE Shipper' && st[1].state === 'IN', 'stops created');
const l = (await db.query(`select equipment_type, weight from public.loads where id = $1`, [r.id])).rows[0];
ok(l.equipment_type === 'Van' && Number(l.weight) === 40000, 'equipment and weight filled');
r = await as(O, await doc(O)); ok(r.id && (await ownerOf(r.id)) === O, 'owner upload → owner');
r = await as(D, await doc(D)); ok(r.id && (await ownerOf(r.id)) === D, 'driver upload → himself (old behaviour)');
r = await as(X, await doc(X)); ok(r.id && (await ownerOf(r.id)) === X, 'stranger upload → himself');
r = await as(X, await doc(P)); ok(/document_not_found/.test(r.err || ''), "someone else's document is rejected");
const d2 = await doc(P); await as(P, d2); r = await as(P, d2); ok(/already_linked/.test(r.err || ''), 'second call → already_linked');

// p_profile
r = await as(P, await doc(P), C1); ok(r.id && (await ownerOf(r.id)) === O, 'dispatcher + active company → that company owner');
r = await as(O, await doc(O), C1); ok(r.id && (await ownerOf(r.id)) === O, 'owner + own company → owner');
r = await as(P, await doc(P), C2); ok(/not_company_office/.test(r.err || ''), 'company the caller is not in → rejected');
r = await as(D, await doc(D), C1); ok(/not_company_office/.test(r.err || ''), 'driver of the company → rejected');
const fns = (await db.query(`select pg_get_function_identity_arguments(p.oid) a from pg_proc p where proname = 'create_load_from_company_upload'`)).rows;
ok(fns.length === 1 && /p_profile uuid/.test(fns[0].a), 'one function (2-arg draft dropped)');
const grants = (await db.query(`select has_function_privilege('anon', 'public.create_load_from_company_upload(uuid,text,uuid)', 'execute') a, has_function_privilege('authenticated', 'public.create_load_from_company_upload(uuid,text,uuid)', 'execute') u`)).rows[0];
ok(!grants.a && grants.u, 'execute: authenticated only');

// Visibility under RLS: the dispatcher's rate con on the owner's load.
const rc = (await db.query(`insert into public.documents (user_id, doc_type, file_path, ai_extracted_data) values ($1, 'rate_confirmation', 'p/rc.pdf', $2::jsonb) returning id`, [P, x])).rows[0].id;
const L = (await as(P, rc, C1)).id;
const sees = async (uid) => { await db.exec(`reset role; set request.jwt.claim.sub = '${uid}'; set role authenticated`); const n = (await db.query(`select count(*)::int n from public.documents where load_id = $1`, [L])).rows[0].n; await db.exec('reset role'); return n; };
ok((await sees(O)) === 1, 'owner sees the dispatcher’s rate con on the company load');
ok((await sees(P)) === 1, 'uploader still sees it');
ok((await sees(D)) === 0, 'driver: not through this policy');
ok((await sees(O2)) === 0, 'another company’s owner: no');
ok((await sees(X)) === 0, 'stranger: no');
if (fails) console.error(`${fails} failed`); else console.log('all passed');
