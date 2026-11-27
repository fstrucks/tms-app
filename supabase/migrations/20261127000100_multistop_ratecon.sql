-- 20261127000100: multi-stop rate cons (bug fix, Nov 27 2026). NOT APPLIED: SQL review first, then apply.
-- Bug: a rate con with more than 2 stops became a 2-stop load (first pickup + last delivery); the middle stops were
-- dropped. The rate con reading now also saves every stop in order as ai_extracted_data.stops[] (app/lib/rateconStops.js).
-- ADDITIVE, idempotent (create or replace only; nothing dropped, no table or data change):
--   1. NEW public.ratecon_load_stops(jsonb): the stops a load gets from a rate con's extracted data.
--      * stops[] is used when it is an array of 3 to 20 entries, every entry an object with type 'pickup' or 'delivery'
--        and a name, address, street or city, and at least one pickup and one delivery. Sequence = 1..N in array order.
--        Same checks as dispatch_save_stops (2–20 stops, pickup / delivery only, one of each) except city is not
--        required (the old rate con path doesn't require it either).
--      * Anything else (no stops[], 2 entries, an invalid entry, 21+ entries) → EXACTLY the old 2 rows:
--        (1, 'pickup', shipper, pickup), (2, 'delivery', receiver, delivery), each '{}' when not an object.
--        21+ is NOT capped: capping could drop the final delivery. The app shows a note and Dispatch can add the rest.
--   2. create_load_from_document / create_load_from_email_document / create_load_from_company_upload: same
--      signatures, return type, security (document: invoker; email + upload: definer), search_path, revoke / grant.
--      Bodies copied from their latest definitions (0680, 20261022150000, 20261022250000); the ONLY change is the stop
--      loop's source (the values list → ratecon_load_stops(v_x)) and its two v_party / v_when lines, which now take the
--      helper's party / stop objects (the helper builds the same '{}'-when-not-object values the old lines built).
--      Every stop still goes through the same address parsing, time zone, appointment and insert code.
-- Facilities: the stops_link_facility trigger (20261022230000) runs for every pickup / delivery insert, so middle
-- stops are saved to the facility directory too; facilities aren't tied to loads and survive load deletion.
-- Deploy order: either is safe. Old SQL ignores stops[] (top-level pickup / delivery are still filled); new SQL with
-- rows that have no stops[] (old app, old scans) makes the same 2 stops as today.
begin;

create or replace function public.ratecon_load_stops(p_x jsonb)
returns table (seq int, kind text, party jsonb, stop jsonb)
language sql
immutable
set search_path = public
as $$
  with list as (
    select e.value as s, e.ordinality::int as n
      from jsonb_array_elements(case when jsonb_typeof(p_x->'stops') = 'array' then p_x->'stops' else '[]'::jsonb end) with ordinality as e
  ), ok as (
    select coalesce(count(*) between 3 and 20
       and bool_and(jsonb_typeof(s) = 'object'
             and coalesce(s->>'type', '') in ('pickup', 'delivery')
             and coalesce(nullif(btrim(coalesce(s->>'name', '')), ''), nullif(btrim(coalesce(s->>'address', '')), ''),
                          nullif(btrim(coalesce(s->>'street', '')), ''), nullif(btrim(coalesce(s->>'city', '')), '')) is not null)
       and bool_or(s->>'type' = 'pickup')
       and bool_or(s->>'type' = 'delivery'), false) as yes
      from list
  )
  select l.n, l.s->>'type',
         jsonb_build_object('name', l.s->'name', 'address', l.s->'address'),
         jsonb_build_object('date', l.s->'date', 'time', l.s->'time', 'address', to_jsonb(coalesce(
           nullif(btrim(coalesce(l.s->>'address', '')), ''),
           nullif(concat_ws(', ', nullif(btrim(coalesce(l.s->>'street', '')), ''),
             nullif(btrim(concat_ws(' ', nullif(concat_ws(', ', nullif(btrim(coalesce(l.s->>'city', '')), ''), nullif(btrim(coalesce(l.s->>'state', '')), '')), ''),
               nullif(btrim(coalesce(l.s->>'zip', '')), ''))), '')), ''))))
    from list l
   where (select yes from ok)
  union all
  select t.seq, t.kind,
         case when jsonb_typeof(p_x->t.party) = 'object' then p_x->t.party else '{}'::jsonb end,
         case when jsonb_typeof(p_x->t.stop)  = 'object' then p_x->t.stop  else '{}'::jsonb end
    from (values (1, 'pickup', 'shipper', 'pickup'), (2, 'delivery', 'receiver', 'delivery')) as t(seq, kind, party, stop)
   where not (select yes from ok)
   order by 1;
$$;
-- create_load_from_document is security invoker, so the caller needs execute on the helper. It only reads its argument.
-- The Documents page also calls it (with an empty object) to check whether this migration is applied.
revoke all on function public.ratecon_load_stops(jsonb) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on function public.ratecon_load_stops(jsonb) from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'grant execute on function public.ratecon_load_stops(jsonb) to authenticated'; end if;
end $$;

-- 2a. Legacy upload RPC (latest: 20261010000680_stops_timezone.sql). Security invoker, unchanged.
create or replace function public.create_load_from_document(p_document uuid, p_tz text default 'America/Los_Angeles')
returns uuid
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_tz text;
  v_stop_tz text;
  v_doc record;
  v_x jsonb;
  v_load uuid;
  v_notes text;
  v_s record;
  v_party jsonb;
  v_when jsonb;
  v_addr text;
  v_line1 text;
  v_city text;
  v_state text;
  v_zip text;
  v_date text;
  v_time text;
  v_appt timestamptz;
  v_stop_notes text;
begin
  -- Use the caller's IANA timezone if valid, else the default.
  v_tz := case when p_tz is not null and exists (select 1 from pg_timezone_names where name = p_tz)
               then p_tz else 'America/Los_Angeles' end;

  select id, user_id, load_id, ai_extracted_data
    into v_doc
    from public.documents
   where id = p_document
     for update;

  if not found or v_doc.user_id is distinct from auth.uid() then
    raise exception 'document_not_found' using errcode = 'P0001';
  end if;
  if v_doc.load_id is not null then
    raise exception 'already_linked' using errcode = 'P0001', detail = v_doc.load_id::text;
  end if;
  v_x := v_doc.ai_extracted_data;
  if v_x is null or jsonb_typeof(v_x) <> 'object' then
    raise exception 'no_extracted_data' using errcode = 'P0001';
  end if;

  -- No reference column on loads: fold reference numbers into notes.
  v_notes := nullif(concat_ws(E'\n',
    nullif(v_x->>'notes', ''),
    case when jsonb_typeof(v_x->'reference_numbers') = 'array'
              and jsonb_array_length(v_x->'reference_numbers') > 0
         then 'Refs: ' || (select string_agg(r, ', ') from jsonb_array_elements_text(v_x->'reference_numbers') r)
    end
  ), '');

  insert into public.loads (user_id, status, broker_name, broker_load_number, rate, notes)
  values (
    auth.uid(),
    'booked',
    nullif(v_x->>'broker_name', ''),
    nullif(v_x->>'load_number', ''),
    case when jsonb_typeof(v_x->'rate') = 'number' then (v_x->>'rate')::numeric end,
    v_notes
  )
  returning id into v_load;

  -- 20261127000100: the rate con's stops in order (public.ratecon_load_stops): all of stops[] when it has 3 to 20
  -- valid entries, else the same 2 stops as before (shipper + pickup, receiver + delivery).
  for v_s in
    select * from public.ratecon_load_stops(v_x) order by seq
  loop
    v_party := v_s.party;
    v_when  := v_s.stop;
    v_addr  := coalesce(nullif(trim(v_when->>'address'), ''), nullif(trim(v_party->>'address'), ''));
    -- Hardened parsing (see public.parse_us_address).
    select p.line1, p.city, p.state, p.zip into v_line1, v_city, v_state, v_zip
      from public.parse_us_address(v_addr) p;

    -- Each stop uses its state's time zone when known, else the caller's p_tz.
    v_stop_tz := coalesce(public.us_state_tz(v_state), v_tz);

    -- Appointment: date + time when both parse; else date only; else null. Raw values kept in notes.
    v_date := nullif(trim(v_when->>'date'), '');
    v_time := nullif(trim(v_when->>'time'), '');
    v_appt := null;
    v_stop_notes := null;
    if v_date is not null then
      begin
        v_appt := (v_date || ' ' || coalesce(v_time, '00:00'))::timestamp at time zone v_stop_tz;
      exception when others then
        begin
          v_appt := v_date::date::timestamp at time zone v_stop_tz;
          if v_time is not null then v_stop_notes := 'Time: ' || v_time; end if;
        exception when others then
          v_appt := null;
          v_stop_notes := concat_ws(' ', 'Appointment:', v_date, v_time);
        end;
      end;
    elsif v_time is not null then
      v_stop_notes := 'Time: ' || v_time;
    end if;
    -- No tz column on stops: record the zone used in notes.
    if v_appt is not null then
      v_stop_notes := concat_ws(E'\n', 'TZ: ' || v_stop_tz, v_stop_notes);
    end if;

    insert into public.stops (load_id, stop_type, sequence, company_name, address_line1, city, state, zip, appointment_start, notes, timezone)
    values (v_load, v_s.kind, v_s.seq, nullif(v_party->>'name', ''), v_line1, v_city, v_state, v_zip, v_appt, v_stop_notes, v_stop_tz);
  end loop;

  update public.documents set load_id = v_load where id = p_document;

  return v_load;
end;
$$;
revoke execute on function public.create_load_from_document(uuid, text) from public, anon;
grant execute on function public.create_load_from_document(uuid, text) to authenticated;

-- 2b. Emailed rate cons (latest: 20261022150000_company_email_ratecons.sql).
create or replace function public.create_load_from_email_document(p_document uuid, p_tz text default 'America/Chicago')
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tz text;
  v_stop_tz text;
  v_doc record;
  v_company uuid;
  v_owner uuid;
  v_x jsonb;
  v_load uuid;
  v_notes text;
  v_s record;
  v_party jsonb;
  v_when jsonb;
  v_addr text;
  v_line1 text;
  v_city text;
  v_state text;
  v_zip text;
  v_date text;
  v_time text;
  v_appt timestamptz;
  v_stop_notes text;
begin
  if auth.uid() is null then raise exception 'document_not_found' using errcode = 'P0001'; end if;
  v_tz := case when p_tz is not null and exists (select 1 from pg_timezone_names where name = p_tz)
               then p_tz else 'America/Chicago' end;

  select id, user_id, load_id, ai_extracted_data, source, inbound_email_id
    into v_doc
    from public.documents
   where id = p_document
     for update;

  if not found or v_doc.source is distinct from 'email' then
    raise exception 'document_not_found' using errcode = 'P0001';
  end if;
  v_company := public.email_doc_company(v_doc.inbound_email_id, v_doc.user_id);
  if v_company is null or coalesce(public.company_role(v_company) in ('owner', 'management', 'dispatcher'), false) is not true then
    raise exception 'document_not_found' using errcode = 'P0001';
  end if;
  -- Already turned into a load (e.g. a teammate tapped first): return that load instead of making a second one.
  if v_doc.load_id is not null then
    return v_doc.load_id;
  end if;
  select p.owner_id into v_owner from public.company_profiles p where p.id = v_company;
  if v_owner is null then raise exception 'document_not_found' using errcode = 'P0001'; end if;
  v_x := v_doc.ai_extracted_data;
  if v_x is null or jsonb_typeof(v_x) <> 'object' then
    raise exception 'no_extracted_data' using errcode = 'P0001';
  end if;

  -- No reference column on loads: fold reference numbers into notes.
  v_notes := nullif(concat_ws(E'\n',
    nullif(v_x->>'notes', ''),
    case when jsonb_typeof(v_x->'reference_numbers') = 'array'
              and jsonb_array_length(v_x->'reference_numbers') > 0
         then 'Refs: ' || (select string_agg(r, ', ') from jsonb_array_elements_text(v_x->'reference_numbers') r)
    end
  ), '');

  insert into public.loads (user_id, status, broker_name, broker_load_number, rate, notes)
  values (
    v_owner,
    'booked',
    nullif(v_x->>'broker_name', ''),
    nullif(v_x->>'load_number', ''),
    case when jsonb_typeof(v_x->'rate') = 'number' then (v_x->>'rate')::numeric end,
    v_notes
  )
  returning id into v_load;

  -- 20261127000100: the rate con's stops in order (public.ratecon_load_stops): all of stops[] when it has 3 to 20
  -- valid entries, else the same 2 stops as before (shipper + pickup, receiver + delivery).
  for v_s in
    select * from public.ratecon_load_stops(v_x) order by seq
  loop
    v_party := v_s.party;
    v_when  := v_s.stop;
    v_addr  := coalesce(nullif(trim(v_when->>'address'), ''), nullif(trim(v_party->>'address'), ''));
    -- Hardened parsing (see public.parse_us_address).
    select p.line1, p.city, p.state, p.zip into v_line1, v_city, v_state, v_zip
      from public.parse_us_address(v_addr) p;

    -- Each stop uses its state's time zone when known, else the caller's p_tz.
    v_stop_tz := coalesce(public.us_state_tz(v_state), v_tz);

    -- Appointment: date + time when both parse; else date only; else null. Raw values kept in notes.
    v_date := nullif(trim(v_when->>'date'), '');
    v_time := nullif(trim(v_when->>'time'), '');
    v_appt := null;
    v_stop_notes := null;
    if v_date is not null then
      begin
        v_appt := (v_date || ' ' || coalesce(v_time, '00:00'))::timestamp at time zone v_stop_tz;
      exception when others then
        begin
          v_appt := v_date::date::timestamp at time zone v_stop_tz;
          if v_time is not null then v_stop_notes := 'Time: ' || v_time; end if;
        exception when others then
          v_appt := null;
          v_stop_notes := concat_ws(' ', 'Appointment:', v_date, v_time);
        end;
      end;
    elsif v_time is not null then
      v_stop_notes := 'Time: ' || v_time;
    end if;
    -- No tz column on stops: record the zone used in notes.
    if v_appt is not null then
      v_stop_notes := concat_ws(E'\n', 'TZ: ' || v_stop_tz, v_stop_notes);
    end if;

    insert into public.stops (load_id, stop_type, sequence, company_name, address_line1, city, state, zip, appointment_start, notes, timezone)
    values (v_load, v_s.kind, v_s.seq, nullif(v_party->>'name', ''), v_line1, v_city, v_state, v_zip, v_appt, v_stop_notes, v_stop_tz);
  end loop;

  -- Equipment, weight and trip miles (the Documents page fills these from the browser for its own loads; a
  -- teammate can't update the owner's load directly, so they're set here). Only plain numbers / non-empty text.
  update public.loads set
    equipment_type = coalesce(equipment_type, nullif(trim(v_x->>'equipment_type'), '')),
    weight = coalesce(weight, case when jsonb_typeof(v_x->'weight_lb') = 'number' and (v_x->>'weight_lb')::numeric > 0 then (v_x->>'weight_lb')::numeric end),
    total_miles = coalesce(total_miles, case when jsonb_typeof(v_x->'total_miles') = 'number' and (v_x->>'total_miles')::numeric > 0 then (v_x->>'total_miles')::numeric end),
    miles_source = case when total_miles is null and jsonb_typeof(v_x->'total_miles') = 'number' and (v_x->>'total_miles')::numeric > 0 then 'rate_con' else miles_source end
  where id = v_load;

  update public.documents set load_id = v_load where id = p_document;

  return v_load;
end;
$$;
revoke all on function public.create_load_from_email_document(uuid, text) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on function public.create_load_from_email_document(uuid, text) from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'grant execute on function public.create_load_from_email_document(uuid, text) to authenticated'; end if;
end $$;

-- 2c. Uploaded rate cons (latest: 20261022250000_ratecon_upload_company_owner.sql).
create or replace function public.create_load_from_company_upload(p_document uuid, p_tz text default 'America/Los_Angeles', p_profile uuid default null)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tz text;
  v_stop_tz text;
  v_doc record;
  v_owner uuid;
  v_x jsonb;
  v_load uuid;
  v_notes text;
  v_s record;
  v_party jsonb;
  v_when jsonb;
  v_addr text;
  v_line1 text;
  v_city text;
  v_state text;
  v_zip text;
  v_date text;
  v_time text;
  v_appt timestamptz;
  v_stop_notes text;
begin
  -- Use the caller's IANA timezone if valid, else the default.
  v_tz := case when p_tz is not null and exists (select 1 from pg_timezone_names where name = p_tz)
               then p_tz else 'America/Los_Angeles' end;

  select id, user_id, load_id, ai_extracted_data
    into v_doc
    from public.documents
   where id = p_document
     for update;

  if not found or v_doc.user_id is distinct from auth.uid() then
    raise exception 'document_not_found' using errcode = 'P0001';
  end if;
  if v_doc.load_id is not null then
    raise exception 'already_linked' using errcode = 'P0001', detail = v_doc.load_id::text;
  end if;
  -- Who owns the new load.
  -- p_profile (the app's active company): the caller must be its owner, Management or a Dispatcher; the load
  -- belongs to that company's owner. Anything else is rejected (nobody creates loads for another company).
  if p_profile is not null then
    select cp.owner_id into v_owner from public.company_profiles cp
     where cp.id = p_profile and coalesce(public.company_role(cp.id) in ('owner', 'management', 'dispatcher'), false);
    if v_owner is null then
      raise exception 'not_company_office' using errcode = '42501';
    end if;
  -- No p_profile (older app): a company owner → himself; Management / a Dispatcher → that company's owner (oldest
  -- membership); anyone else → himself (same as create_load_from_document).
  elsif exists (select 1 from public.company_profiles cp where cp.owner_id = auth.uid()) then
    v_owner := auth.uid();
  else
    select cp.owner_id into v_owner
      from public.company_members m join public.company_profiles cp on cp.id = m.profile_id
     where m.user_id = auth.uid() and m.role in ('management', 'dispatcher')
     order by m.created_at, cp.created_at, cp.id
     limit 1;
    v_owner := coalesce(v_owner, auth.uid());
  end if;
  v_x := v_doc.ai_extracted_data;
  if v_x is null or jsonb_typeof(v_x) <> 'object' then
    raise exception 'no_extracted_data' using errcode = 'P0001';
  end if;

  -- No reference column on loads: fold reference numbers into notes.
  v_notes := nullif(concat_ws(E'\n',
    nullif(v_x->>'notes', ''),
    case when jsonb_typeof(v_x->'reference_numbers') = 'array'
              and jsonb_array_length(v_x->'reference_numbers') > 0
         then 'Refs: ' || (select string_agg(r, ', ') from jsonb_array_elements_text(v_x->'reference_numbers') r)
    end
  ), '');

  insert into public.loads (user_id, status, broker_name, broker_load_number, rate, notes)
  values (
    v_owner,
    'booked',
    nullif(v_x->>'broker_name', ''),
    nullif(v_x->>'load_number', ''),
    case when jsonb_typeof(v_x->'rate') = 'number' then (v_x->>'rate')::numeric end,
    v_notes
  )
  returning id into v_load;

  -- 20261127000100: the rate con's stops in order (public.ratecon_load_stops): all of stops[] when it has 3 to 20
  -- valid entries, else the same 2 stops as before (shipper + pickup, receiver + delivery).
  for v_s in
    select * from public.ratecon_load_stops(v_x) order by seq
  loop
    v_party := v_s.party;
    v_when  := v_s.stop;
    v_addr  := coalesce(nullif(trim(v_when->>'address'), ''), nullif(trim(v_party->>'address'), ''));
    -- Hardened parsing (see public.parse_us_address).
    select p.line1, p.city, p.state, p.zip into v_line1, v_city, v_state, v_zip
      from public.parse_us_address(v_addr) p;

    -- Each stop uses its state's time zone when known, else the caller's p_tz.
    v_stop_tz := coalesce(public.us_state_tz(v_state), v_tz);

    -- Appointment: date + time when both parse; else date only; else null. Raw values kept in notes.
    v_date := nullif(trim(v_when->>'date'), '');
    v_time := nullif(trim(v_when->>'time'), '');
    v_appt := null;
    v_stop_notes := null;
    if v_date is not null then
      begin
        v_appt := (v_date || ' ' || coalesce(v_time, '00:00'))::timestamp at time zone v_stop_tz;
      exception when others then
        begin
          v_appt := v_date::date::timestamp at time zone v_stop_tz;
          if v_time is not null then v_stop_notes := 'Time: ' || v_time; end if;
        exception when others then
          v_appt := null;
          v_stop_notes := concat_ws(' ', 'Appointment:', v_date, v_time);
        end;
      end;
    elsif v_time is not null then
      v_stop_notes := 'Time: ' || v_time;
    end if;
    -- No tz column on stops: record the zone used in notes.
    if v_appt is not null then
      v_stop_notes := concat_ws(E'\n', 'TZ: ' || v_stop_tz, v_stop_notes);
    end if;

    insert into public.stops (load_id, stop_type, sequence, company_name, address_line1, city, state, zip, appointment_start, notes, timezone)
    values (v_load, v_s.kind, v_s.seq, nullif(v_party->>'name', ''), v_line1, v_city, v_state, v_zip, v_appt, v_stop_notes, v_stop_tz);
  end loop;

  -- Equipment, weight and trip miles (the Documents page fills these from the browser for its own loads; a
  -- teammate can't update the owner's load directly, so they're set here). Only plain numbers / non-empty text.
  update public.loads set
    equipment_type = coalesce(equipment_type, nullif(trim(v_x->>'equipment_type'), '')),
    weight = coalesce(weight, case when jsonb_typeof(v_x->'weight_lb') = 'number' and (v_x->>'weight_lb')::numeric > 0 then (v_x->>'weight_lb')::numeric end),
    total_miles = coalesce(total_miles, case when jsonb_typeof(v_x->'total_miles') = 'number' and (v_x->>'total_miles')::numeric > 0 then (v_x->>'total_miles')::numeric end),
    miles_source = case when total_miles is null and jsonb_typeof(v_x->'total_miles') = 'number' and (v_x->>'total_miles')::numeric > 0 then 'rate_con' else miles_source end
  where id = v_load;

  update public.documents set load_id = v_load where id = p_document;

  return v_load;
end;
$$;
revoke all on function public.create_load_from_company_upload(uuid, text, uuid) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on function public.create_load_from_company_upload(uuid, text, uuid) from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'grant execute on function public.create_load_from_company_upload(uuid, text, uuid) to authenticated'; end if;
end $$;

commit;
