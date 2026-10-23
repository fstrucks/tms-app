-- 20261022250000: Create load from an UPLOADED rate con by Management / a Dispatcher (QA, Oct 22 2026).
-- Bug: create_load_from_document (security invoker) always makes the load with user_id = the caller. A dispatcher's
-- own upload therefore became a personal load outside the company: the driver picker showed only "Not assigned" and
-- "Me", and the map / Scale tickets cards said "Load not found." (they read loads of the active company's owner).
-- Fix: a NEW function (create_load_from_document is unchanged). Same body as create_load_from_document (0680) plus
-- the equipment / weight / miles fill from create_load_from_email_document (20261022150000), except:
--   * the caller must still own the document (documents.user_id = auth.uid());
--   * the load belongs to the caller if he owns a company, else to the owner of the company where he is
--     Management or a Dispatcher, else to himself (old behaviour). Nobody can create a load for a company they
--     aren't Management / Dispatcher in.
-- Idempotent (create or replace). The app falls back to create_load_from_document until this is applied.
begin;

create or replace function public.create_load_from_company_upload(p_document uuid, p_tz text default 'America/Los_Angeles')
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
  -- Who owns the new load. A company owner: himself (same as create_load_from_document). Otherwise Management or
  -- a Dispatcher of a company: that company's owner (oldest membership if more than one). Anyone else: himself.
  if exists (select 1 from public.company_profiles cp where cp.owner_id = auth.uid()) then
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

  for v_s in
    select * from (values (1, 'pickup', 'shipper', 'pickup'), (2, 'delivery', 'receiver', 'delivery')) as t(seq, kind, party, stop)
  loop
    v_party := case when jsonb_typeof(v_x->v_s.party) = 'object' then v_x->v_s.party else '{}'::jsonb end;
    v_when  := case when jsonb_typeof(v_x->v_s.stop)  = 'object' then v_x->v_s.stop  else '{}'::jsonb end;
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

revoke all on function public.create_load_from_company_upload(uuid, text) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on function public.create_load_from_company_upload(uuid, text) from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'grant execute on function public.create_load_from_company_upload(uuid, text) to authenticated'; end if;
end $$;

commit;
