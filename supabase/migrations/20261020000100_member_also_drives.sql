-- "Also drives" (Marc picked option A, Oct 20 2026). NOT APPLIED to prod: needs Marc's OK relayed by Sam; Dakota applies.
-- Preview deployments share the prod database, so the app side of this PR only works once this is applied.
--
-- A Management or Dispatcher member can ALSO be a driver: company_members.also_drives = true. Their main role keeps
-- every right it has today; the flag only makes them assignable as a load's driver (role = 'driver' OR also_drives).
-- Visibility: Management / Dispatchers already see every company load with rates through visible_loads()
-- (load_viewer_role returns their main role), so visible_loads() needs NO change: its driver filter
-- (viewer_role <> 'driver' or assigned to me) only narrows role='driver' members, and an also-driver is never one.
-- The Home card narrows an also-driver to his own assigned loads in the app (assigned_driver_user_id is returned).
--
-- Changes (all additive or create-or-replace; no policy or grant is widened):
--   1. column company_members.also_drives boolean not null default false (existing rows: false = no behavior change)
--      + check: a role='driver' or 'owner' row never carries the flag.
--   2. loads_check_assigned_driver(): owner, role driver, or also_drives.
--   3. load_driver_choices(): lists role driver or also_drives members (same signature / columns).
--   4. dispatch_create_load(): driver may be the owner, a driver, or an also-driver.
--   5. set_member_role(p_user, p_role, p_also_drives default null): becoming Driver clears the flag; moving off Driver
--      keeps their loads when p_also_drives is true; loads are unassigned only when the person stops driving entirely.
--      Return gains also_drives. (Dropped + recreated: the signature and return type change.)
--   6. NEW set_member_also_drives(p_user, p_on): owner-only toggle for Dispatcher / Management members; turning it off
--      unassigns them from the company's loads in the same transaction.
-- Errors (P0001, message = code): not_signed_in, not_owner, not_member, owner_locked, bad_role, already_driver.
-- Supersedes the role-based draft /workspace/powerhaul-docs/2026-10-20_pr107_management-self-driver_DRAFT.sql.

-- 1. Column
alter table public.company_members add column if not exists also_drives boolean not null default false;
alter table public.company_members drop constraint if exists company_members_also_drives_check;
alter table public.company_members add constraint company_members_also_drives_check
  check (not also_drives or role in ('management', 'dispatcher'));

-- 2. Assigned-driver trigger (same body as 0700, plus also_drives). Unchanged assignments are still not re-checked.
create or replace function public.loads_check_assigned_driver()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'UPDATE' and new.assigned_driver_user_id is not distinct from old.assigned_driver_user_id and new.user_id = old.user_id then
    return new;
  end if;
  if new.assigned_driver_user_id is not null and new.assigned_driver_user_id <> new.user_id and not exists (
    select 1 from public.company_members m join public.company_profiles p on p.id = m.profile_id
     where p.owner_id = new.user_id and m.user_id = new.assigned_driver_user_id and (m.role = 'driver' or m.also_drives)
  ) then
    raise exception 'assigned_driver_not_driver' using errcode = 'P0001';
  end if;
  return new;
end $$;

-- 3. Driver picker list (same signature and columns as 0600).
create or replace function public.load_driver_choices(p_owner uuid default null)
returns table (user_id uuid, email text) language sql stable security definer set search_path = public as $$
  select m.user_id, u.email::text
    from public.company_members m
    join public.company_profiles p on p.id = m.profile_id
    join auth.users u on u.id = m.user_id
   where p.owner_id = coalesce(p_owner, auth.uid())
     and (m.role = 'driver' or m.also_drives)
     and m.user_id <> p.owner_id
     and public.load_viewer_role(coalesce(p_owner, auth.uid())) in ('owner', 'management', 'dispatcher')
   order by u.email;
$$;
revoke execute on function public.load_driver_choices(uuid) from public, anon;
grant execute on function public.load_driver_choices(uuid) to authenticated;

