-- Home "Current load" card for the whole company + per-load "Show rate to driver" (Marc, Oct 18 2026, via Sam).
-- PROPOSED, NOT APPLIED. Needs Marc's OK relayed by Sam; Dakota applies it. ADDITIVE ONLY: 3 nullable/defaulted
-- columns, 1 index, 1 trigger, 4 functions. No existing policy, column or row is changed or deleted.
--
-- What "assigned driver" means: before this migration loads have NO driver assignment at all (no column on
-- loads or stops; public.drivers is a truck-tab roster and drivers.auth_user_id is never set by the app).
-- This adds loads.assigned_driver_user_id = the driver's own login (auth.users.id). The trigger below only
-- accepts a user who is a company_members row with role 'driver' on the load owner's company (or the owner).
--
-- How the rate is hidden from drivers, server-side:
--   * public.loads and public.stops keep their own-row RLS (user_id = auth.uid()) UNCHANGED. A company member
--     (management / dispatcher / driver) still gets ZERO rows from /rest/v1/loads, so a driver can never
--     select loads.rate or loads.rate_per_mile through PostgREST, with any column list.
--   * Members read loads only through public.visible_loads(), a SECURITY DEFINER function that returns an
--     ALLOW-LIST of columns for members. rate and rate_per_mile are included only when the viewer is the owner,
--     management or a dispatcher, or the assigned driver on a load with show_rate_to_driver = true; otherwise
--     they are null. Drivers see only loads assigned to them.
--   * Rate con files stay in the owner's private Storage folder (storage RLS unchanged), so members can't open
--     the rate con PDF, which prints the rate.
--   * Only the owner, management and dispatchers can change the assignment or the flag:
--     public.set_load_driver_settings() checks the role; drivers have no write path to loads at all.
--
-- Pickup number: stops.pickup_number (optional, pickup stops). The card falls back to the notes "Refs:" line.
-- Multi-stop: no change needed. stops already is one row per stop (load_id, stop_type, sequence).

-- 1. Columns.
alter table public.loads add column if not exists assigned_driver_user_id uuid references auth.users(id) on delete set null;
alter table public.loads add column if not exists show_rate_to_driver boolean not null default false;
alter table public.stops add column if not exists pickup_number text;
alter table public.stops drop constraint if exists stops_pickup_number_len;
alter table public.stops add constraint stops_pickup_number_len check (pickup_number is null or char_length(pickup_number) between 1 and 80);
create index if not exists loads_assigned_driver_idx on public.loads (assigned_driver_user_id) where assigned_driver_user_id is not null;

-- 2. The caller's role on loads owned by p_owner: 'owner' | 'management' | 'dispatcher' | 'driver' | null.
create or replace function public.load_viewer_role(p_owner uuid)
returns text language sql stable security definer set search_path = public as $$
  select case
    when auth.uid() is null or p_owner is null then null
    when p_owner = auth.uid() then 'owner'
    else (select m.role from public.company_members m
            join public.company_profiles p on p.id = m.profile_id
           where p.owner_id = p_owner and m.user_id = auth.uid()
             and m.role in ('management', 'dispatcher', 'driver')
           limit 1)
  end;
$$;
revoke execute on function public.load_viewer_role(uuid) from public, anon;
grant execute on function public.load_viewer_role(uuid) to authenticated;

-- 3. Assigned driver must be a driver on the owner's company (or the owner, an owner-operator).
create or replace function public.loads_check_assigned_driver()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.assigned_driver_user_id is not null and new.assigned_driver_user_id <> new.user_id and not exists (
    select 1 from public.company_members m join public.company_profiles p on p.id = m.profile_id
     where p.owner_id = new.user_id and m.user_id = new.assigned_driver_user_id and m.role = 'driver'
  ) then
    raise exception 'assigned_driver_not_driver' using errcode = 'P0001';
  end if;
  return new;
end $$;
drop trigger if exists loads_check_assigned_driver on public.loads;
create trigger loads_check_assigned_driver before insert or update of assigned_driver_user_id, user_id on public.loads
  for each row execute function public.loads_check_assigned_driver();

