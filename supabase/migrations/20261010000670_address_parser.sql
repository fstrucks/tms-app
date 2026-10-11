-- Run after 20261010000660_stop_timezones.sql.
-- Hardened US address parsing for create_load_from_document (same signature and grants).
-- Fixes stops like "123 Main St\nAtlanta, GA 30303" falling back to p_tz because the old
-- pattern required "street, City, ST". Existing stops are not changed.

create or replace function public.parse_us_address(
  p_addr text,
  out line1 text, out city text, out state text, out zip text
)
language plpgsql
immutable
set search_path = public
as $$
declare
  v_norm text;
  v_pat constant text := '\m([A-Za-z]{2})\M[\s,.]*(\d{5}(?:-\d{4})?)?';
  v_m text[];
  v_n int := 0;
  v_best int;           -- occurrence index of the chosen state match
  v_best_zip boolean := false;
  v_pos int;
  v_prefix text;
  v_segs text[];
  v_cpos int;
  v_ok boolean;
begin
  if p_addr is null or btrim(p_addr) = '' then
    return;
  end if;

  -- Normalise: newlines -> ', ', collapse whitespace and repeated commas, strip trailing country.
  v_norm := regexp_replace(p_addr, '[\r\n]+', ', ', 'g');
  v_norm := regexp_replace(v_norm, '\s+', ' ', 'g');
  v_norm := regexp_replace(v_norm, '\s*,[\s,]*', ', ', 'g');
  v_norm := regexp_replace(v_norm, '[\s,]*\m(u\.s\.a\.?|u\.s\.?|usa|us|united states( of america)?)\.?\s*$', '', 'i');
  v_norm := btrim(v_norm, ' ,');
  line1 := nullif(v_norm, '');

  -- State candidate = valid US state code AND (written in UPPERCASE, or right after a comma,
  -- or right before a ZIP). So lowercase words like 'in', 'or', 'me' don't match mid-sentence.
  -- Prefer a candidate followed by a ZIP; otherwise the LAST valid one.
  for v_m in select regexp_matches(v_norm, v_pat, 'g') loop
    v_n := v_n + 1;
    if public.us_state_tz(v_m[1]) is null then
      continue;
    end if;
    v_cpos := regexp_instr(v_norm, v_pat, 1, v_n);
    v_ok := v_m[1] = upper(v_m[1])                                -- (a) uppercase as written
         or substr(v_norm, 1, v_cpos - 1) ~ ',\s*$'               -- (b) preceded by a comma
         or v_m[2] is not null;                                   -- (c) followed by a ZIP
    if not v_ok then
      continue;
    end if;
    if v_m[2] is not null then
      v_best := v_n; v_best_zip := true; state := upper(v_m[1]); zip := v_m[2];
    elsif not v_best_zip then
      v_best := v_n; state := upper(v_m[1]); zip := null;
    end if;
  end loop;

  if v_best is null then
    return;  -- unparsed: line1 = full normalised address
  end if;

  -- City = the comma segment right before the state; line1 = everything before the city.
  v_pos := regexp_instr(v_norm, v_pat, 1, v_best);
  v_prefix := btrim(substr(v_norm, 1, v_pos - 1), ' ,');
  if v_prefix = '' then
    line1 := null;
  elsif position(',' in v_prefix) > 0 then
    v_segs := regexp_split_to_array(v_prefix, '\s*,\s*');
    city := nullif(btrim(v_segs[array_length(v_segs, 1)]), '');
    line1 := nullif(btrim(array_to_string(v_segs[1:array_length(v_segs, 1) - 1], ', ')), '');
  elsif substr(v_norm, v_pos - 2, 2) = ', ' then
    city := v_prefix;  -- "Atlanta, GA ..."
    line1 := null;
  else
    line1 := v_prefix; -- no comma: can't separate street from city reliably
  end if;
end;
$$;

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

    insert into public.stops (load_id, stop_type, sequence, company_name, address_line1, city, state, zip, appointment_start, notes)
    values (v_load, v_s.kind, v_s.seq, nullif(v_party->>'name', ''), v_line1, v_city, v_state, v_zip, v_appt, v_stop_notes);
  end loop;

  update public.documents set load_id = v_load where id = p_document;

  return v_load;
end;
$$;

-- Helpers: the security-invoker RPC runs them as the caller, so authenticated needs execute.
revoke execute on function public.parse_us_address(text) from public, anon;
grant execute on function public.parse_us_address(text) to authenticated;
revoke execute on function public.us_state_tz(text) from public, anon;
grant execute on function public.us_state_tz(text) to authenticated;

revoke execute on function public.create_load_from_document(uuid, text) from public, anon;
grant execute on function public.create_load_from_document(uuid, text) to authenticated;
