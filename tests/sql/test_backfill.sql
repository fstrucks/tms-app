-- Seeds stops/documents in the LOCAL test DB, runs 0750 PART 1 (preview) and PART 2 (update), checks results.
\set ON_ERROR_STOP 1
create table public.documents (id uuid primary key default gen_random_uuid(), load_id uuid, doc_type text, ai_extracted_data jsonb, created_at timestamptz default now());
create table public.stops (id serial primary key, load_id uuid, stop_type text, sequence int, company_name text, address_line1 text,
  city text, state text, zip text, appointment_start timestamptz, notes text, timezone text);
insert into public.documents (load_id, doc_type, ai_extracted_data) values
 ('00000000-0000-0000-0000-000000000001', 'rate_confirmation',
  '{"pickup":{"address":"123 Main St, Atlanta, Georgia 30303"},"delivery":{"address":null},"receiver":{"address":"1 Rd, Chicago, IL 606011234"}}');
insert into public.stops (id, load_id, stop_type, sequence, address_line1, city, state, zip, appointment_start, notes, timezone) values
 -- 1 affected: doc source, Georgia -> New_York. 08:00 PT stored, should become 08:00 ET.
 (1, '00000000-0000-0000-0000-000000000001', 'pickup', 1, '123 Main St, Atlanta, Georgia 30303', null, null, null,
  '2026-10-15 08:00'::timestamp at time zone 'America/Los_Angeles', 'TZ: America/Los_Angeles', 'America/Los_Angeles'),
 -- 2 already parsed (state IL): untouched
 (2, '00000000-0000-0000-0000-000000000001', 'delivery', 2, '1 Rd', 'Chicago', 'IL', '60601', '2026-10-16 09:00-05', 'TZ: America/Chicago', 'America/Chicago'),
 -- 3 affected, no document: address_line1 fallback, no-comma "Atlanta GA 30303", fallback zone America/Denver (non-default p_tz)
 (3, '00000000-0000-0000-0000-000000000002', 'pickup', 1, 'Atlanta GA 30303', null, null, null,
  '2026-10-15 08:00'::timestamp at time zone 'America/Denver', 'TZ: America/Denver', 'America/Denver'),
 -- 4 still unparseable: untouched
 (4, '00000000-0000-0000-0000-000000000002', 'delivery', 2, '1600 Pennsylvania Ave, Washington', null, null, null,
  '2026-10-15 08:00-07', 'TZ: America/Los_Angeles', 'America/Los_Angeles'),
 -- 6 affected, sequence 3 on load 1: must use its OWN fields, not the rate con
 (6, '00000000-0000-0000-0000-000000000001', 'delivery', 3, '9 Elm St, Dallas, Texas 75201', null, null, null,
  '2026-10-17 10:00'::timestamp at time zone 'America/Los_Angeles', null, 'America/Los_Angeles'),
 -- 5 state null but no timezone: untouched
 (5, '00000000-0000-0000-0000-000000000003', 'pickup', 1, 'Atlanta, Georgia 30303', null, null, null, null, null, null);
create temp table snap as select * from public.stops;
create temp table r(name text, ok boolean);


-- PART 1 (as a temp table so it can be checked); must change nothing.
\i /tmp/bf_part1.sql
insert into r select 'preview lists exactly stops 1, 3, 6', array_agg(id order by id) = array[1,3,6] from preview;
insert into r select 'preview: stop 1 new GA/New_York, 08:00 ET', new_state='GA' and new_city='Atlanta' and new_zip='30303' and new_timezone='America/New_York'
  and new_appointment_start_utc = '2026-10-15 08:00'::timestamp at time zone 'America/New_York' from preview where id=1;
insert into r select 'preview: stop 3 from address_line1 (no doc), Denver -> New_York', new_state='GA' and new_city='Atlanta'
  and old_timezone='America/Denver' and new_appointment_start_utc = '2026-10-15 08:00'::timestamp at time zone 'America/New_York' from preview where id=3;
insert into r select 'preview changed nothing', not exists (select * from public.stops except select * from snap);

insert into r select 'preview: sources', array_agg(source order by id) = array['rate_con','stop_fields','stop_fields'] from preview;
insert into r select 'preview: stop 6 from own fields (TX)', new_state='TX' and new_city='Dallas' and stop_type='delivery' and sequence=3 from preview where id=6;
insert into r select 'preview: local times', old_appointment_local='2026-10-15 08:00:00' and new_appointment_local='2026-10-15 08:00:00'
  and old_address_line1='123 Main St, Atlanta, Georgia 30303' from preview where id=1;

-- PART 2 (uncommented by the runner)
\i /tmp/bf_part2.sql
insert into r select 'update: stop 1', state='GA' and city='Atlanta' and zip='30303' and address_line1='123 Main St' and timezone='America/New_York'
  and appointment_start = '2026-10-15 08:00'::timestamp at time zone 'America/New_York' and notes='TZ: America/New_York' from public.stops where id=1;
insert into r select 'update: stop 3', state='GA' and city='Atlanta' and address_line1 is null and timezone='America/New_York'
  and appointment_start = '2026-10-15 12:00Z' and notes='TZ: America/New_York' from public.stops where id=3;
insert into r select 'update: stop 6', state='TX' and timezone='America/Chicago' and appointment_start='2026-10-17 15:00Z' from public.stops where id=6;
insert into r select 'update: stops 2, 4, 5 untouched', not exists (select * from public.stops where id in (2,4,5) except select * from snap);
\i /tmp/bf_part1.sql
insert into r select 'preview empty after update', count(*) = 0 from preview;

\pset footer off
select case when ok then 'PASS' else 'FAIL' end as res, name from r;
select count(*) filter (where ok) as passed, count(*) filter (where ok is not true) as failed from r;
do $$ begin if exists (select 1 from r where ok is not true) then raise exception 'backfill tests failed'; end if; end $$;
