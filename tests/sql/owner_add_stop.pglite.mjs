// Owner's load page + Add stop (Nov 27, 2026): no SQL change; the owner saves through the EXISTING
// public.dispatch_save_stops (migration 20261018000700). This checks the owner path against an in-memory Postgres
// (PGlite, WASM). LOCAL ONLY: never touches Supabase. Fake data only.
// Run: npm i --no-save @electric-sql/pglite && node tests/sql/owner_add_stop.pglite.mjs
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
create table public.stops (id serial primary key, load_id uuid references public.loads(id), stop_type text, sequence int, company_name text, address_line1 text, address_line2 text,
  city text, state text, zip text, appointment_start timestamptz, appointment_end timestamptz, timezone text, notes text, contact_name text, contact_phone text,
  lat double precision, geocode_address text, completed_at timestamptz, completion text, arrived_at timestamptz);
create table public.documents (id uuid primary key default gen_random_uuid(), user_id uuid, load_id uuid, doc_type text, file_path text);
grant usage on schema public to authenticated, anon;
`);
await db.exec(readFileSync(R + '20261010000400_loads.sql', 'utf8').split('-- documents.load_id')[0]);
await db.exec(readFileSync(R + '20261015001200_company_profiles.sql', 'utf8'));
await db.exec(`grant select, insert, update, delete on public.company_profiles, public.company_members to authenticated;`);
await db.exec(readFileSync(R + '20261018000600_load_driver_rate_members.sql', 'utf8'));
await db.exec(readFileSync(R + '20261018000700_dispatch_center.sql', 'utf8'));
const O = '00000000-0000-0000-0000-00000000000a', D = '00000000-0000-0000-0000-00000000000d', X = '00000000-0000-0000-0000-0000000000ee';
const L1 = 'aaaaaaaa-0000-0000-0000-000000000001', XL = 'aaaaaaaa-0000-0000-0000-0000000000ff';
await db.exec(`insert into auth.users values ('${O}','owner@example.com'),('${D}','driver@example.com'),('${X}','other-owner@example.com');
insert into public.company_profiles (id, owner_id, legal_name) values ('11111111-1111-1111-1111-111111111111', '${O}', 'FAKE Trucking LLC'), ('22222222-2222-2222-2222-222222222222', '${X}', 'Other FAKE Co');
insert into public.company_members values ('11111111-1111-1111-1111-111111111111','${D}','driver');
insert into public.loads (id, user_id, status, rate, total_miles, miles_source, assigned_driver_user_id) values ('${L1}','${O}','in_transit',1800,720,'rate_con','${D}'), ('${XL}','${X}','booked',5000,1000,null,null);
insert into public.stops (load_id, stop_type, sequence, city, state, pickup_number, lat, geocode_address, completed_at, completion, contact_name, contact_phone) values
 ('${L1}','pickup',1,'Lathrop','CA','PU-777',37.8,'Lathrop, CA','2026-11-27T16:00:00Z','done','Pat (FAKE)','555-0100'),
 ('${L1}','delivery',2,'Hillsboro','OR',null,45.5,'Hillsboro, OR',null,null,null,null);`);
const as = async (uid, sql) => { await db.exec(`reset role; select set_config('request.jwt.claim.sub', '${uid}', false); set role authenticated;`); return (await db.query(sql)).rows; };
const err = async (uid, sql) => { try { await as(uid, sql); return null; } catch (e) { return e.message; } };

const st0 = await as(O, `select id, stop_type from public.stops where load_id = '${L1}' order by sequence`);
const [pu, del] = st0.map((r) => String(r.id));
// What the owner page sends (formToStops): kept stops by id (with contact fields carried), a new middle delivery.
const payload = JSON.stringify([
  { id: pu, stop_type: 'pickup', city: 'Lathrop', state: 'CA', pickup_number: 'PU-777', contact_name: 'Pat (FAKE)', contact_phone: '555-0100' },
  { stop_type: 'delivery', company_name: 'Middle DC (FAKE)', address_line1: '1 Test Rd', city: 'Warrenton', state: 'or', zip: '97146', notes: 'Delivery # MID-1', pickup_number: null },
  { id: del, stop_type: 'delivery', city: 'Hillsboro', state: 'OR', pickup_number: null },
]);
const saved = (await as(O, `select public.dispatch_save_stops('${L1}', '${payload}'::jsonb) v`))[0].v;
ok(saved.length === 3 && saved.map((s) => s.city).join() === 'Lathrop,Warrenton,Hillsboro', 'owner: new delivery inserted in the middle, order kept');
ok(saved.map((s) => s.sequence).join() === '1,2,3', 'renumbered 1..3');
ok(String(saved[0].id) === pu && String(saved[2].id) === del, 'kept stops keep their ids');
ok(saved[0].completed_at && saved[0].completion === 'done', 'check-off on a kept stop is untouched');
ok(saved[0].lat === 37.8 && saved[2].lat === 45.5, 'map pins on kept stops untouched (address unchanged → no re-geocode)');
ok(saved[0].contact_name === 'Pat (FAKE)' && saved[0].contact_phone === '555-0100', 'contact fields carried through are kept');
ok(saved[1].state === 'OR' && saved[1].notes === 'Delivery # MID-1' && saved[1].pickup_number === null && saved[1].completed_at === null, 'new delivery: no pickup #, delivery # in notes, not done');
const ld = (await as(O, `select total_miles, miles_source from public.loads where id = '${L1}'`))[0];
ok(Number(ld.total_miles) === 720 && ld.miles_source === 'rate_con', 'planned miles not touched by a stops save');

// Extra pickup before the first delivery.
const now = (await as(O, `select id from public.stops where load_id = '${L1}' order by sequence`)).map((r) => String(r.id));
const p2 = JSON.stringify([{ id: now[0], stop_type: 'pickup', city: 'Lathrop', state: 'CA', pickup_number: 'PU-777', contact_name: 'Pat (FAKE)', contact_phone: '555-0100' },
  { stop_type: 'pickup', city: 'Tracy', state: 'CA', pickup_number: 'PU-2' },
  { id: now[1], stop_type: 'delivery', city: 'Warrenton', state: 'OR', notes: 'Delivery # MID-1' }, { id: now[2], stop_type: 'delivery', city: 'Hillsboro', state: 'OR' }]);
const s2 = (await as(O, `select public.dispatch_save_stops('${L1}', '${p2}'::jsonb) v`))[0].v;
ok(s2.map((s) => `${s.stop_type}:${s.city}`).join() === 'pickup:Lathrop,pickup:Tracy,delivery:Warrenton,delivery:Hillsboro' && s2[1].pickup_number === 'PU-2', 'owner: extra pickup with its Pickup #');

// Guards
ok(/not_allowed/.test(await err(D, `select public.dispatch_save_stops('${L1}', '${p2}'::jsonb)`) || ''), 'assigned driver cannot add stops');
ok(/load_not_found/.test(await err(O, `select public.dispatch_save_stops('${XL}', '[{"stop_type":"pickup","city":"A"},{"stop_type":"delivery","city":"B"}]'::jsonb)`) || ''), 'another company’s load: load_not_found');
ok(/bad_stops/.test(await err(O, `select public.dispatch_save_stops('${L1}', '[{"stop_type":"delivery","city":"A"}]'::jsonb)`) || ''), 'fewer than 2 stops rejected');
const many = JSON.stringify(Array.from({ length: 21 }, (_, i) => ({ stop_type: i ? 'delivery' : 'pickup', city: 'Fakeville' })));
ok(/bad_stops/.test(await err(O, `select public.dispatch_save_stops('${L1}', '${many}'::jsonb)`) || ''), 'more than 20 stops rejected');
ok(/missing_pickup/.test(await err(O, `select public.dispatch_save_stops('${L1}', '[{"stop_type":"delivery","city":"A"},{"stop_type":"delivery","city":"B"}]'::jsonb)`) || ''), 'needs a pickup');
ok((await as(O, `select count(*)::int n from public.stops where load_id = '${L1}'`))[0].n === 4, 'failed saves changed nothing');
console.log(fails ? `${fails} FAILED` : 'all passed');
