// Migration 20261126000100 (dispatch_loads has_rate_con) on top of 0700, against an in-memory Postgres (PGlite).
// LOCAL ONLY: never touches Supabase. Fake data only.
// Run: npm i --no-save @electric-sql/pglite && node tests/sql/dispatch_has_rate_con.pglite.mjs
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
const R = process.env.MIG_DIR || new URL('../../supabase/migrations/', import.meta.url).pathname;
const db = new PGlite();
let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.error('FAIL', m); process.exitCode = 1; } else console.log('ok', m); };

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
create function public.loads_compute_rate_per_mile() returns trigger language plpgsql as $$ begin new.rate_per_mile := round((new.rate / nullif(new.total_miles, 0))::numeric, 2); return new; end $$;
create trigger loads_compute_rate_per_mile before insert or update on public.loads for each row execute function public.loads_compute_rate_per_mile();
`);
await db.exec(readFileSync(R + '20261010000400_loads.sql', 'utf8').split('-- documents.load_id')[0]);
await db.exec(`revoke update on public.loads from authenticated; grant update (user_id, truck_id, status, broker_name, broker_load_number, rate, commodity, weight, equipment_type, special_instructions, total_miles, notes, updated_at, miles_source) on public.loads to authenticated;`);
await db.exec(readFileSync(R + '20261015001200_company_profiles.sql', 'utf8'));
await db.exec(`grant select, insert, update, delete on public.company_profiles, public.company_members to authenticated;`);
await db.exec(readFileSync(R + '20261018000600_load_driver_rate_members.sql', 'utf8'));
await db.exec(readFileSync(R + '20261018000700_dispatch_center.sql', 'utf8'));
await db.exec(readFileSync(R + '20261126000100_dispatch_loads_has_rate_con.sql', 'utf8'));
// Idempotent: a second apply must not fail or change the flag.
await db.exec(readFileSync(R + '20261126000100_dispatch_loads_has_rate_con.sql', 'utf8'));

const O = '00000000-0000-0000-0000-00000000000a', D = '00000000-0000-0000-0000-00000000000d', P = '00000000-0000-0000-0000-00000000000b', M = '00000000-0000-0000-0000-00000000000c', X = '00000000-0000-0000-0000-0000000000ee';
const L_OWNER = 'aaaaaaaa-0000-0000-0000-0000000000a1', L_MATE = 'aaaaaaaa-0000-0000-0000-0000000000a2', L_OUT = 'aaaaaaaa-0000-0000-0000-0000000000a3', L_NONE = 'aaaaaaaa-0000-0000-0000-0000000000a4';

await db.exec(`insert into auth.users values ('${O}','owner@example.com'),('${D}','driver@example.com'),('${P}','dispatch@example.com'),('${M}','mgmt@example.com'),('${X}','other-owner@example.com');
insert into public.company_profiles (id, owner_id, legal_name) values ('11111111-1111-1111-1111-111111111111', '${O}', 'FAKE Trucking LLC'), ('22222222-2222-2222-2222-222222222222', '${X}', 'Other FAKE Co');
insert into public.company_members values ('11111111-1111-1111-1111-111111111111','${D}','driver'),('11111111-1111-1111-1111-111111111111','${P}','dispatcher'),('11111111-1111-1111-1111-111111111111','${M}','management');
insert into public.loads (id, user_id, status, rate, total_miles) values
 ('${L_OWNER}','${O}','booked',1000,100), ('${L_MATE}','${O}','booked',1000,100), ('${L_OUT}','${O}','booked',1000,100), ('${L_NONE}','${O}','booked',1000,100);
insert into public.documents (user_id, load_id, doc_type, file_path) values
 ('${O}','${L_OWNER}','rate_confirmation','${O}/qa-owner.pdf'),
 ('${D}','${L_MATE}','rate_confirmation','${D}/qa-mate.pdf'),
 ('${X}','${L_OUT}','rate_confirmation','${X}/qa-other.pdf');`);

const as = async (uid, sql) => { await db.exec(`reset role; select set_config('request.jwt.claim.sub', '${uid}', false); set role authenticated;`); return (await db.query(sql)).rows; };
const flag = async (uid, id) => {
  const rows = (await as(uid, `select v from public.dispatch_loads('${id}') v`)).map((r) => r.v);
  return rows[0] ? rows[0].has_rate_con : undefined;
};

ok(await flag(P, L_OWNER) === true, 'owner-only rate con: has_rate_con is true');
ok(await flag(P, L_MATE) === true, 'teammate-only rate con: has_rate_con is now true');
ok(await flag(M, L_MATE) === true, 'management sees the same teammate-only flag');
ok(await flag(P, L_OUT) === false, 'unrelated company doc linked to the load: has_rate_con is false');
ok(await flag(P, L_NONE) === false, 'no rate con: has_rate_con is false');

// Role behavior is unchanged: drivers and the owner still get no rows.
ok((await as(D, 'select v from public.dispatch_loads() v')).length === 0, 'driver still gets nothing from dispatch_loads');
ok((await as(O, 'select v from public.dispatch_loads() v')).length === 0, 'owner still gets nothing from dispatch_loads');
ok((await as(P, 'select v from public.dispatch_loads() v')).length === 4, 'dispatcher still lists the company loads');

// A teammate file whose path is not in the uploader's folder does not count.
const L_BAD = 'aaaaaaaa-0000-0000-0000-0000000000a5';
await db.exec(`reset role; insert into public.loads (id, user_id, status, rate, total_miles) values ('${L_BAD}','${O}','booked',1000,100);
insert into public.documents (user_id, load_id, doc_type, file_path) values ('${D}','${L_BAD}','rate_confirmation','not-the-uploader/qa-bad.pdf');`);
ok(await flag(P, L_BAD) === false, 'teammate rate con whose path is not in the uploader folder: false');

console.log(fails ? `${fails} FAILED` : 'all passed');
