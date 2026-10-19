// Migration 20261018000700 (dispatch center) on top of 0600, against an in-memory Postgres (PGlite, WASM).
// LOCAL ONLY: never touches Supabase. Run: npm i --no-save @electric-sql/pglite && node tests/sql/dispatch_center.pglite.mjs
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
const O = '00000000-0000-0000-0000-00000000000a', D = '00000000-0000-0000-0000-00000000000d', P = '00000000-0000-0000-0000-00000000000b', M = '00000000-0000-0000-0000-00000000000c', X = '00000000-0000-0000-0000-0000000000ee';
const L1 = 'aaaaaaaa-0000-0000-0000-000000000001', L2 = 'aaaaaaaa-0000-0000-0000-000000000002', XL = 'aaaaaaaa-0000-0000-0000-0000000000ff';
await db.exec(`insert into auth.users values ('${O}','owner@example.com'),('${D}','driver@example.com'),('${P}','dispatch@example.com'),('${M}','mgmt@example.com'),('${X}','other-owner@example.com');
insert into public.company_profiles (id, owner_id, legal_name) values ('11111111-1111-1111-1111-111111111111', '${O}', 'FAKE Trucking LLC'), ('22222222-2222-2222-2222-222222222222', '${X}', 'Other FAKE Co');
insert into public.company_members values ('11111111-1111-1111-1111-111111111111','${D}','driver'),('11111111-1111-1111-1111-111111111111','${P}','dispatcher'),('11111111-1111-1111-1111-111111111111','${M}','management');
insert into public.loads (id, user_id, status, rate, total_miles, notes, assigned_driver_user_id) values
 ('${L1}','${O}','booked',1800,720,'Refs: PU# 1. Pay $1800 to carrier','${D}'), ('${L2}','${O}','in_transit',900,600,null,null), ('${XL}','${X}','booked',5000,1000,null,null);
insert into public.stops (load_id, stop_type, sequence, city, state, lat, geocode_address) values ('${L1}','pickup',1,'Ontario','CA',34,'x'),('${L1}','delivery',2,'Phoenix','AZ',33,'y');
insert into public.documents (user_id, load_id, doc_type, file_path) values ('${O}','${L1}','rate_confirmation','${O}/rc.pdf');`);
const as = async (uid, sql) => { await db.exec(`reset role; select set_config('request.jwt.claim.sub', '${uid}', false); set role authenticated;`); return (await db.query(sql)).rows; };
const err = async (uid, sql) => { try { await as(uid, sql); return null; } catch (e) { return e.message; } };

let rows = await as(P, 'select * from public.dispatch_context()');
ok(rows.length === 1 && rows[0].owner_id === O && rows[0].role === 'dispatcher' && rows[0].company_name === 'FAKE Trucking LLC', 'dispatch_context: dispatcher → owner company');
ok((await as(O, 'select * from public.dispatch_context()')).length === 0, 'dispatch_context: owner gets none');
ok((await as(D, 'select * from public.dispatch_context()')).length === 0, 'dispatch_context: driver gets none');
rows = (await as(P, 'select v from public.dispatch_loads() v')).map((r) => r.v);
ok(rows.length === 2 && rows.every((r) => r.owner_id === O), 'dispatcher lists only the owner company loads (not other companies)');
const r1 = rows.find((r) => r.id === L1);
ok(Number(r1.rate) === 1800 && r1.has_rate_con === true && r1.stops.length === 2 && !('user_id' in r1) && !('route_geometry' in r1), 'dispatcher sees rate, rate con flag, stops');
ok((await as(M, 'select v from public.dispatch_loads() v')).length === 2, 'management lists 2');
ok((await as(D, 'select v from public.dispatch_loads() v')).length === 0, 'driver gets nothing from dispatch_loads');
ok((await as(O, 'select v from public.dispatch_loads() v')).length === 0, 'owner gets nothing from dispatch_loads (uses /loads)');
ok((await as(P, 'select rate from public.loads')).length === 0, 'own-row RLS untouched: dispatcher direct select = 0 rows');

