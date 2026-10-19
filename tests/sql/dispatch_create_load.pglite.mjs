// Migration 20261019000100 (dispatch_create_load) on top of 0600 + 0700 + 0800, against an in-memory Postgres (PGlite, WASM).
// LOCAL ONLY: never touches Supabase. Fake data only. Run: npm i --no-save @electric-sql/pglite && node tests/sql/dispatch_create_load.pglite.mjs
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
const db = new PGlite();
const R = process.env.MIG_DIR || new URL('../../supabase/migrations/', import.meta.url).pathname;
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
const O = '00000000-0000-0000-0000-00000000000a', D = '00000000-0000-0000-0000-00000000000d', P = '00000000-0000-0000-0000-00000000000b',
  M = '00000000-0000-0000-0000-00000000000c', O2 = '00000000-0000-0000-0000-0000000000a2', D2 = '00000000-0000-0000-0000-0000000000d2', X = '00000000-0000-0000-0000-0000000000ee';
const C1 = '11111111-1111-1111-1111-111111111111', C2 = '22222222-2222-2222-2222-222222222222';
await db.exec(`insert into auth.users values ('${O}','owner@example.com'),('${D}','driver@example.com'),('${P}','dispatch@example.com'),('${M}','mgmt@example.com'),
  ('${O2}','owner2@example.com'),('${D2}','driver2@example.com'),('${X}','stranger@example.com');
insert into public.company_profiles (id, owner_id, legal_name) values ('${C1}','${O}','FAKE Co'),('${C2}','${O2}','OTHER FAKE Co');
insert into public.company_members values ('${C1}','${D}','driver'),('${C1}','${P}','dispatcher'),('${C1}','${M}','management'),('${C2}','${D2}','driver');`);
await db.exec(readFileSync(R + '20261018000800_member_role_editor.sql', 'utf8'));

await db.exec(readFileSync(R + '20261019000100_dispatch_create_load.sql', 'utf8'));
await db.exec(`insert into auth.users values ('00000000-0000-0000-0000-0000000000b2','dispatch2@example.com');
insert into public.company_members values ('${C2}','00000000-0000-0000-0000-0000000000b2','dispatcher');`);
const P2 = '00000000-0000-0000-0000-0000000000b2';
const as = async (uid, sql) => { await db.exec(`reset role; select set_config('request.jwt.claim.sub', '${uid}', false); set role authenticated;`); return (await db.query(sql)).rows; };
const err = async (uid, sql) => { try { await as(uid, sql); return null; } catch (e) { return e.message; } };
const LOAD = JSON.stringify({ broker_name: ' Demo Broker (FAKE) ', broker_load_number: 'QA-1', rate: '1800', total_miles: 720, weight: 38500.4, commodity: 'Paper (FAKE)', notes: 'Test load', assigned_driver_user_id: D, show_rate_to_driver: true, user_id: X, rate_per_mile: 99 });
const STOPS = JSON.stringify([
  { stop_type: 'pickup', company_name: 'Acme (FAKE)', city: 'Ontario', state: 'ca', pickup_number: 'PU-1', appointment_start: '2026-10-20T15:00:00Z', timezone: 'America/Los_Angeles' },
  { stop_type: 'pickup', city: 'Riverside', state: 'CA', pickup_number: 'PU-2' },
  { stop_type: 'delivery', city: 'Phoenix', state: 'AZ', zip: '85001' },
]);
const call = (owner, load = LOAD, stops = STOPS) => `select public.dispatch_create_load('${owner}', '${load}'::jsonb, '${stops}'::jsonb) v`;
const su = async (sql) => { await db.exec('reset role;'); return (await db.query(sql)); };
const suExec = async (sql) => { await db.exec('reset role;'); await db.exec(sql); };
const count = async () => (await su(`select count(*)::int n from public.loads`)).rows[0].n;

