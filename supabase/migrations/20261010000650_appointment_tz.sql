-- Run after 20261010000600 (or any time after 0450).
-- Fix: stop appointment times were read as UTC. Extracted date/time is now interpreted as local
-- wall time in the user's timezone (p_tz, an IANA name sent by the browser).
-- Existing stops are NOT changed: loads created earlier keep their old (UTC-interpreted) times.

drop function if exists public.create_load_from_document(uuid);

create or replace function public.create_load_from_document(p_document uuid, p_tz text default 'America/Los_Angeles')
returns uuid
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_tz text;
  v_doc record;
  v_x jsonb;
  v_load uuid;
  v_notes text;
  v_s record;
  v_party jsonb;
  v_when jsonb;
  v_addr text;
  v_m text[];
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

  for v_s in
    select * from (values (1, 'pickup', 'shipper', 'pickup'), (2, 'delivery', 'receiver', 'delivery')) as t(seq, kind, party, stop)
  loop
    v_party := case when jsonb_typeof(v_x->v_s.party) = 'object' then v_x->v_s.party else '{}'::jsonb end;
    v_when  := case when jsonb_typeof(v_x->v_s.stop)  = 'object' then v_x->v_s.stop  else '{}'::jsonb end;
    v_addr  := coalesce(nullif(trim(v_when->>'address'), ''), nullif(trim(v_party->>'address'), ''));
    v_line1 := v_addr; v_city := null; v_state := null; v_zip := null;

    -- Best effort: "<street>, <City>, ST 12345" or "<street>, <City>, ST".
    v_m := regexp_match(v_addr, '^(.*?),\s*([^,]+?),\s*([A-Za-z]{2})\.?\s+(\d{5}(?:-\d{4})?)\s*(?:,\s*USA?)?$');
    if v_m is not null then
      v_line1 := nullif(trim(v_m[1]), ''); v_city := trim(v_m[2]); v_state := upper(v_m[3]); v_zip := v_m[4];
    else
      v_m := regexp_match(v_addr, '^(.*?),\s*([^,]+?),\s*([A-Za-z]{2})\.?\s*$');
      if v_m is not null then
        v_line1 := nullif(trim(v_m[1]), ''); v_city := trim(v_m[2]); v_state := upper(v_m[3]);
      end if;
    end if;

    -- Appointment: date + time when both parse; else date only; else null. Raw values kept in notes.
    v_date := nullif(trim(v_when->>'date'), '');
    v_time := nullif(trim(v_when->>'time'), '');
    v_appt := null;
    v_stop_notes := null;
    if v_date is not null then
      begin
        v_appt := (v_date || ' ' || coalesce(v_time, '00:00'))::timestamp at time zone v_tz;
      exception when others then
        begin
          v_appt := v_date::date::timestamp at time zone v_tz;
          if v_time is not null then v_stop_notes := 'Time: ' || v_time; end if;
        exception when others then
          v_appt := null;
          v_stop_notes := concat_ws(' ', 'Appointment:', v_date, v_time);
        end;
      end;
    elsif v_time is not null then
      v_stop_notes := 'Time: ' || v_time;
    end if;

    insert into public.stops (load_id, stop_type, sequence, company_name, address_line1, city, state, zip, appointment_start, notes)
    values (v_load, v_s.kind, v_s.seq, nullif(v_party->>'name', ''), v_line1, v_city, v_state, v_zip, v_appt, v_stop_notes);
  end loop;

  update public.documents set load_id = v_load where id = p_document;

  return v_load;
end;
$$;

revoke execute on function public.create_load_from_document(uuid, text) from public, anon;
grant execute on function public.create_load_from_document(uuid, text) to authenticated;