-- 4. Read path for everyone (owner included, so the app has one code path). One jsonb per load, stops included.
--    Owner: every column. Members: allow-list only; rate fields per the rule above.
create or replace function public.visible_loads(p_statuses text[] default null, p_load uuid default null)
returns setof jsonb language sql stable security definer set search_path = public as $$
  with v as (
    select l.*, public.load_viewer_role(l.user_id) as viewer_role
      from public.loads l
     where (p_load is null or l.id = p_load)
       and (p_statuses is null or l.status = any (p_statuses))
  ), r as (
    select v.*, (v.viewer_role in ('owner', 'management', 'dispatcher')
                 or (v.viewer_role = 'driver' and v.show_rate_to_driver)) as can_see_rate
      from v
     where v.viewer_role is not null
       and (v.viewer_role <> 'driver' or v.assigned_driver_user_id = auth.uid())
  )
  select case when r.viewer_role = 'owner'
           then to_jsonb(l2) - 'user_id'
           else jsonb_build_object(
             'id', r.id, 'status', r.status, 'broker_name', r.broker_name, 'broker_load_number', r.broker_load_number,
             'total_miles', r.total_miles, 'miles_source', r.miles_source, 'commodity', r.commodity, 'weight', r.weight,
             'equipment_type', r.equipment_type, 'special_instructions', r.special_instructions, 'notes', r.notes,
             'created_at', r.created_at, 'assigned_driver_user_id', r.assigned_driver_user_id,
             'show_rate_to_driver', r.show_rate_to_driver,
             'rate', case when r.can_see_rate then r.rate end,
             'rate_per_mile', case when r.can_see_rate then r.rate_per_mile end)
         end
         || jsonb_build_object(
              'viewer_role', r.viewer_role,
              'can_see_rate', r.can_see_rate,
              'stops', coalesce((select jsonb_agg(to_jsonb(s) - 'geocode_address' order by s.sequence) from public.stops s where s.load_id = r.id), '[]'::jsonb))
    from r join public.loads l2 on l2.id = r.id
   order by r.created_at desc;
$$;
revoke execute on function public.visible_loads(text[], uuid) from public, anon;
grant execute on function public.visible_loads(text[], uuid) to authenticated;

-- 5. Write path for the assignment + flag (owner, management, dispatcher). Errors: load_not_found, not_allowed,
--    assigned_driver_not_driver.
create or replace function public.set_load_driver_settings(p_load uuid, p_driver uuid, p_show boolean)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_owner uuid; v_role text; v_row record;
begin
  select user_id into v_owner from public.loads where id = p_load;
  v_role := public.load_viewer_role(v_owner);
  if v_owner is null or v_role is null then raise exception 'load_not_found' using errcode = 'P0001'; end if;
  if v_role not in ('owner', 'management', 'dispatcher') then raise exception 'not_allowed' using errcode = 'P0001'; end if;
  update public.loads set assigned_driver_user_id = p_driver, show_rate_to_driver = coalesce(p_show, false)
   where id = p_load returning id, assigned_driver_user_id, show_rate_to_driver into v_row;
  return jsonb_build_object('id', v_row.id, 'assigned_driver_user_id', v_row.assigned_driver_user_id, 'show_rate_to_driver', v_row.show_rate_to_driver);
end $$;
revoke execute on function public.set_load_driver_settings(uuid, uuid, boolean) from public, anon;
grant execute on function public.set_load_driver_settings(uuid, uuid, boolean) to authenticated;

-- 6. Driver picker for the create / edit forms: the owner's company members with role 'driver'.
--    p_owner null = the caller's own company (the owner). Only owner / management / dispatcher get rows.
create or replace function public.load_driver_choices(p_owner uuid default null)
returns table (user_id uuid, email text) language sql stable security definer set search_path = public as $$
  select m.user_id, u.email::text
    from public.company_members m
    join public.company_profiles p on p.id = m.profile_id
    join auth.users u on u.id = m.user_id
   where p.owner_id = coalesce(p_owner, auth.uid())
     and m.role = 'driver'
     and public.load_viewer_role(coalesce(p_owner, auth.uid())) in ('owner', 'management', 'dispatcher')
   order by u.email;
$$;
revoke execute on function public.load_driver_choices(uuid) from public, anon;
grant execute on function public.load_driver_choices(uuid) to authenticated;
