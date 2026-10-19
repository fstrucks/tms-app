-- Owner-only member-role editor. ADDITIVE: two functions + one guard trigger. NOT APPLIED to prod
-- (needs Marc's OK relayed by Sam; Dakota applies). No table, column, policy or grant changes on existing objects;
-- own-row RLS on loads/stops/company tables is untouched.

-- Depends on 20261018000600 (loads.assigned_driver_user_id / show_rate_to_driver; applied on prod). Works with or
-- without 20261018000700 (applied on prod): unassigning sets the driver to null, which the assigned-driver trigger allows.

-- set_member_role(p_user, p_role): the caller must OWN a company (company_profiles.owner_id = auth.uid()).
-- p_user must already be a member of THAT company, must not be the owner or an 'owner' member, and p_role must be
-- driver, dispatcher or management. When a driver becomes something else, they are unassigned from every load of
-- that company in the same transaction (assigned_driver_user_id = null, show_rate_to_driver = false), so no load is
-- left pointing at a non-driver (which made later driver saves fail with assigned_driver_not_driver).
-- Returns the old and new role and how many loads were unassigned.
-- Errors (SQLSTATE P0001, message is the code): not_signed_in, not_owner, bad_role, not_member, owner_locked.
drop function if exists public.set_member_role(uuid, text); -- return type changed during review; safe, never applied
create function public.set_member_role(p_user uuid, p_role text)
returns table (user_id uuid, old_role text, new_role text, unassigned_loads integer)
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_profile public.company_profiles%rowtype;
  v_old text;
  v_count integer := 0;
begin
  if v_uid is null then raise exception 'not_signed_in'; end if;
  select * into v_profile from public.company_profiles p where p.owner_id = v_uid;
  if not found then raise exception 'not_owner'; end if;
  if p_role is null or p_role not in ('driver', 'dispatcher', 'management') then raise exception 'bad_role'; end if;
  select m.role into v_old from public.company_members m where m.profile_id = v_profile.id and m.user_id = p_user for update;
  if not found then raise exception 'not_member'; end if;
  if p_user = v_profile.owner_id or v_old = 'owner' then raise exception 'owner_locked'; end if;
  if v_old = 'driver' and p_role <> 'driver' then
    update public.loads l set assigned_driver_user_id = null, show_rate_to_driver = false
     where l.user_id = v_profile.owner_id and l.assigned_driver_user_id = p_user;
    get diagnostics v_count = row_count;
  end if;
  update public.company_members m set role = p_role where m.profile_id = v_profile.id and m.user_id = p_user;
  return query select p_user, v_old, p_role, v_count;
end $$;
revoke all on function public.set_member_role(uuid, text) from public, anon;
grant execute on function public.set_member_role(uuid, text) to authenticated;

-- member_assigned_load_count(p_user): for the confirmation ("X is assigned to N loads"). Same owner / same-company
-- checks as set_member_role (not_signed_in, not_owner, not_member); read-only. Counts that company's loads where
-- p_user is the assigned driver.
create or replace function public.member_assigned_load_count(p_user uuid)
returns integer language plpgsql stable security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_profile public.company_profiles%rowtype;
begin
  if v_uid is null then raise exception 'not_signed_in'; end if;
  select * into v_profile from public.company_profiles p where p.owner_id = v_uid;
  if not found then raise exception 'not_owner'; end if;
  if not exists (select 1 from public.company_members m where m.profile_id = v_profile.id and m.user_id = p_user) then raise exception 'not_member'; end if;
  return (select count(*)::integer from public.loads l where l.user_id = v_profile.owner_id and l.assigned_driver_user_id = p_user);
end $$;
revoke all on function public.member_assigned_load_count(uuid) from public, anon;
grant execute on function public.member_assigned_load_count(uuid) to authenticated;

-- Guard for every write path (incl. the existing owner-only direct-write policy and service-role code): never demote
-- or remove the company owner's own member row, or the company's last 'owner' member. Cascades are let through when
-- the company or the auth user itself is being deleted (the parent row is already gone at that point).
create or replace function public.company_members_keep_owner()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if old.role <> 'owner' then return case when tg_op = 'DELETE' then old else new end; end if;
  if tg_op = 'UPDATE' and new.role = 'owner' and new.user_id = old.user_id and new.profile_id = old.profile_id then return new; end if;
  if not exists (select 1 from public.company_profiles p where p.id = old.profile_id) then return case when tg_op = 'DELETE' then old else new end; end if;
  if not exists (select 1 from auth.users u where u.id = old.user_id) then return case when tg_op = 'DELETE' then old else new end; end if;
  if exists (select 1 from public.company_profiles p where p.id = old.profile_id and p.owner_id = old.user_id)
     or not exists (select 1 from public.company_members m where m.profile_id = old.profile_id and m.role = 'owner' and m.user_id <> old.user_id) then
    raise exception 'last_owner' using hint = 'The company owner can’t be removed or demoted.';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end $$;
drop trigger if exists company_members_keep_owner on public.company_members;
create trigger company_members_keep_owner before update or delete on public.company_members
  for each row execute function public.company_members_keep_owner();
