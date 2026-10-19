-- Dispatch center (Marc approved, via Sam, Oct 18 2026). PROPOSED, NOT APPLIED. Needs Marc's OK relayed by Sam;
-- Dakota applies it. Run AFTER 20261018000600_load_driver_rate_members.sql (#93): it uses load_viewer_role(),
-- loads.assigned_driver_user_id, loads.show_rate_to_driver and stops.pickup_number from there.
--
-- ADDITIVE ONLY: 4 new functions + 1 replaced trigger function (5). No table, column, policy or grant on loads/stops changes. Own-row RLS on loads
-- and stops stays exactly as it is, so management and dispatchers still get zero rows from /rest/v1/loads; they
-- read and write the owner's loads ONLY through these SECURITY DEFINER functions, which check the caller's role
-- on the load owner's company (public.load_viewer_role) on every call. Drivers are rejected by every function here
-- (they keep the read-only visible_loads() from 0600, with the rate masked unless show_rate_to_driver is on).
--
-- Errors (SQLSTATE P0001, message is a stable code): load_not_found, not_allowed, bad_status, bad_rate,
-- bad_miles, bad_weight, bad_stops, bad_stop_type, missing_pickup, missing_delivery, stop_city_required,
-- bad_state, assigned_driver_not_driver (trigger from 0600).

-- 1. Which companies the caller dispatches for. One row per company where the caller is management or a
--    dispatcher. The owner gets no row (the owner uses /loads).
create or replace function public.dispatch_context()
returns table (owner_id uuid, role text, company_name text)
language sql stable security definer set search_path = public as $$
  select p.owner_id, m.role, coalesce(nullif(p.dba_name, ''), nullif(p.legal_name, ''), 'Company')
    from public.company_members m
    join public.company_profiles p on p.id = m.profile_id
   where m.user_id = auth.uid()
     and p.owner_id <> auth.uid()
     and m.role in ('management', 'dispatcher')
   order by p.created_at;
$$;
revoke execute on function public.dispatch_context() from public, anon;
grant execute on function public.dispatch_context() to authenticated;

-- 2. Read: every load of every company the caller dispatches for (management / dispatcher only), all columns
--    including the rate, plus owner_id, viewer_role, stops (by sequence) and has_rate_con. p_load = one load.
create or replace function public.dispatch_loads(p_load uuid default null)
returns setof jsonb
language sql stable security definer set search_path = public as $$
  select (to_jsonb(l) - 'user_id' - 'route_geometry')
         || jsonb_build_object(
              'owner_id', l.user_id,
              'viewer_role', public.load_viewer_role(l.user_id),
              'has_rate_con', exists (select 1 from public.documents d
                                       where d.load_id = l.id and d.user_id = l.user_id and d.doc_type = 'rate_confirmation'),
              'stops', coalesce((select jsonb_agg(to_jsonb(s) - 'geocode_address' order by s.sequence)
                                   from public.stops s where s.load_id = l.id), '[]'::jsonb))
    from public.loads l
   where (p_load is null or l.id = p_load)
     and public.load_viewer_role(l.user_id) in ('management', 'dispatcher')
   order by l.created_at desc;
$$;
revoke execute on function public.dispatch_loads(uuid) from public, anon;
grant execute on function public.dispatch_loads(uuid) to authenticated;

-- 3. Write: load fields. p_patch is a JSON object; only these keys are read, a key that is absent keeps its value:
--    status, broker_name, broker_load_number, rate, total_miles, commodity, weight, equipment_type,
--    special_instructions, notes, assigned_driver_user_id, show_rate_to_driver.
--    rate_per_mile is recomputed by the existing loads_compute_rate_per_mile trigger. A changed total_miles is
--    marked miles_source = 'typed' (same precedence as the owner's form). Owner, management, dispatcher only.
create or replace function public.dispatch_update_load(p_load uuid, p_patch jsonb)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_owner uuid; v_role text; p jsonb := coalesce(p_patch, '{}'::jsonb);
  v_rate numeric; v_miles numeric; v_weight numeric;
  txt constant text[] := array['broker_name', 'broker_load_number', 'commodity', 'equipment_type', 'special_instructions', 'notes'];
  k text;
begin
  select user_id into v_owner from public.loads where id = p_load for update;
  v_role := public.load_viewer_role(v_owner);
  if v_owner is null or v_role is null then raise exception 'load_not_found' using errcode = 'P0001'; end if;
  if v_role not in ('owner', 'management', 'dispatcher') then raise exception 'not_allowed' using errcode = 'P0001'; end if;
  if jsonb_typeof(p) <> 'object' then raise exception 'bad_patch' using errcode = 'P0001'; end if;

  if p ? 'status' and coalesce(p->>'status', '') not in ('booked', 'dispatched', 'in_transit', 'delivered', 'invoiced', 'paid', 'cancelled') then
    raise exception 'bad_status' using errcode = 'P0001';
  end if;
  begin
    v_rate := nullif(p->>'rate', '')::numeric; v_miles := nullif(p->>'total_miles', '')::numeric; v_weight := nullif(p->>'weight', '')::numeric;
  exception when others then raise exception 'bad_number' using errcode = 'P0001';
  end;
  if p ? 'rate' and (v_rate is null or v_rate < 0) then raise exception 'bad_rate' using errcode = 'P0001'; end if;
  if v_miles is not null and v_miles <= 0 then raise exception 'bad_miles' using errcode = 'P0001'; end if;
  if v_weight is not null and v_weight <= 0 then raise exception 'bad_weight' using errcode = 'P0001'; end if;
  foreach k in array txt loop
    if p ? k and jsonb_typeof(p->k) not in ('string', 'null') then raise exception 'bad_patch' using errcode = 'P0001'; end if;
    if p ? k and char_length(coalesce(p->>k, '')) > 4000 then raise exception 'bad_patch' using errcode = 'P0001'; end if;
  end loop;

  update public.loads l set
    status               = case when p ? 'status' then p->>'status' else l.status end,
    broker_name          = case when p ? 'broker_name' then nullif(btrim(p->>'broker_name'), '') else l.broker_name end,
    broker_load_number   = case when p ? 'broker_load_number' then nullif(btrim(p->>'broker_load_number'), '') else l.broker_load_number end,
    rate                 = case when p ? 'rate' then v_rate else l.rate end,
    total_miles          = case when p ? 'total_miles' then v_miles else l.total_miles end,
    miles_source         = case when p ? 'total_miles' and v_miles is distinct from l.total_miles
                                then case when v_miles is null then null else 'typed' end else l.miles_source end,
    commodity            = case when p ? 'commodity' then nullif(btrim(p->>'commodity'), '') else l.commodity end,
    weight               = case when p ? 'weight' then round(v_weight) else l.weight end,
    equipment_type       = case when p ? 'equipment_type' then nullif(btrim(p->>'equipment_type'), '') else l.equipment_type end,
    special_instructions = case when p ? 'special_instructions' then nullif(btrim(p->>'special_instructions'), '') else l.special_instructions end,
    notes                = case when p ? 'notes' then nullif(btrim(p->>'notes'), '') else l.notes end,
    assigned_driver_user_id = case when p ? 'assigned_driver_user_id' then nullif(p->>'assigned_driver_user_id', '')::uuid else l.assigned_driver_user_id end,
    show_rate_to_driver  = case when p ? 'show_rate_to_driver' then coalesce((p->>'show_rate_to_driver')::boolean, false) else l.show_rate_to_driver end,
    updated_at           = now()
  where l.id = p_load;

  return (select to_jsonb(x) - 'user_id' - 'route_geometry' from public.loads x where x.id = p_load);
end $$;
revoke execute on function public.dispatch_update_load(uuid, jsonb) from public, anon;
grant execute on function public.dispatch_update_load(uuid, jsonb) to authenticated;

-- 4. Write: the whole stop list, in order. p_stops is a JSON array; its order becomes stops.sequence (1..n).
--    Items with an "id" of one of this load's stops update that stop; items without an id are new stops; this
--    load's stops that are not in the array are deleted. Needs at least one pickup and one delivery; every stop
--    needs a city and, when given, a 2-letter state. Only these keys are written, and only when the column
--    exists in this database (stops columns predate the repo migrations): stop_type, company_name,
--    address_line1, address_line2, city, state, zip, appointment_start, appointment_end, timezone, notes,
--    pickup_number, contact_name, contact_phone. Owner, management, dispatcher only.
create or replace function public.dispatch_save_stops(p_load uuid, p_stops jsonb)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_owner uuid; v_role text; v_cols text[]; v_list text; v_item jsonb; v_i int := 0; v_keep text[] := '{}';
  v_id text;
  allowed constant text[] := array['stop_type', 'company_name', 'address_line1', 'address_line2', 'city', 'state', 'zip',
    'appointment_start', 'appointment_end', 'timezone', 'notes', 'pickup_number', 'contact_name', 'contact_phone'];
begin
  select user_id into v_owner from public.loads where id = p_load for update;
  v_role := public.load_viewer_role(v_owner);
  if v_owner is null or v_role is null then raise exception 'load_not_found' using errcode = 'P0001'; end if;
  if v_role not in ('owner', 'management', 'dispatcher') then raise exception 'not_allowed' using errcode = 'P0001'; end if;
  if jsonb_typeof(p_stops) <> 'array' or jsonb_array_length(p_stops) < 2 or jsonb_array_length(p_stops) > 20 then
    raise exception 'bad_stops' using errcode = 'P0001';
  end if;
  for v_item in select value from jsonb_array_elements(p_stops) loop
    if jsonb_typeof(v_item) <> 'object' then raise exception 'bad_stops' using errcode = 'P0001'; end if;
    if coalesce(v_item->>'stop_type', '') not in ('pickup', 'delivery') then raise exception 'bad_stop_type' using errcode = 'P0001'; end if;
    if nullif(btrim(coalesce(v_item->>'city', '')), '') is null then raise exception 'stop_city_required' using errcode = 'P0001'; end if;
    if nullif(btrim(coalesce(v_item->>'state', '')), '') is not null and btrim(v_item->>'state') !~ '^[A-Za-z]{2}$' then
      raise exception 'bad_state' using errcode = 'P0001';
    end if;
    if v_item ? 'pickup_number' and char_length(coalesce(v_item->>'pickup_number', '')) > 80 then raise exception 'bad_stops' using errcode = 'P0001'; end if;
    if v_item ? 'id' and v_item->>'id' is not null and not exists (select 1 from public.stops s where s.load_id = p_load and s.id::text = v_item->>'id') then
      raise exception 'bad_stops' using errcode = 'P0001'; -- someone else's stop id, or a stop that was deleted meanwhile
    end if;
  end loop;
  if not exists (select 1 from jsonb_array_elements(p_stops) e where e.value->>'stop_type' = 'pickup') then raise exception 'missing_pickup' using errcode = 'P0001'; end if;
  if not exists (select 1 from jsonb_array_elements(p_stops) e where e.value->>'stop_type' = 'delivery') then raise exception 'missing_delivery' using errcode = 'P0001'; end if;

  select array_agg(c.column_name::text order by array_position(allowed, c.column_name::text)) into v_cols
    from information_schema.columns c
   where c.table_schema = 'public' and c.table_name = 'stops' and c.column_name = any (allowed);
  v_list := (select string_agg(format('%I', c), ', ') from unnest(v_cols) c);

  -- Ids to keep first, so the delete can't touch stops that are being updated.
  select coalesce(array_agg(e.value->>'id'), '{}') into v_keep from jsonb_array_elements(p_stops) e where e.value->>'id' is not null;
  delete from public.stops s where s.load_id = p_load and not (s.id::text = any (v_keep));

  for v_item in select value from jsonb_array_elements(p_stops) loop
    v_i := v_i + 1;
    -- Normalized copy of the allowed keys only: trimmed text, upper-case state, '' → null.
    v_item := (select jsonb_object_agg(k, case when jsonb_typeof(v) = 'string' then to_jsonb(nullif(btrim(v #>> '{}'), '')) else v end)
                 from jsonb_each(v_item) as t(k, v) where k = any (allowed) or k = 'id');
    if v_item->>'state' is not null then v_item := jsonb_set(v_item, '{state}', to_jsonb(upper(v_item->>'state'))); end if;
    v_id := v_item->>'id';
    if v_id is not null then
      execute format('update public.stops set (%s, sequence) = (select %s, $3 from jsonb_populate_record(null::public.stops, $1)) where load_id = $2 and id::text = $4',
                     v_list, v_list) using v_item, p_load, v_i, v_id;
    else
      execute format('insert into public.stops (load_id, sequence, %s) select $2, $3, %s from jsonb_populate_record(null::public.stops, $1)',
                     v_list, v_list) using v_item, p_load, v_i;
    end if;
  end loop;
  update public.loads set updated_at = now() where id = p_load;
  return coalesce((select jsonb_agg(to_jsonb(s) - 'geocode_address' order by s.sequence) from public.stops s where s.load_id = p_load), '[]'::jsonb);
end $$;
revoke execute on function public.dispatch_save_stops(uuid, jsonb) from public, anon;
grant execute on function public.dispatch_save_stops(uuid, jsonb) to authenticated;

-- 5. Replaces the 0600 trigger function: an edit that leaves the assigned driver unchanged is not re-checked, so a
--    load whose driver later left the company can still be edited (dispatch_update_load always lists the column).
--    A NEW or CHANGED assignment is still checked exactly as before.
create or replace function public.loads_check_assigned_driver()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'UPDATE' and new.assigned_driver_user_id is not distinct from old.assigned_driver_user_id and new.user_id = old.user_id then
    return new;
  end if;
  if new.assigned_driver_user_id is not null and new.assigned_driver_user_id <> new.user_id and not exists (
    select 1 from public.company_members m join public.company_profiles p on p.id = m.profile_id
     where p.owner_id = new.user_id and m.user_id = new.assigned_driver_user_id and m.role = 'driver'
  ) then
    raise exception 'assigned_driver_not_driver' using errcode = 'P0001';
  end if;
  return new;
end $$;
