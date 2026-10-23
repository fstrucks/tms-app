// Migration 20261023000400 (maintenance schedules fixes, after 0300) against PGlite (in-memory, WASM). LOCAL ONLY, fake TEST data.
// Run: npm i --no-save @electric-sql/pglite && node tests/sql/maintenance_schedules_fix.pglite.mjs
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
grant usage on schema public to authenticated, anon;
create table public.trucks (id uuid primary key, user_id uuid not null, unit_number text, odometer integer, make text, model text, year integer, vin text);
alter table public.trucks enable row level security;
create table public.loads (id uuid primary key default gen_random_uuid(), user_id uuid not null, truck_id uuid, assigned_driver_user_id uuid,
  status text default 'booked', broker_name text, broker_load_number text, created_at timestamptz default now(), updated_at timestamptz default now());
alter table public.loads enable row level security;
create policy loads_select_own on public.loads for select to authenticated using (user_id = auth.uid());
grant select, insert, update, delete on public.loads to authenticated;
create table public.expenses (id uuid primary key default gen_random_uuid(), user_id uuid not null, category text, amount numeric, expense_date date,
  description text, load_id uuid, document_id uuid);
alter table public.expenses enable row level security;
create table public.documents (id uuid primary key default gen_random_uuid(), user_id uuid, load_id uuid, truck_id uuid, doc_type text,
  file_path text, original_filename text, created_at timestamptz default now());
alter table public.documents enable row level security;
create policy documents_select_own on public.documents for select to authenticated using (user_id = auth.uid());
create policy documents_insert_own on public.documents for insert to authenticated
  with check (user_id = auth.uid() and split_part(file_path, '/', 1) = auth.uid()::text
    and (load_id is null or exists (select 1 from public.loads l where l.id = documents.load_id and l.user_id = auth.uid())));
