// Migration 20261127000100 (multi-stop rate cons) against an in-memory Postgres (PGlite, WASM).
// LOCAL ONLY: never touches Supabase. Fake data only.
// Run: npm i --no-save @electric-sql/pglite && node tests/sql/multistop_ratecon.pglite.mjs
// Each create function is run on the same fake rate cons BEFORE (latest old definitions) and AFTER the migration:
// 2-stop and invalid stops[] must give the exact same stop rows; 3- and 5-stop rate cons get every stop in order.
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
const R = process.env.MIG_DIR || new URL('../../supabase/migrations/', import.meta.url).pathname;
const read = (f) => readFileSync(R + f, 'utf8');
const fn = (file, name) => { const t = read(file); const i = t.indexOf(`create or replace function public.${name}(`); if (i < 0) throw new Error(`${name} not in ${file}`); return t.slice(i, t.indexOf('$$;', t.indexOf('$$', t.indexOf('$$', i) + 2)) + 3); };
let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.error('FAIL', m); process.exitCode = 1; } else console.log('ok', m); };

const O = '00000000-0000-0000-0000-00000000000a', P = '00000000-0000-0000-0000-00000000000b';
const C1 = '11111111-1111-1111-1111-111111111111', E1 = '33333333-3333-3333-3333-333333333333';
const MIG = read('20261127000100_multistop_ratecon.sql');

async function setup(withNew) {
  const db = new PGlite();
  await db.exec(`
create role anon; create role authenticated;
create schema auth;
create table auth.users (id uuid primary key, email text);
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
grant usage on schema auth to authenticated, anon; grant execute on function auth.uid() to authenticated, anon;
create table public.loads (id uuid primary key default gen_random_uuid(), user_id uuid not null, status text, broker_name text, broker_load_number text,
  rate numeric, total_miles numeric, miles_source text, weight numeric, equipment_type text, notes text, created_at timestamptz default now());
create table public.stops (id serial primary key, load_id uuid references public.loads(id) on delete cascade, stop_type text, sequence int, company_name text, address_line1 text,
  city text, state text, zip text, appointment_start timestamptz, timezone text, notes text, pickup_number text);
create table public.documents (id uuid primary key default gen_random_uuid(), user_id uuid, load_id uuid, ai_extracted_data jsonb, file_path text, doc_type text,
  source text, inbound_email_id uuid);
create table public.inbound_emails (id uuid primary key, company_id uuid);
alter table public.documents enable row level security;
create policy documents_all_own on public.documents for all to authenticated using (user_id = auth.uid());
grant select, insert, update on public.documents to authenticated; grant select, insert on public.loads, public.stops to authenticated;
grant usage, select on sequence public.stops_id_seq to authenticated;
grant usage on schema public to authenticated, anon;
`);
  await db.exec(fn('20261010000660_stop_timezones.sql', 'us_state_tz'));
  await db.exec(fn('20261012000740_address_parser_fixes.sql', 'parse_us_address'));
  await db.exec('grant execute on function public.parse_us_address(text), public.us_state_tz(text) to authenticated');
  await db.exec(read('20261015001200_company_profiles.sql'));
  await db.exec(fn('20261022150000_company_email_ratecons.sql', 'email_doc_company'));
  // Facility directory: table + the latest trigger logic (20261022190000 + 20261022230000).
  const fac = read('20261022190000_facility_reviews.sql');
  await db.exec(fn('20261022190000_facility_reviews.sql', 'facility_norm') + fn('20261022190000_facility_reviews.sql', 'facility_key'));
  await db.exec(fac.slice(fac.indexOf('create table if not exists public.facilities'), fac.indexOf('-- 3. Link stops on write')));
  await db.exec('alter table public.stops add column if not exists facility_id uuid null references public.facilities(id) on delete set null;');
  for (const n of ['facility_stop_name', 'facility_loose_key', 'facility_resolve', 'stops_link_facility']) await db.exec(fn('20261022230000_facility_keep_and_autolink.sql', n));
  await db.exec(`create trigger stops_link_facility before insert or update of company_name, address_line1, city, state, zip, stop_type on public.stops
    for each row execute function public.stops_link_facility();`);
  // The three create functions as they are today (latest definitions) + their grants.
  await db.exec(fn('20261010000680_stops_timezone.sql', 'create_load_from_document') + `
    revoke execute on function public.create_load_from_document(uuid, text) from public, anon;
    grant execute on function public.create_load_from_document(uuid, text) to authenticated;`);
  await db.exec(fn('20261022150000_company_email_ratecons.sql', 'create_load_from_email_document') + `
    revoke all on function public.create_load_from_email_document(uuid, text) from public, anon; grant execute on function public.create_load_from_email_document(uuid, text) to authenticated;`);
  await db.exec(fn('20261022250000_ratecon_upload_company_owner.sql', 'create_load_from_company_upload') + `
    revoke all on function public.create_load_from_company_upload(uuid, text, uuid) from public, anon; grant execute on function public.create_load_from_company_upload(uuid, text, uuid) to authenticated;`);
  if (withNew) { await db.exec(MIG); await db.exec(MIG); } // idempotent
  await db.exec(`insert into auth.users values ('${O}','o@example.com'),('${P}','p@example.com');
    insert into public.company_profiles (id, owner_id, legal_name) values ('${C1}','${O}','FAKE Co');
    insert into public.company_members (profile_id, user_id, role) values ('${C1}','${P}','dispatcher');
    insert into public.inbound_emails values ('${E1}','${C1}');`);
  return db;
}

