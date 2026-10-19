-- Dispatcher / management load creation (Marc asked for it via Sam, Oct 19 2026). PROPOSED, NOT APPLIED.
-- Needs Sam's review and Marc's OK; Dakota applies it. Run AFTER 20261018000600, 0700 (applied on prod) and 0800.
--
-- ADDITIVE ONLY: 1 new function. No table, column, policy, trigger or grant on existing objects changes. Own-row
-- RLS on loads/stops stays as it is: management and dispatchers still can't insert into loads directly; they create
-- a load ONLY through this SECURITY DEFINER function, which checks the caller's role on the target company.
--
-- dispatch_create_load(p_owner, p_load, p_stops) → the new load id (uuid)
--   p_owner : the company owner's user id (company_profiles.owner_id; dispatch_context() returns it). loads has no
--             company_id column yet (#27), so "the company" is the owner's company profile, and the load row is
--             created with user_id = p_owner: it is the OWNER's load, exactly like one the owner made in /loads.
--   Caller  : the owner of that company, or a 'management' / 'dispatcher' member of THAT company (same lookup as
--             set_member_role in 0800 and load_viewer_role in 0600). Drivers, strangers and other companies' staff
--             get not_allowed. An unknown company also gets not_allowed (no way to probe which owners exist).
--   p_load  : JSON object; only these keys are read: status (default booked), broker_name, broker_load_number,
--             rate (required, ≥ 0), total_miles (> 0 or empty → miles_source 'typed'), commodity, weight (> 0),
--             equipment_type, special_instructions, notes, assigned_driver_user_id, show_rate_to_driver.
--             Same validation and error codes as dispatch_update_load (0700).
--             assigned_driver_user_id, when given, must be a 'driver' member of the same company, else
--             assigned_driver_not_driver. show_rate_to_driver is forced off when there is no driver.
--   p_stops : JSON array, 2–20 stops in order, saved by dispatch_save_stops (0700) in the same transaction, so the
--             validation is identical (pickup + delivery required, city, 2-letter state, pickup_number ≤ 80, …).
--             Stop "id" keys are rejected (bad_stops): every stop is new.
--   Any error rolls back the whole call: no half-made load is left behind.
-- Errors (SQLSTATE P0001, message is the code): not_signed_in, not_allowed, bad_patch, bad_status, bad_number,
--   bad_rate, bad_miles, bad_weight, assigned_driver_not_driver, plus the dispatch_save_stops codes.
create or replace function public.dispatch_create_load(p_owner uuid, p_load jsonb, p_stops jsonb)
returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_profile public.company_profiles%rowtype;
  p jsonb := coalesce(p_load, '{}'::jsonb);
  v_rate numeric; v_miles numeric; v_weight numeric; v_status text; v_driver uuid; v_show boolean; v_id uuid;
  txt constant text[] := array['broker_name', 'broker_load_number', 'commodity', 'equipment_type', 'special_instructions', 'notes'];
  k text;
begin
  if v_uid is null then raise exception 'not_signed_in' using errcode = 'P0001'; end if;
  select * into v_profile from public.company_profiles cp where cp.owner_id = p_owner
   order by cp.created_at, cp.id limit 1; -- same pick as dispatch_context (0700): oldest profile if an owner ever has two
  if not found then raise exception 'not_allowed' using errcode = 'P0001'; end if;
  if v_profile.owner_id <> v_uid and not exists (
    select 1 from public.company_members m
     where m.profile_id = v_profile.id and m.user_id = v_uid and m.role in ('management', 'dispatcher')
  ) then
    raise exception 'not_allowed' using errcode = 'P0001';
  end if;

  if jsonb_typeof(p) <> 'object' then raise exception 'bad_patch' using errcode = 'P0001'; end if;
  v_status := coalesce(nullif(p->>'status', ''), 'booked');
  if v_status not in ('booked', 'dispatched', 'in_transit', 'delivered', 'invoiced', 'paid', 'cancelled') then
    raise exception 'bad_status' using errcode = 'P0001';
  end if;
  begin
    v_rate := nullif(p->>'rate', '')::numeric; v_miles := nullif(p->>'total_miles', '')::numeric; v_weight := nullif(p->>'weight', '')::numeric;
    v_driver := nullif(p->>'assigned_driver_user_id', '')::uuid;
  exception when others then raise exception 'bad_number' using errcode = 'P0001';
  end;
  -- outside the bad_number handler, like dispatch_update_load (0700): a non-boolean raises Postgres' own 22P02
  v_show := coalesce((p->>'show_rate_to_driver')::boolean, false);
  if v_rate is null or v_rate < 0 then raise exception 'bad_rate' using errcode = 'P0001'; end if;
  if v_miles is not null and v_miles <= 0 then raise exception 'bad_miles' using errcode = 'P0001'; end if;
  if v_weight is not null and v_weight <= 0 then raise exception 'bad_weight' using errcode = 'P0001'; end if;
  foreach k in array txt loop
    if p ? k and jsonb_typeof(p->k) not in ('string', 'null') then raise exception 'bad_patch' using errcode = 'P0001'; end if;
    if p ? k and char_length(coalesce(p->>k, '')) > 4000 then raise exception 'bad_patch' using errcode = 'P0001'; end if;
  end loop;
  if v_driver is not null and not exists (
    select 1 from public.company_members m where m.profile_id = v_profile.id and m.user_id = v_driver and m.role = 'driver'
  ) then
    raise exception 'assigned_driver_not_driver' using errcode = 'P0001';
  end if;
  if v_driver is null then v_show := false; end if;
  if jsonb_typeof(p_stops) = 'array' and exists (select 1 from jsonb_array_elements(p_stops) e where jsonb_typeof(e.value) = 'object' and e.value ? 'id') then
    raise exception 'bad_stops' using errcode = 'P0001';
  end if;

  insert into public.loads (user_id, status, broker_name, broker_load_number, rate, total_miles, miles_source, commodity, weight,
                            equipment_type, special_instructions, notes, assigned_driver_user_id, show_rate_to_driver)
  values (v_profile.owner_id, v_status, nullif(btrim(p->>'broker_name'), ''), nullif(btrim(p->>'broker_load_number'), ''), v_rate,
          v_miles, case when v_miles is null then null else 'typed' end, nullif(btrim(p->>'commodity'), ''), round(v_weight),
          nullif(btrim(p->>'equipment_type'), ''), nullif(btrim(p->>'special_instructions'), ''), nullif(btrim(p->>'notes'), ''),
          v_driver, v_show)
  returning id into v_id;

  perform public.dispatch_save_stops(v_id, p_stops); -- same caller, so its role check passes; raises → full rollback
  return v_id;
end $$;
revoke all on function public.dispatch_create_load(uuid, jsonb, jsonb) from public, anon;
grant execute on function public.dispatch_create_load(uuid, jsonb, jsonb) to authenticated;
