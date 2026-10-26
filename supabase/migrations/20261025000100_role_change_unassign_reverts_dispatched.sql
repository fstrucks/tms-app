-- Role change: a dispatched load with no driver goes back to booked.
-- Marc's rule (via Sam, Oct 25 2026). The owner driver card and the dispatch edit
-- already do this in the app (PR #151). public.set_member_role and
-- public.set_member_also_drives, last defined in 20261020000100_member_also_drives.sql,
-- clear loads.assigned_driver_user_id and set show_rate_to_driver = false when a
-- person stops driving, and they leave loads.status alone. A dispatched load then
-- stays dispatched with no driver.
--
-- This replaces those two live function bodies. The only change in each is the
-- unassign UPDATE: a row whose status is 'dispatched' becomes 'booked' in that
-- same statement. booked, in_transit, delivered, invoiced, paid, and cancelled
-- keep the status they already have. show_rate_to_driver stays false. The WHERE
-- clause is unchanged (that company's loads assigned to that person), so
-- unassigned_loads is still the number of loads unassigned, not only the ones
-- that were dispatched.
--
-- security definer, search_path = public, the revoke/grant lines, the role checks,
-- and company scoping are the same as 20261020000100. No table, column, policy,
-- or grant on a table changes. Loads already sitting as dispatched with a null
-- driver are not rewritten.
-- Idempotent: create or replace, then the same revoke and grant. Safe to re-run.
--
-- After applying, run the read-only checks in
-- supabase/one-off/20261025_role_change_unassign_status_check.sql.
--
-- Rollback: create or replace both functions again from the bodies in
-- 20261020000100_member_also_drives.sql. In each unassign UPDATE, remove the
-- status assignment so the statement is again:
--   update public.loads l set assigned_driver_user_id = null, show_rate_to_driver = false
--    where l.user_id = v_profile.owner_id and l.assigned_driver_user_id = p_user;
-- Do not drop either function. Signatures and return columns stay as they are.

begin;

create or replace function public.set_member_role(p_user uuid, p_role text, p_also_drives boolean default null)
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
    update public.loads l
       set assigned_driver_user_id = null,
           show_rate_to_driver = false,
           status = case when l.status = 'dispatched' then 'booked' else l.status end
     where l.user_id = v_profile.owner_id and l.assigned_driver_user_id = p_user;
    get diagnostics v_count = row_count;
  end if;
  update public.company_members m set role = p_role, also_drives = v_new_also
   where m.profile_id = v_profile.id and m.user_id = p_user;
  return query select p_user, v_old, p_role, v_count, v_new_also;
end $$;
revoke all on function public.set_member_role(uuid, text, boolean) from public, anon;
grant execute on function public.set_member_role(uuid, text, boolean) to authenticated;

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
    update public.loads l
       set assigned_driver_user_id = null,
           show_rate_to_driver = false,
           status = case when l.status = 'dispatched' then 'booked' else l.status end
     where l.user_id = v_profile.owner_id and l.assigned_driver_user_id = p_user;
    get diagnostics v_count = row_count;
  end if;
  update public.company_members m set also_drives = coalesce(p_on, false) where m.profile_id = v_profile.id and m.user_id = p_user;
  return query select p_user, coalesce(p_on, false), v_count;
end $$;
revoke all on function public.set_member_also_drives(uuid, boolean) from public, anon;
grant execute on function public.set_member_also_drives(uuid, boolean) to authenticated;

commit;