// Fake rate cons.
const base = { broker_name: 'FAKE Broker', load_number: 'T-1', rate: 2500, reference_numbers: ['PU# 111'],
  shipper: { name: 'FAKE Shipper A', address: '100 Test Rd, Lathrop, CA 95330' }, receiver: { name: 'FAKE Receiver C', address: '9 Main St, Hillsboro, OR 97124' },
  pickup: { date: '2026-11-30', time: '08:00', address: '100 Test Rd, Lathrop, CA 95330', pickup_number: '111' }, delivery: { date: '2026-12-02', time: '08:00-14:00', address: '9 Main St, Hillsboro, OR 97124' } };
const st = (type, name, address, date, time) => ({ type, name, address, street: null, city: null, state: null, zip: null, date, time, ref_number: null });
const sA = st('pickup', 'FAKE Shipper A', '100 Test Rd, Lathrop, CA 95330', '2026-11-30', '08:00');
const sB = st('delivery', 'FAKE Middle B', '55 Dock Ave, Warrenton, OR 97146', '2026-12-01', '10:00');
const sC = st('delivery', 'FAKE Receiver C', '9 Main St, Hillsboro, OR 97124', '2026-12-02', '08:00-14:00');
const sP2 = { ...st('pickup', 'FAKE Shipper P2', null, '2026-11-30', 'bad time'), street: '7 Mill St', city: 'Stockton', state: 'CA', zip: '95202' };
const sD = st('delivery', 'FAKE Receiver D', '1 Port Way, Boise, ID 83702', 'not a date', null);
const CASES = {
  twoOld: base, // no stops[] (old app / old scans)
  twoNew: { ...base, stops: [sA, sC] }, // the new app's 2-stop list
  three: { ...base, stops: [sA, sB, sC] },
  five: { ...base, stops: [sA, sP2, sB, sD, sC] },
  badType: { ...base, stops: [sA, { ...sB, type: 'fuel' }, sC] },
  noDelivery: { ...base, stops: [sA, { ...sB, type: 'pickup' }, { ...sC, type: 'pickup' }] },
  notArray: { ...base, stops: { 0: sA } },
  emptyEntry: { ...base, stops: [sA, st('delivery', null, null, null, null), sC] },
  scalarEntry: { ...base, stops: [sA, 'x', sC] },
  over20: { ...base, stops: [sA, ...Array.from({ length: 19 }, (_, i) => st('delivery', `FAKE D${i}`, `${i + 1} Elm St, Reno, NV 89501`, null, null)), sC] },
  exactly20: { ...base, stops: [sA, ...Array.from({ length: 18 }, (_, i) => st('delivery', `FAKE E${i}`, `${i + 1} Oak St, Reno, NV 89501`, null, null)), sC] },
  noTop: { broker_name: 'FAKE', stops: [sA, sB, sC] }, // stops[] only
  emptyTop: { broker_name: 'FAKE' }, // nothing: old behaviour (2 empty stops)
};

