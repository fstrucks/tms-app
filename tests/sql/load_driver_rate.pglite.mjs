// Migration 20261018000600 against an in-memory Postgres (PGlite, WASM). LOCAL ONLY: never touches Supabase.
// Run: npm i --no-save @electric-sql/pglite && node tests/sql/load_driver_rate.pglite.mjs
// Minimal stand-ins for auth.users / auth.uid() / roles; loads + company RLS come from the real migrations.
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
const db = new PGlite();
const R = new URL('../../supabase/migrations/', import.meta.url).pathname;
const ok = (c, m) => { if (!c) { console.error('FAIL', m); process.exitCode = 1; } else console.log('ok', m); };
await db.exec(`
create role anon; create role authenticated;
create schema auth;
create table auth.users (id uuid primary key, email text);
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
grant usage on schema auth to authenticated, anon; grant execute on function auth.uid() to authenticated, anon;
create table public.profiles (id uuid primary key);
create table public.loads (id uuid primary key default gen_random_uuid(), user_id uuid not null, status text, broker_name text, broker_load_number text,
  rate numeric, rate_per_mile numeric, total_miles numeric, miles_source text, commodity text, weight int, equipment_type text, special_instructions text, notes text,
  created_at timestamptz default now(), updated_at timestamptz default now());
create table public.stops (id serial primary key, load_id uuid references public.loads(id), stop_type text, sequence int, company_name text, address_line1 text,
  city text, state text, zip text, appointment_start timestamptz, appointment_end timestamptz, timezone text, notes text, geocode_address text);
grant usage on schema public to authenticated, anon;
`);
await db.exec(readFileSync(R + '20261010000400_loads.sql', 'utf8').split('-- documents.load_id')[0]);
await db.exec(readFileSync(R + '20261015001200_company_profiles.sql', 'utf8').split('NOPE')[0]);
await db.exec(`grant select, insert, update, delete on public.company_profiles, public.company_members to authenticated;`);
const O = '00000000-0000-0000-0000-00000000000a', D = '00000000-0000-0000-0000-00000000000d', D2 = '00000000-0000-0000-0000-0000000000d2', P = '00000000-0000-0000-0000-00000000000b', X = '00000000-0000-0000-0000-0000000000ee';
await db.exec(`insert into auth.users values ('${O}','owner@example.com'),('${D}','driver@example.com'),('${D2}','driver2@example.com'),('${P}','dispatch@example.com'),('${X}','stranger@example.com');`);
await db.exec(readFileSync(R + '20261018000600_load_driver_rate_members.sql', 'utf8'));
await db.exec(`insert into public.company_profiles (id, owner_id, legal_name) values ('11111111-1111-1111-1111-111111111111', '${O}', 'FAKE Co');
insert into public.company_members values ('11111111-1111-1111-1111-111111111111','${D}','driver'),('11111111-1111-1111-1111-111111111111','${D2}','driver'),('11111111-1111-1111-1111-111111111111','${P}','dispatcher');
insert into public.loads (id, user_id, status, rate, rate_per_mile, total_miles, assigned_driver_user_id, show_rate_to_driver) values
 ('aaaaaaaa-0000-0000-0000-000000000001','${O}','in_transit',1800,2.5,720,'${D}',false),
 ('aaaaaaaa-0000-0000-0000-000000000002','${O}','booked',900,1.5,600,'${D}',true),
 ('aaaaaaaa-0000-0000-0000-000000000003','${O}','booked',500,1,500,null,true);
insert into public.stops (load_id, stop_type, sequence, city, pickup_number) values ('aaaaaaaa-0000-0000-0000-000000000001','pickup',1,'Ontario','PU-1'),('aaaaaaaa-0000-0000-0000-000000000001','delivery',2,'Phoenix',null);`);
let threw = false;
try { await db.exec(`update public.loads set assigned_driver_user_id='${X}' where id='aaaaaaaa-0000-0000-0000-000000000003'`); } catch (e) { threw = /assigned_driver_not_driver/.test(e.message); }
ok(threw, 'trigger rejects a non-driver assignment');
const as = async (uid, sql) => { await db.exec(`reset role; select set_config('request.jwt.claim.sub', '${uid}', false); set role authenticated;`); return (await db.query(sql)).rows; };
ok((await as(D, 'select rate from public.loads')).length === 0, 'driver: direct select on loads returns 0 rows');
ok((await as(D, 'select * from public.stops')).length === 0, 'driver: direct select on stops returns 0 rows');
let rows = (await as(D, 'select v from public.visible_loads() v')).map((r) => r.v);
ok(rows.length === 2, 'driver sees only assigned loads (2)');
const l1 = rows.find((r) => r.id.endsWith('1')), l2 = rows.find((r) => r.id.endsWith('2'));
ok(l1.rate === null && l1.rate_per_mile === null && l1.can_see_rate === false, 'flag off: rate + rpm null');
ok(Number(l2.rate) === 900 && Number(l2.rate_per_mile) === 1.5, 'flag on: driver sees rate + rpm');
ok(l1.stops.length === 2 && l1.stops[0].pickup_number === 'PU-1', 'stops + pickup_number included');
ok(!('user_id' in l1), 'no owner id leaked');
rows = (await as(D2, 'select v from public.visible_loads() v')).map((r) => r.v);
ok(rows.length === 0, 'other driver sees none');
rows = (await as(P, 'select v from public.visible_loads() v')).map((r) => r.v);
ok(rows.length === 3 && rows.every((r) => r.rate !== null), 'dispatcher sees all 3 with rates');
rows = (await as(O, 'select v from public.visible_loads(array[\'booked\']) v')).map((r) => r.v);
ok(rows.length === 2 && rows.every((r) => r.rate !== null && r.viewer_role === 'owner'), 'owner sees rates; status filter works');
ok((await as(X, 'select v from public.visible_loads() v')).length === 0, 'stranger sees none');
threw = false; try { await as(D, `select public.set_load_driver_settings('aaaaaaaa-0000-0000-0000-000000000001', '${D}', true)`); } catch (e) { threw = /not_allowed/.test(e.message); }
ok(threw, 'driver cannot flip the flag');
threw = false; try { await as(D, `update public.loads set show_rate_to_driver = true`); } catch (e) { threw = true; }
const after = (await as(O, `select show_rate_to_driver from public.loads where id='aaaaaaaa-0000-0000-0000-000000000001'`))[0];
ok(after.show_rate_to_driver === false, 'driver direct update changes nothing');
await as(P, `select public.set_load_driver_settings('aaaaaaaa-0000-0000-0000-000000000001', '${D}', true)`);
rows = (await as(D, 'select v from public.visible_loads(null, \'aaaaaaaa-0000-0000-0000-000000000001\') v')).map((r) => r.v);
ok(Number(rows[0].rate) === 1800, 'dispatcher turns it on → driver sees rate');
threw = false; try { await as(X, `select public.set_load_driver_settings('aaaaaaaa-0000-0000-0000-000000000001', null, false)`); } catch (e) { threw = /load_not_found/.test(e.message); }
ok(threw, 'stranger: load_not_found');
rows = await as(P, 'select * from public.load_driver_choices(\'' + O + '\')');
ok(rows.length === 2, 'dispatcher gets 2 driver choices');
ok((await as(D, 'select * from public.load_driver_choices(\'' + O + '\')')).length === 0, 'driver gets no choices');
ok((await as(O, 'select * from public.load_driver_choices()')).length === 2, 'owner gets 2 choices');