// Allowed: dispatcher, management, owner
const id1 = (await as(P, call(O)))[0].v;
ok(typeof id1 === 'string' && id1.length === 36, 'dispatcher creates a load → returns the new id');
let row = (await su(`select * from public.loads where id = '${id1}'`)).rows[0];
ok(row.user_id === O, 'load row is owned by the company OWNER (user_id = owner), not the dispatcher or a user_id key in the JSON');
ok(row.status === 'booked' && row.broker_name === 'Demo Broker (FAKE)' && Number(row.rate) === 1800 && Number(row.total_miles) === 720 && row.miles_source === 'typed' && row.weight === 38500, 'fields saved, trimmed, status defaults to booked, miles typed, weight rounded');
ok(Number(row.rate_per_mile) === 2.5, 'rate_per_mile from the trigger, not from the JSON');
ok(row.assigned_driver_user_id === D && row.show_rate_to_driver === true, 'driver assigned + show rate saved');
let st = (await su(`select * from public.stops where load_id = '${id1}' order by sequence`)).rows;
ok(st.length === 3 && st.map((s) => s.sequence).join() === '1,2,3' && st.map((s) => s.city).join() === 'Ontario,Riverside,Phoenix', 'stops saved in order 1..3');
ok(st[0].pickup_number === 'PU-1' && st[1].pickup_number === 'PU-2' && st[0].state === 'CA' && st[0].appointment_start, 'pickup #s, upper-cased state, appointment saved');
ok((await as(O, `select count(*)::int n from public.loads where id = '${id1}'`))[0].n === 1, 'owner sees it in /loads via normal own-row RLS');
ok((await as(P, `select v from public.dispatch_loads('${id1}') v`)).length === 1, 'dispatcher sees it in dispatch_loads');
ok((await as(P, `select count(*)::int n from public.loads`))[0].n === 0, 'own-row RLS untouched: dispatcher direct select = 0 rows');
const id2 = (await as(M, call(O, JSON.stringify({ rate: 900, status: 'dispatched' }))))[0].v;
row = (await su(`select * from public.loads where id = '${id2}'`)).rows[0];
ok(row.user_id === O && row.status === 'dispatched' && row.assigned_driver_user_id === null && row.show_rate_to_driver === false && row.miles_source === null, 'management creates a minimal load (no driver, no miles)');
ok((await as(O, call(O)))[0].v, 'owner can create through it too');
const id3 = (await as(P, call(O, JSON.stringify({ rate: 1, show_rate_to_driver: true }))))[0].v;
ok((await su(`select show_rate_to_driver s from public.loads where id = '${id3}'`)).rows[0].s === false, 'show rate forced off when no driver');