const COLS = 'stop_type, sequence, company_name, address_line1, city, state, zip, appointment_start, notes, timezone';
async function runAll(db) {
  const out = {};
  for (const [fnName, mk] of [
    ['document', async (x) => (await db.query(`insert into public.documents (user_id, ai_extracted_data) values ($1, $2::jsonb) returning id`, [O, x])).rows[0].id],
    ['email', async (x) => (await db.query(`insert into public.documents (user_id, ai_extracted_data, source, inbound_email_id) values ($1, $2::jsonb, 'email', $3) returning id`, [O, x, E1])).rows[0].id],
    ['upload', async (x) => (await db.query(`insert into public.documents (user_id, ai_extracted_data) values ($1, $2::jsonb) returning id`, [P, x])).rows[0].id],
  ]) {
    for (const [k, x] of Object.entries(CASES)) {
      await db.exec('reset role');
      const doc = await mk(JSON.stringify(x));
      const uid = fnName === 'upload' ? P : O;
      await db.exec(`set request.jwt.claim.sub = '${uid}'; set role authenticated`);
      let id;
      try {
        const sql = fnName === 'document' ? `select public.create_load_from_document($1, 'America/Chicago') id`
          : fnName === 'email' ? `select public.create_load_from_email_document($1, 'America/Chicago') id`
            : `select public.create_load_from_company_upload($1, 'America/Chicago', '${C1}') id`;
        id = (await db.query(sql, [doc])).rows[0].id;
      } catch (e) { out[`${fnName}:${k}`] = { err: e.message }; continue; } finally { await db.exec('reset role'); }
      out[`${fnName}:${k}`] = { id, stops: (await db.query(`select ${COLS} from public.stops where load_id = $1 order by sequence`, [id])).rows,
        load: (await db.query(`select user_id, status, broker_name, broker_load_number, rate, notes from public.loads where id = $1`, [id])).rows[0] };
    }
  }
  return { out, db };
}

const before = await runAll(await setup(false));
const after = await runAll(await setup(true));
const A = after.out, B = before.out, db = after.db;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const fallback = ['twoOld', 'twoNew', 'badType', 'noDelivery', 'notArray', 'emptyEntry', 'scalarEntry', 'over20', 'emptyTop'];
for (const f of ['document', 'email', 'upload']) {
  for (const k of Object.keys(CASES)) ok(!A[`${f}:${k}`].err && !B[`${f}:${k}`].err, `${f}:${k} creates a load before and after (${A[`${f}:${k}`].err || B[`${f}:${k}`].err || 'ok'})`);
  for (const k of fallback) ok(same(A[`${f}:${k}`].stops, B[`${f}:${k}`].stops) && A[`${f}:${k}`].stops.length === 2, `${f}:${k} → the same 2 stop rows as before`);
  for (const k of Object.keys(CASES)) ok(same(A[`${f}:${k}`].load, B[`${f}:${k}`].load), `${f}:${k} → load row unchanged`);
  const three = A[`${f}:three`].stops;
  ok(three.length === 3 && same(three.map((s) => [s.sequence, s.stop_type, s.company_name, s.city, s.state]),
    [[1, 'pickup', 'FAKE Shipper A', 'Lathrop', 'CA'], [2, 'delivery', 'FAKE Middle B', 'Warrenton', 'OR'], [3, 'delivery', 'FAKE Receiver C', 'Hillsboro', 'OR']]), `${f}: 3-stop rate con → 3 stops in order`);
  // The first and last stops are built exactly like the old pickup / delivery rows.
  ok(same({ ...three[0], sequence: 1 }, B[`${f}:three`].stops[0]) && same({ ...three[2], sequence: 2 }, B[`${f}:three`].stops[1]), `${f}: 3-stop first / last rows = the old pickup / delivery rows`);
  const five = A[`${f}:five`].stops;
  ok(five.length === 5 && same(five.map((s) => [s.sequence, s.stop_type, s.company_name]),
    [[1, 'pickup', 'FAKE Shipper A'], [2, 'pickup', 'FAKE Shipper P2'], [3, 'delivery', 'FAKE Middle B'], [4, 'delivery', 'FAKE Receiver D'], [5, 'delivery', 'FAKE Receiver C']]), `${f}: 5-stop rate con → 5 stops in order`);
  ok(five[1].address_line1 === '7 Mill St' && five[1].city === 'Stockton' && five[1].zip === '95202' && five[1].appointment_start && /Time: bad time/.test(five[1].notes || ''), `${f}: street/city/state/zip compose the address; unparsed time kept in notes`);
  ok(five[3].appointment_start === null && /Appointment: not a date/.test(five[3].notes || '') && five[3].timezone === 'America/Boise', `${f}: unparsed date → no appointment, raw in notes, Idaho zone`);
  ok(five[2].timezone === 'America/Los_Angeles' && five[0].timezone === 'America/Los_Angeles', `${f}: per-stop time zones`);
  ok(A[`${f}:exactly20`].stops.length === 20 && A[`${f}:exactly20`].stops[19].company_name === 'FAKE Receiver C', `${f}: 20 stops → all 20`);
  ok(A[`${f}:over20`].stops.length === 2, `${f}: 21 stops → falls back to 2 (not capped)`);
  ok(A[`${f}:noTop`].stops.length === 3, `${f}: stops[] without top-level fields → 3 stops`);
}

