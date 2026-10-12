-- Stops state/zone backfill. Run ONLY after 20261012000740_address_parser_fixes.sql.
-- Two parts. Run PART 1 (read-only preview) first and send the output to Taylor.
-- Only after Taylor's OK, run PART 2 (the UPDATE, commented out below), which is wrapped in a transaction.
--
-- Which stops: state IS NULL (the old parser found no state) AND timezone IS NOT NULL. A stop without a
-- state can only have got its zone from the fallback (the caller's p_tz, normally 'America/Los_Angeles').
-- The re-parse must now yield a state that has a known zone.
--
-- Address source: stops do not store the raw address. Best source first:
--   1) the rate confirmation the load was created from: documents.load_id = stops.load_id,
--      doc_type 'rate_confirmation', the oldest one. Same field order as create_load_from_document:
--      pickup -> ai_extracted_data.pickup.address, else shipper.address;
--      delivery -> delivery.address, else receiver.address.
--   2) otherwise address_line1 + city + zip. When the old parser found no state, address_line1 holds the
--      whole normalised address, so this is nearly lossless.
-- Appointment: the same wall-clock time re-read in the new zone:
--   (appointment_start at time zone old_tz) at time zone new_tz.

-- =====================================================================
-- PART 1: PREVIEW (read-only, changes nothing)
-- =====================================================================
with src as (
  select s.id, s.load_id, s.city, s.state, s.zip, s.timezone, s.appointment_start,
         coalesce(
           (select coalesce(nullif(trim(d.ai_extracted_data -> (case when s.stop_type = 'pickup' then 'pickup' else 'delivery' end) ->> 'address'), ''),
                            nullif(trim(d.ai_extracted_data -> (case when s.stop_type = 'pickup' then 'shipper' else 'receiver' end) ->> 'address'), ''))
              from public.documents d
             where d.load_id = s.load_id and d.doc_type = 'rate_confirmation' and jsonb_typeof(d.ai_extracted_data) = 'object'
             order by d.created_at nulls last, d.id
             limit 1),
           nullif(concat_ws(', ', nullif(trim(s.address_line1), ''), nullif(trim(s.city), ''), nullif(trim(s.zip), '')), '')
         ) as raw_address
    from public.stops s
   where s.state is null and s.timezone is not null
), parsed as (
  select src.*, p.line1 as new_line1, p.city as new_city, p.state as new_state, p.zip as new_zip,
         public.us_state_tz(p.state) as new_timezone
    from src cross join lateral public.parse_us_address(src.raw_address) p
)
select id, load_id, raw_address,
       city as old_city, state as old_state, zip as old_zip, timezone as old_timezone, appointment_start as old_appointment_start,
       new_line1, new_city, new_state, new_zip, new_timezone,
       (appointment_start at time zone timezone) at time zone new_timezone as new_appointment_start
  from parsed
 where new_state is not null and new_timezone is not null
 order by load_id, id;

-- =====================================================================
-- PART 2: UPDATE. Run only after the PART 1 output has been reviewed.
-- Remove the leading "-- " from every line between the markers, then run just this part.
-- =====================================================================
-- >>> PART 2 START
-- begin;
-- with src as (
--   select s.id, s.timezone,
--          coalesce(
--            (select coalesce(nullif(trim(d.ai_extracted_data -> (case when s.stop_type = 'pickup' then 'pickup' else 'delivery' end) ->> 'address'), ''),
--                             nullif(trim(d.ai_extracted_data -> (case when s.stop_type = 'pickup' then 'shipper' else 'receiver' end) ->> 'address'), ''))
--               from public.documents d
--              where d.load_id = s.load_id and d.doc_type = 'rate_confirmation' and jsonb_typeof(d.ai_extracted_data) = 'object'
--              order by d.created_at nulls last, d.id
--              limit 1),
--            nullif(concat_ws(', ', nullif(trim(s.address_line1), ''), nullif(trim(s.city), ''), nullif(trim(s.zip), '')), '')
--          ) as raw_address
--     from public.stops s
--    where s.state is null and s.timezone is not null
-- ), parsed as (
--   select src.id, src.timezone as old_tz, p.line1, p.city, p.state, p.zip, public.us_state_tz(p.state) as new_tz
--     from src cross join lateral public.parse_us_address(src.raw_address) p
-- )
-- update public.stops s
--    set address_line1 = p.line1,
--        city = p.city,
--        state = p.state,
--        zip = p.zip,
--        timezone = p.new_tz,
--        appointment_start = (s.appointment_start at time zone p.old_tz) at time zone p.new_tz,
--        notes = regexp_replace(s.notes, '(^|\n)TZ: \S+', '\1TZ: ' || p.new_tz)
--   from parsed p
--  where s.id = p.id
--    and s.state is null and s.timezone = p.old_tz
--    and p.state is not null and p.new_tz is not null;
-- commit;
-- <<< PART 2 END