// Load updates
let out = (await as(P, `select public.dispatch_update_load('${L1}', '{"notes": "Refs: PU# 1", "rate": "2000", "show_rate_to_driver": true, "broker_name": "  Demo Broker (FAKE) "}'::jsonb) v`))[0].v;
ok(out.notes === 'Refs: PU# 1' && Number(out.rate) === 2000 && out.show_rate_to_driver === true && out.broker_name === 'Demo Broker (FAKE)', 'dispatcher edits notes, rate, flag, trims text');
ok(Number(out.rate_per_mile) === 2.78, 'rate_per_mile recomputed by the trigger');
ok(out.total_miles != null && out.status === 'booked' && out.assigned_driver_user_id === D, 'absent keys keep their value');
out = (await as(M, `select public.dispatch_update_load('${L1}', '{"total_miles": 800, "status": "dispatched", "assigned_driver_user_id": null}'::jsonb) v`))[0].v;
ok(Number(out.total_miles) === 800 && out.miles_source === 'typed' && out.status === 'dispatched' && out.assigned_driver_user_id === null, 'management edits miles (→ typed), status, unassigns');
ok(/not_allowed/.test(await err(D, `select public.dispatch_update_load('${L1}', '{"notes": "x"}'::jsonb)`) || ''), 'driver: not_allowed');
ok(/load_not_found/.test(await err(P, `select public.dispatch_update_load('${XL}', '{"notes": "x"}'::jsonb)`) || ''), 'other company load: load_not_found');
ok(/bad_status/.test(await err(P, `select public.dispatch_update_load('${L1}', '{"status": "lost"}'::jsonb)`) || ''), 'bad status rejected');
ok(/bad_rate/.test(await err(P, `select public.dispatch_update_load('${L1}', '{"rate": -5}'::jsonb)`) || ''), 'negative rate rejected');
ok(/assigned_driver_not_driver/.test(await err(P, `select public.dispatch_update_load('${L1}', '{"assigned_driver_user_id": "${M}"}'::jsonb)`) || ''), 'assigning a non-driver rejected');
await as(P, `select public.dispatch_update_load('${L1}', '{"assigned_driver_user_id": "${D}"}'::jsonb)`);
await db.exec(`reset role; delete from public.company_members where user_id = '${D}';`);
ok((await err(P, `select public.dispatch_update_load('${L1}', '{"notes": "still editable"}'::jsonb)`)) === null, 'driver left the company: unrelated edit still works');
await db.exec(`reset role; insert into public.company_members values ('11111111-1111-1111-1111-111111111111','${D}','driver');`);

// Stops
const st0 = (await as(P, `select v from public.dispatch_loads('${L1}') v`))[0].v.stops;
const keepPu = st0[0].id, delId = st0[1].id;
const payload = JSON.stringify([
  { id: keepPu, stop_type: 'pickup', company_name: ' Acme (FAKE) ', city: 'Ontario', state: 'ca', pickup_number: 'PU-1', lat: 'garbage' },
  { stop_type: 'pickup', city: 'Riverside', state: 'CA', pickup_number: 'PU-2' },
  { stop_type: 'delivery', city: 'Tucson', state: 'AZ', appointment_start: '2026-10-20T15:00:00Z' },
]);
const saved = (await as(P, `select public.dispatch_save_stops('${L1}', '${payload}'::jsonb) v`))[0].v;
ok(saved.length === 3 && saved.map((s) => s.sequence).join() === '1,2,3', '3 stops, renumbered 1..3');
ok(saved[0].id === keepPu && saved[0].company_name === 'Acme (FAKE)' && saved[0].state === 'CA' && saved[0].pickup_number === 'PU-1' && saved[0].lat === 34, 'update keeps id; trims, upper-cases; ignores non-allowed keys (lat untouched)');
ok(!saved.some((s) => s.id === delId), 'stop missing from the list is deleted');
ok(saved[2].appointment_start && saved[2].city === 'Tucson', 'new delivery inserted with appointment');
ok(/missing_delivery/.test(await err(P, `select public.dispatch_save_stops('${L1}', '[{"stop_type":"pickup","city":"A"},{"stop_type":"pickup","city":"B"}]'::jsonb)`) || ''), 'needs a delivery');
ok(/stop_city_required/.test(await err(P, `select public.dispatch_save_stops('${L1}', '[{"stop_type":"pickup","city":""},{"stop_type":"delivery","city":"B"}]'::jsonb)`) || ''), 'city required');
ok(/bad_state/.test(await err(P, `select public.dispatch_save_stops('${L1}', '[{"stop_type":"pickup","city":"A","state":"Cal"},{"stop_type":"delivery","city":"B"}]'::jsonb)`) || ''), 'bad state');
ok(/bad_stops/.test(await err(P, `select public.dispatch_save_stops('${L1}', '[{"id":"999999","stop_type":"pickup","city":"A"},{"stop_type":"delivery","city":"B"}]'::jsonb)`) || ''), 'foreign / unknown stop id rejected');
ok(/not_allowed/.test(await err(D, `select public.dispatch_save_stops('${L1}', '${payload}'::jsonb)`) || ''), 'driver cannot save stops');
ok(/load_not_found/.test(await err(P, `select public.dispatch_save_stops('${XL}', '${payload}'::jsonb)`) || ''), 'other company: load_not_found');
ok((await as(O, `select count(*)::int n from public.stops where load_id = '${L1}'`))[0].n === 3, 'owner sees the dispatcher’s stops via normal RLS');
// Driver read path still masks
await as(P, `select public.dispatch_update_load('${L1}', '{"show_rate_to_driver": false}'::jsonb)`);
const dv = (await as(D, `select v from public.visible_loads() v`)).map((r) => r.v);
ok(dv.length === 1 && dv[0].rate === null && dv[0].notes === 'still editable', 'driver: rate masked again, sees the dispatcher’s cleaned notes');
console.log(fails ? `${fails} FAILED` : 'all passed');