// Facilities: every stop (middle ones too) is saved to the directory, and stays after the load is deleted.
const L = A['upload:five'].id;
const facs = (await db.query(`select f.name from public.stops s join public.facilities f on f.id = s.facility_id where s.load_id = $1 order by s.sequence`, [L])).rows.map((r) => r.name);
ok(same(facs, ['FAKE Shipper A', 'FAKE Shipper P2', 'FAKE Middle B', 'FAKE Receiver D', 'FAKE Receiver C']), 'facility auto-save covers all 5 stops');
await db.exec(`delete from public.loads where id = '${L}'`);
const left = (await db.query(`select count(*)::int n from public.facilities where name in ('FAKE Middle B', 'FAKE Shipper P2', 'FAKE Receiver D')`)).rows[0].n;
ok(left === 3, 'middle-stop facilities survive load deletion');

// Helper: signature, grants, and the old functions' security / signatures are unchanged.
const g = (await db.query(`select has_function_privilege('anon', 'public.ratecon_load_stops(jsonb)', 'execute') a, has_function_privilege('authenticated', 'public.ratecon_load_stops(jsonb)', 'execute') u`)).rows[0];
ok(!g.a && g.u, 'ratecon_load_stops: execute authenticated only');
const meta = (await db.query(`select proname, pg_get_function_identity_arguments(p.oid) args, pg_get_function_result(p.oid) res, prosecdef, proconfig from pg_proc p
  where proname in ('create_load_from_document', 'create_load_from_email_document', 'create_load_from_company_upload') order by proname`)).rows;
ok(same(meta.map((m) => [m.proname, m.args, m.res, m.prosecdef, m.proconfig]), [
  ['create_load_from_company_upload', 'p_document uuid, p_tz text, p_profile uuid', 'uuid', true, ['search_path=public']],
  ['create_load_from_document', 'p_document uuid, p_tz text', 'uuid', false, ['search_path=public']],
  ['create_load_from_email_document', 'p_document uuid, p_tz text', 'uuid', true, ['search_path=public']],
]), 'same signatures, return type, security and search_path');
for (const [sig] of [['public.create_load_from_document(uuid,text)'], ['public.create_load_from_email_document(uuid,text)'], ['public.create_load_from_company_upload(uuid,text,uuid)']]) {
  const r = (await db.query(`select has_function_privilege('anon', '${sig}', 'execute') a, has_function_privilege('authenticated', '${sig}', 'execute') u`)).rows[0];
  ok(!r.a && r.u, `${sig}: execute authenticated only`);
}
if (fails) console.error(`${fails} failed`); else console.log('all passed');