grant select on public.documents to authenticated;
grant insert (user_id, load_id, truck_id, doc_type, file_path, original_filename) on public.documents to authenticated;
grant update (load_id, truck_id, doc_type) on public.documents to authenticated;
create table public.drivers (id uuid primary key default gen_random_uuid(), user_id uuid, name text, truck_id uuid, auth_user_id uuid, active boolean default true);
`);
await db.exec(readFileSync(R + '20261015001200_company_profiles.sql', 'utf8'));
await db.exec(readFileSync(R + '20261023000100_maintenance_log.sql', 'utf8'));
await db.exec(readFileSync(R + '20261023000200_maintenance_log_fix.sql', 'utf8'));

const FIX = readFileSync(R + '20261023000400_maintenance_schedules_fix.sql', 'utf8');
ok(!/[^\x00-\x7F]/.test(FIX), '0400 is plain ASCII');
let guardErr = null; try { await db.exec(FIX); } catch (e) { guardErr = e.message; }
ok(/Run 20261023000300/.test(guardErr || ''), '0400 aborts when 0300 is missing');
await db.exec(readFileSync(R + '20261023000300_maintenance_schedules.sql', 'utf8'));

const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const O = id(1), M = id(2), P = id(3), D = id(4), D2 = id(5), X = id(9);
const C1 = id(101), C2 = id(102), T1 = id(201), T2 = id(202), TX = id(209);
await db.exec(`insert into auth.users (id) values ('${O}'),('${M}'),('${P}'),('${D}'),('${D2}'),('${X}');
insert into public.company_profiles (id, owner_id, legal_name) values ('${C1}','${O}','TEST Trucking Co'),('${C2}','${X}','TEST Other Co');
insert into public.company_members (profile_id, user_id, role) values ('${C1}','${M}','management'),('${C1}','${P}','dispatcher'),('${C1}','${D}','driver'),('${C1}','${D2}','driver');
insert into public.trucks (id, user_id, unit_number, odometer) values ('${T1}','${O}','TEST-T1',400000),('${T2}','${O}','TEST-T2',100000),('${TX}','${X}','TEST-X',1000);
insert into public.drivers (user_id, name, truck_id, auth_user_id) values ('${O}','TEST Linked','${T1}','${D}');`);
const as = async (uid, sql, params = []) => {
  await db.exec(`reset role; set request.jwt.claim.sub = '${uid}'; set role authenticated`);
  try { return { rows: (await db.query(sql, params)).rows }; } catch (e) { return { err: e.message }; } finally { await db.exec('reset role'); }
};
const sys = async (sql, p = []) => (await db.query(sql, p)).rows;


// Duplicates saved by the old setup (two Oil & filter baselines), to check the one-time cleanup.
const oldA = (await sys(`insert into public.service_records (truck_id, owner_id, service_date, odometer, total_cost, entry_source, created_at) values ($1,$2,'2026-10-01',399000,0,'baseline', now() - interval '1 hour') returning id`, [T1, O]))[0].id;
const oldB = (await sys(`insert into public.service_records (truck_id, owner_id, service_date, odometer, total_cost, entry_source) values ($1,$2,'2026-10-01',399000,0,'baseline') returning id`, [T1, O]))[0].id;
await sys(`insert into public.service_record_items (service_record_id, service_type) values ($1,'oil_filter'),($1,'coolant'),($2,'oil_filter')`, [oldA, oldB]);
const logged = (await sys(`insert into public.service_records (truck_id, owner_id, service_date, odometer, total_cost, entry_source) values ($1,$2,'2026-08-01',380000,0,'logged') returning id`, [T1, O]))[0].id;
await sys(`insert into public.service_record_items (service_record_id, service_type) values ($1,'oil_filter')`, [logged]);

await db.exec(FIX);
await db.exec(FIX);
ok(true, '0400 applies twice');
const items = async (t = T1) => sys(`select i.service_type, r.entry_source, r.service_date::text d, r.odometer from public.service_record_items i join public.service_records r on r.id = i.service_record_id where r.truck_id = $1 order by 1, 2`, [t]);
let it = await items();
ok(it.filter((x) => x.service_type === 'oil_filter' && x.entry_source === 'baseline').length === 1, 'cleanup: one Oil & filter baseline left');
ok(it.some((x) => x.service_type === 'coolant') && it.some((x) => x.entry_source === 'logged'), 'cleanup: other services and logged visits kept');
ok((await sys(`select count(*)::int n from public.service_records where id = $1`, [oldA]))[0].n === 1, 'cleanup: visit that still has a service kept');
ok((await sys(`select count(*)::int n from pg_proc where proname = 'pm_la_today'`))[0].n === 0, 'pm_la_today dropped');

// pm_today: America/Chicago without a stored zone; a time zone column is used when present and valid.
const chi = (await sys(`select (now() at time zone 'America/Chicago')::date::text d`))[0].d;
ok((await as(O, `select public.pm_today($1)::text d`, [T1])).rows[0].d === chi, 'pm_today: America/Chicago by default');
await sys(`alter table public.company_profiles add column time_zone text`);
await sys(`update public.company_profiles set time_zone = 'Pacific/Kiritimati' where owner_id = $1`, [O]);
const kir = (await sys(`select (now() at time zone 'Pacific/Kiritimati')::date::text d`))[0].d;
ok((await as(O, `select public.pm_today($1)::text d`, [T1])).rows[0].d === kir, 'pm_today: company time zone when stored');
await sys(`update public.company_profiles set time_zone = 'Not/AZone' where owner_id = $1`, [O]);
ok((await as(O, `select public.pm_today($1)::text d`, [T1])).rows[0].d === chi, 'pm_today: invalid zone -> America/Chicago');
ok((await as(X, `select public.pm_today($1)::text d`, [T1])).rows[0].d === chi, 'pm_today: other company sees only the default');
await sys(`alter table public.company_profiles drop column time_zone`);

// Setup on a known engine; suggested rows mirror the template.
await sys(`update public.trucks set engine_make = 'Detroit', engine_model = 'DD15', duty_cycle = 'long_haul', mpg = 7.5 where id = $1`, [T1]);
ok(!(await as(O, `select public.pm_setup_schedules($1)`, [T1])).err, 'setup DD15');
const sch = async (t = T1) => Object.fromEntries((await sys(`select service_type, source, template_id, interval_miles, interval_days from public.pm_schedules where truck_id = $1`, [t])).map((r) => [r.service_type, r]));
const sugg = async (t = T1) => Object.fromEntries((await sys(`select s.* from public.trucks t, public.pm_suggest(t.engine_make, t.engine_model, t.duty_cycle, t.mpg) s where t.id = $1`, [t])).map((r) => [r.service_type, r]));
let s1 = await sch(), g1 = await sugg();
ok(Object.keys(g1).every((k) => s1[k] && s1[k].template_id === g1[k].template_id && s1[k].interval_miles === g1[k].interval_miles && s1[k].interval_days === g1[k].interval_days), 'setup: every suggestion saved with its template intervals');

// Item 7: trigger copies intervals from the template when source = suggested.
await sys(`delete from public.pm_schedules where truck_id = $1 and service_type = 'oil_filter'`, [T1]);
const ins = await as(M, `insert into public.pm_schedules (truck_id, service_type, interval_miles, interval_days, source, template_id) values ($1, 'oil_filter', 5, 5, 'suggested', $2) returning interval_miles, interval_days`, [T1, g1.oil_filter.template_id]);
ok(ins.rows?.[0]?.interval_miles === g1.oil_filter.interval_miles && ins.rows[0].interval_days === g1.oil_filter.interval_days, 'trigger: suggested insert takes template intervals, not client numbers');
await as(O, `update public.pm_schedules set interval_miles = 12345, source = 'custom' where truck_id = $1 and service_type = 'oil_filter'`, [T1]);
const back = await as(O, `update public.pm_schedules set source = 'suggested' where truck_id = $1 and service_type = 'oil_filter' returning interval_miles`, [T1]);
ok(back.rows[0].interval_miles === g1.oil_filter.interval_miles, 'trigger: back to suggested resets to template intervals');
const edit = await as(O, `update public.pm_schedules set interval_miles = 11111 where truck_id = $1 and service_type = 'oil_filter' returning source, interval_miles`, [T1]);
ok(edit.rows[0].source === 'custom' && edit.rows[0].interval_miles === 11111, 'trigger: editing numbers still makes it custom');
const wrongT = Object.values(await sugg()).find((r) => r.service_type !== 'coolant');
ok((await as(O, `update public.pm_schedules set source = 'suggested', template_id = $2 where truck_id = $1 and service_type = 'coolant'`, [T1, wrongT.template_id])).err, 'trigger: template for another service rejected');

// Item 3: engine switch. Make 'coolant' custom (kept), add a suggested row the generic list does not have.
await as(O, `update public.pm_schedules set interval_miles = 99999 where truck_id = $1 and service_type = 'coolant'`, [T1]);
await sys(`update public.trucks set engine_make = null, engine_model = null, duty_cycle = 'unknown', mpg = null where id = $1`, [T1]);
const gen = await sugg();
// A suggested schedule from the old engine for a service the generic list does not have.
const ex = (await sys(`select m.id, m.service_type from public.maintenance_interval_templates m where not m.is_generic and m.service_type <> all($1::text[]) and m.service_type <> all($2::text[]) and (m.interval_miles is not null or m.interval_days is not null) limit 1`, [Object.keys(gen), Object.keys(await sch())]))[0];
const extra = ex?.service_type;
ok(!!extra, `old engine schedule outside the generic list (${extra})`);
await sys(`insert into public.pm_schedules (truck_id, service_type, source, template_id) values ($1, $2, 'suggested', $3)`, [T1, extra, ex.id]);
ok(!(await as(M, `select public.pm_setup_schedules($1)`, [T1])).err, 'rerun setup after engine switch (management)');
const s2 = await sch();
ok(!s2[extra], 'switch: suggested schedule not in the new list deleted');
ok(s2.coolant?.source === 'custom' && s2.coolant.interval_miles === 99999, 'switch: custom schedule kept as is');
ok(s2.oil_filter?.source === 'custom', 'switch: custom oil schedule kept');
ok(Object.entries(s2).filter(([, r]) => r.source === 'suggested').every(([k, r]) => gen[k] && r.template_id === gen[k].template_id && r.interval_miles === gen[k].interval_miles && r.interval_days === gen[k].interval_days), 'switch: remaining suggested schedules point at the new template and intervals');
ok(Object.keys(gen).every((k) => s2[k]), 'switch: every new suggestion present');
ok((await as(D, `select public.pm_setup_schedules($1)`, [T1])).err, 'setup: driver not allowed');

// Item 2: baseline save, rerun replaces.
const base = (g) => as(O, `select public.pm_save_baseline($1, $2::jsonb) n`, [T1, JSON.stringify(g)]);
ok((await base([{ service_date: '2026-10-05', odometer: 399500, items: ['oil_filter', 'air_filter'] }])).rows?.[0]?.n === 1, 'baseline: saved');
ok((await base([{ service_date: '2026-10-05', odometer: 399500, items: ['oil_filter', 'air_filter'] }])).rows?.[0]?.n === 1, 'baseline: rerun same values');
it = await items();
const bl = (t) => it.filter((x) => x.service_type === t && x.entry_source === 'baseline');
ok(bl('oil_filter').length === 1 && bl('air_filter').length === 1 && bl('oil_filter')[0].d === '2026-10-05', 'baseline: rerun did not duplicate items');
ok((await sys(`select count(*)::int n from public.service_records where truck_id = $1 and entry_source = 'baseline' and service_date = '2026-10-05'`, [T1]))[0].n === 1, 'baseline: rerun did not duplicate visits');
await base([{ service_date: '2026-10-10', odometer: 399800, items: ['oil_filter'] }]);
it = await items();
ok(bl('oil_filter').length === 1 && bl('oil_filter')[0].d === '2026-10-10' && bl('air_filter').length === 1, 'baseline: new date replaces the earlier entry, others kept');
ok(it.filter((x) => x.entry_source === 'logged').length === 1, 'baseline: logged visits untouched');
ok((await sys(`select count(*)::int n from public.service_records r where r.truck_id = $1 and r.entry_source = 'baseline' and not exists (select 1 from public.service_record_items i where i.service_record_id = r.id)`, [T1]))[0].n === 0, 'baseline: no empty baseline visits left');
ok((await sys(`select count(*)::int n from public.expenses`))[0].n === 0, 'baseline: no expenses');
ok((await as(M, `select public.pm_save_baseline($1, '[{"service_date":"2026-10-01","items":["grease"]}]'::jsonb)`, [T1])).err, 'baseline: management cannot');
ok((await as(X, `select public.pm_save_baseline($1, '[{"service_date":"2026-10-01","items":["grease"]}]'::jsonb)`, [T1])).err, 'baseline: other company cannot');
ok((await base([{ service_date: '2099-01-01', items: ['grease'] }])).err, 'baseline: future date rejected');
ok((await base([{ service_date: '2026-10-01', odometer: 999999, items: ['grease'] }])).err, 'baseline: miles above odometer rejected');
ok((await base([{ service_date: '2026-10-01', items: ['bogus'] }])).err, 'baseline: unknown service rejected');

// Item 1: due soon = within 10% of interval miles or 14 days.
const at = async (interval, left, days = null) => {
  await sys(`delete from public.service_records where truck_id = $1`, [T2]);
  await sys(`delete from public.pm_schedules where truck_id = $1`, [T2]);
  await sys(`update public.trucks set odometer = $2 where id = $1`, [T2, 100000 + interval - left]);
  await sys(`insert into public.pm_schedules (truck_id, service_type, interval_miles, interval_days, source) values ($1,'oil_filter',$2,$3,'custom')`, [T2, interval, days]);
  const r = (await sys(`insert into public.service_records (truck_id, owner_id, service_date, odometer, total_cost, entry_source) values ($1,$2,'2026-10-01',100000,0,'logged') returning id`, [T2, O]))[0].id;
  await sys(`insert into public.service_record_items (service_record_id, service_type) values ($1,'oil_filter')`, [r]);
  return (await as(O, `select status, miles_left from public.pm_status_for($1, '2026-10-23')`, [T2])).rows[0];
};
for (const [iv, left, want] of [[15000, 1501, 'ok'], [15000, 1500, 'due_soon'], [15000, 400, 'due_soon'], [4000, 401, 'ok'], [4000, 400, 'due_soon'], [25000, 2500, 'due_soon'], [25000, 2501, 'ok'], [15000, 0, 'due_soon'], [15000, -1, 'overdue'], [1005, 101, 'ok'], [1005, 100, 'due_soon']]) {
  const r = await at(iv, left);
  ok(r.status === want && r.miles_left === left, `status: ${left} of ${iv} mi left -> ${want} (got ${r.status})`);
}
ok((await at(15000, 10000, 36)).status === 'due_soon', 'status: 14 days left -> due_soon');
ok((await at(15000, 10000, 37)).status === 'ok', 'status: 15 days left -> ok');
const def = (await as(O, `select status from public.pm_status_for($1)`, [T2])).rows[0];
ok(!!def, 'status: works without p_today (company day)');

console.log(fails ? `${fails} FAILED` : 'all passed');
