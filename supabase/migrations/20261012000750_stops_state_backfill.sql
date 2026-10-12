-- Stops state/zone backfill. Run ONLY after 20261012000740_address_parser_fixes.sql.
-- Two parts. Run PART 1 (read-only preview) first and send the output to Taylor.
-- Only after Taylor's OK, run PART 2 (the UPDATE, commented out below), which is wrapped in a transaction.
--
-- Which stops: state IS NULL (the old parser found no state) AND timezone IS NOT NULL. A stop without a
-- state can only have got its zone from the fallback (the caller's p_tz, normally 'America/Los_Angeles').
-- The re-parse must now yield a state that has a known zone.
--
-- Address source: stops do not store the raw address. Best source first:
--   1) only for stops with sequence 1 and 2 (the ones create_load_from_document made): the rate confirmation
--      the load was created from: documents.load_id = stops.load_id,
--      doc_type 'rate_confirmation', the oldest one. Same field order as create_load_from_document:
--      pickup -> ai_extracted_data.pickup.address, else shipper.address;
--      delivery -> delivery.address, else receiver.address.
--   2) otherwise (and always for stops with other sequences) address_line1 + city + zip. When the old parser found no state, address_line1 holds the
--      whole normalised address, so this is nearly lossless.
-- Appointment: the same wall-clock time re-read in the new zone:
--   (appointment_start at time zone old_tz) at time zone new_tz.

-- =====================================================================
-- PART 1: PREVIEW (read-only, changes nothing)
-- Local times: *_appointment_local is the wall-clock time in the old/new zone (same by design).
-- =====================================================================
with src0 as (
  select s.*,
         case when s.sequence in (1, 2) then
           (select coalesce(nullif(trim(d.ai_extracted_data -> (case when s.stop_type = 'pickup' then 'pickup' else 'delivery' end) ->> 'address'), ''),
                            nullif(trim(d.ai_extracted_data -> (case when s.stop_type = 'pickup' then 'shipper' else 'receiver' end) ->> 'address'), ''))
              from public.documents d
             where d.load_id = s.load_id and d.doc_type = 'rate_confirmation' and jsonb_typeof(d.ai_extracted_data) = 'object'
             order by d.created_at nulls last, d.id
             limit 1)
         end as rc_address
    from public.stops s
   where s.state is null and s.timezone is not null
), src as (
  select src0.*,
         case when rc_address is not null then 'rate_con' else 'stop_fields' end as source,
         coalesce(rc_address,
                  nullif(concat_ws(', ', nullif(trim(address_line1), ''), nullif(trim(city), ''), nullif(trim(zip), '')), '')) as raw_address
    from src0
), parsed as (
  select src.*, p.line1 as new_line1, p.city as new_city, p.state as new_state, p.zip as new_zip,
         public.us_state_tz(p.state) as new_timezone
    from src cross join lateral public.parse_us_address(src.raw_address) p
)
select id, load_id, stop_type, sequence, source, raw_address,
       address_line1 as old_address_line1, city as old_city, state as old_state, zip as old_zip, timezone as old_timezone,
       appointment_start as old_appointment_start_utc,
       (appointment_start at time zone timezone)::text as old_appointment_local,
       new_line1, new_city, new_state, new_zip, new_timezone,
       (appointment_start at time zone timezone) at time zone new_timezone as new_appointment_start_utc,
       (((appointment_start at time zone timezone) at time zone new_timezone) at time zone new_timezone)::text as new_appointment_local
  from parsed
 where new_state is not null and new_timezone is not null
 order by load_id, sequence, id;

-- =====================================================================
-- PART 2: UPDATE. Run only after the PART 1 output has been reviewed.
-- Remove the leading "-- " from every line between the markers, then run just this part.
-- =====================================================================
-- >>> PART 2 START
-- begin;
-- with src0 as (
--   select s.*,
--          case when s.sequence in (1, 2) then
--            (select coalesce(nullif(trim(d.ai_extracted_data -> (case when s.stop_type = 'pickup' then 'pickup' else 'delivery' end) ->> 'address'), ''),
--                             nullif(trim(d.ai_extracted_data -> (case when s.stop_type = 'pickup' then 'shipper' else 'receiver' end) ->> 'address'), ''))
--               from public.documents d
--              where d.load_id = s.load_id and d.doc_type = 'rate_confirmation' and jsonb_typeof(d.ai_extracted_data) = 'object'
--              order by d.created_at nulls last, d.id
--              limit 1)
--          end as rc_address
--     from public.stops s
--    where s.state is null and s.timezone is not null
-- ), src as (
--   select src0.*,
--          case when rc_address is not null then 'rate_con' else 'stop_fields' end as source,
--          coalesce(rc_address,
--                   nullif(concat_ws(', ', nullif(trim(address_line1), ''), nullif(trim(city), ''), nullif(trim(zip), '')), '')) as raw_address
--     from src0
-- ), parsed as (
--   select src.*, p.line1 as new_line1, p.city as new_city, p.state as new_state, p.zip as new_zip,
--          public.us_state_tz(p.state) as new_timezone
--     from src cross join lateral public.parse_us_address(src.raw_address) p
-- )
-- update public.stops s
--    set address_line1 = p.new_line1,
--        city = p.new_city,
--        state = p.new_state,
--        zip = p.new_zip,
--        timezone = p.new_timezone,
--        appointment_start = (s.appointment_start at time zone p.timezone) at time zone p.new_timezone,
--        notes = regexp_replace(s.notes, '(^|\n)TZ: \S+', '\1TZ: ' || p.new_timezone)
--   from parsed p
--  where s.id = p.id
--    and s.state is null and s.timezone = p.timezone
--    and p.new_state is not null and p.new_timezone is not null;
-- commit;
-- <<< PART 2 END