-- 4. Dispatch New load (body copied from 20261019000100; only the driver check changed).
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
  -- 20261020000100: the owner (owner-operator) or a member who drives (role driver, or also_drives) may be assigned.
  if v_driver is not null and v_driver <> v_profile.owner_id and not exists (
    select 1 from public.company_members m where m.profile_id = v_profile.id and m.user_id = v_driver and (m.role = 'driver' or m.also_drives)
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

-- 5. Role editor (replaces 0800's 2-argument version).
drop function if exists public.set_member_role(uuid, text);
drop function if exists public.set_member_role(uuid, text, boolean);
create function public.set_member_role(p_user uuid, p_role text, p_also_drives boolean default null)
returns table (user_id uuid, old_role text, new_role text, unassigned_loads integer, also_drives boolean)
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_profile public.company_profiles%rowtype;
  v_old text; v_old_also boolean; v_new_also boolean;
  v_count integer := 0;
begin
  if v_uid is null then raise exception 'not_signed_in'; end if;
  select * into v_profile from public.company_profiles p where p.owner_id = v_uid;
  if not found then raise exception 'not_owner'; end if;
  if p_role is null or p_role not in ('driver', 'dispatcher', 'management') then raise exception 'bad_role'; end if;
  select m.role, m.also_drives into v_old, v_old_also from public.company_members m
   where m.profile_id = v_profile.id and m.user_id = p_user for update;
  if not found then raise exception 'not_member'; end if;
  if p_user = v_profile.owner_id or v_old = 'owner' then raise exception 'owner_locked'; end if;
  -- Becoming a Driver clears the flag (the role already drives). Otherwise: the given value, else keep the current one.
  v_new_also := case when p_role = 'driver' then false else coalesce(p_also_drives, v_old_also, false) end;
  -- Unassign only when the person stops driving entirely.
  if (v_old = 'driver' or v_old_also) and not (p_role = 'driver' or v_new_also) then
    update public.loads l set assigned_driver_user_id = null, show_rate_to_driver = false
     where l.user_id = v_profile.owner_id and l.assigned_driver_user_id = p_user;
    get diagnostics v_count = row_count;
  end if;
  update public.company_members m set role = p_role, also_drives = v_new_also
   where m.profile_id = v_profile.id and m.user_id = p_user;
  return query select p_user, v_old, p_role, v_count, v_new_also;
end $$;
revoke all on function public.set_member_role(uuid, text, boolean) from public, anon;
grant execute on function public.set_member_role(uuid, text, boolean) to authenticated;

-- 6. Owner-only "Also drives" toggle.
create or replace function public.set_member_also_drives(p_user uuid, p_on boolean)
returns table (user_id uuid, also_drives boolean, unassigned_loads integer)
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_profile public.company_profiles%rowtype;
  v_role text;
  v_count integer := 0;
begin
  if v_uid is null then raise exception 'not_signed_in'; end if;
  select * into v_profile from public.company_profiles p where p.owner_id = v_uid;
  if not found then raise exception 'not_owner'; end if;
  select m.role into v_role from public.company_members m where m.profile_id = v_profile.id and m.user_id = p_user for update;
  if not found then raise exception 'not_member'; end if;
  if p_user = v_profile.owner_id or v_role = 'owner' then raise exception 'owner_locked'; end if;
  if v_role = 'driver' then raise exception 'already_driver'; end if;
  if v_role not in ('management', 'dispatcher') then raise exception 'bad_role'; end if;
  if not coalesce(p_on, false) then
    update public.loads l set assigned_driver_user_id = null, show_rate_to_driver = false
     where l.user_id = v_profile.owner_id and l.assigned_driver_user_id = p_user;
    get diagnostics v_count = row_count;
  end if;
  update public.company_members m set also_drives = coalesce(p_on, false) where m.profile_id = v_profile.id and m.user_id = p_user;
  return query select p_user, coalesce(p_on, false), v_count;
end $$;
revoke all on function public.set_member_also_drives(uuid, boolean) from public, anon;
grant execute on function public.set_member_also_drives(uuid, boolean) to authenticated;