// Denied roles / companies
let n = await count();
ok(/not_allowed/.test(await err(D, call(O)) || ''), 'driver: not_allowed');
ok(/not_allowed/.test(await err(X, call(O)) || ''), 'stranger: not_allowed');
ok(/not_allowed/.test(await err(P2, call(O)) || ''), 'dispatcher of ANOTHER company: not_allowed');
ok(/not_allowed/.test(await err(O2, call(O)) || ''), 'owner of another company: not_allowed');
ok(/not_allowed/.test(await err(P, call(O2)) || ''), 'dispatcher targeting another company: not_allowed');
ok(/not_allowed/.test(await err(P, call(X)) || ''), 'unknown company: not_allowed');
ok(/not_signed_in/.test(await err('', call(O)) || ''), 'no session: not_signed_in');
// Bad driver
ok(/assigned_driver_not_driver/.test(await err(P, call(O, JSON.stringify({ rate: 1, assigned_driver_user_id: M }))) || ''), 'management member as driver: rejected');
ok(/assigned_driver_not_driver/.test(await err(P, call(O, JSON.stringify({ rate: 1, assigned_driver_user_id: D2 }))) || ''), 'other company’s driver: rejected');
ok(/assigned_driver_not_driver/.test(await err(P, call(O, JSON.stringify({ rate: 1, assigned_driver_user_id: X }))) || ''), 'non-member as driver: rejected');
// Field + stop validation (whole call rolls back)
ok(/bad_rate/.test(await err(P, call(O, JSON.stringify({ broker_name: 'x' }))) || ''), 'rate required');
ok(/bad_rate/.test(await err(P, call(O, JSON.stringify({ rate: -1 }))) || ''), 'negative rate');
ok(/bad_number/.test(await err(P, call(O, JSON.stringify({ rate: 'abc' }))) || ''), 'non-numeric rate');
ok(/bad_status/.test(await err(P, call(O, JSON.stringify({ rate: 1, status: 'lost' }))) || ''), 'bad status');
ok(/bad_miles/.test(await err(P, call(O, JSON.stringify({ rate: 1, total_miles: 0 }))) || ''), 'bad miles');
ok(/bad_patch/.test(await err(P, call(O, JSON.stringify({ rate: 1, notes: 'x'.repeat(4001) }))) || ''), 'notes too long');
ok(/bad_stops/.test(await err(P, call(O, LOAD, JSON.stringify([{ stop_type: 'pickup', city: 'A' }]))) || ''), 'one stop: bad_stops');
ok(/missing_delivery/.test(await err(P, call(O, LOAD, JSON.stringify([{ stop_type: 'pickup', city: 'A' }, { stop_type: 'pickup', city: 'B' }]))) || ''), 'needs a delivery');
ok(/stop_city_required/.test(await err(P, call(O, LOAD, JSON.stringify([{ stop_type: 'pickup', city: '' }, { stop_type: 'delivery', city: 'B' }]))) || ''), 'city required');
ok(/bad_state/.test(await err(P, call(O, LOAD, JSON.stringify([{ stop_type: 'pickup', city: 'A', state: 'Cal' }, { stop_type: 'delivery', city: 'B' }]))) || ''), 'bad state');
ok(/bad_stops/.test(await err(P, call(O, LOAD, JSON.stringify([{ stop_type: 'pickup', city: 'A', pickup_number: 'x'.repeat(81) }, { stop_type: 'delivery', city: 'B' }]))) || ''), 'pickup # too long');
const someStop = (await su(`select id from public.stops limit 1`)).rows[0].id;
ok(/bad_stops/.test(await err(P, call(O, LOAD, JSON.stringify([{ id: String(someStop), stop_type: 'pickup', city: 'A' }, { stop_type: 'delivery', city: 'B' }]))) || ''), 'existing stop id rejected (no stealing stops)');
ok((await count()) === n, 'every rejected call left no load behind (rolled back)');
// Sam's fixes: show_rate_to_driver cast outside the bad_number handler (like dispatch_update_load)
n = await count();
const eb = await err(P, call(O, JSON.stringify({ rate: 1, assigned_driver_user_id: D, show_rate_to_driver: 'maybe' }))) || '';
ok(eb && !/bad_number/.test(eb) && /boolean/i.test(eb), 'non-boolean show_rate_to_driver: Postgres boolean error, not bad_number');
ok((await count()) === n, 'bad boolean left no load behind');
// Two company_profiles rows for one owner (impossible today: unique(owner_id)) → oldest is used, no error
await suExec(`alter table public.company_profiles drop constraint company_profiles_owner_unique;
  insert into public.company_profiles (id, owner_id, legal_name, created_at) values ('33333333-3333-3333-3333-333333333333','${O}','DUP FAKE Co', now() + interval '1 day');`);
const idDup = (await as(P, call(O)))[0].v;
ok(idDup && (await su(`select user_id from public.loads where id = '${idDup}'`)).rows[0].user_id === O, 'duplicate owner profile: dispatcher of the oldest profile still creates the load');
// Grants
const g = (await su(`select has_function_privilege('anon', 'public.dispatch_create_load(uuid, jsonb, jsonb)', 'execute') a,
  has_function_privilege('authenticated', 'public.dispatch_create_load(uuid, jsonb, jsonb)', 'execute') u,
  (select prosecdef from pg_proc where proname = 'dispatch_create_load') d,
  (select array_to_string(proconfig, ',') from pg_proc where proname = 'dispatch_create_load') c`)).rows[0];
ok(g.a === false && g.u === true, 'anon cannot execute; authenticated can');
ok(g.d === true && /search_path=public/.test(g.c || ''), 'SECURITY DEFINER with search_path set');
console.log(fails ? `${fails} FAILED` : 'all passed');
