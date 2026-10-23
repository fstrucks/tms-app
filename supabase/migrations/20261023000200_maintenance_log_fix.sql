-- Maintenance log fixes after QA of #137 (Taylor, Oct 23 2026). Follow-up to 20261023000100 (applied in prod).
-- PROPOSED: Sam reviews, Dakota applies. Idempotent (create or replace / drop ... if exists / guarded grants).
-- ASCII only on purpose: the middle dot in 0100 showed up in prod expense descriptions as a stray A-circumflex plus dot.
--
-- 1. Driver access. In this schema a load records its driver as loads.assigned_driver_user_id = the driver's login
--    (auth.users.id, 20261018000600). The app never writes loads.truck_id (dispatch assigns a driver, not a truck)
--    and never writes drivers.auth_user_id (truck-tab roster), so 0100's maint_drives_truck was false for every
--    real driver: 403 on save, empty load picker. New rule, in order:
--      a. an active drivers row on this truck linked to his login -> yes
--      b. an open load (booked / dispatched / in_transit) of this company on this truck assigned to him -> yes
--      c. he is linked (drivers.auth_user_id) to a different truck -> no
--      d. an open load of this company with no truck assigned to him, and this truck is not linked to another
--         driver login -> yes  (no open load, e.g. after delivery -> no)
-- 2. Receipts: documents has column-level INSERT grants (20261010000200) and 0100 never granted service_record_id,
--    so every receipt insert failed with "permission denied". Grant insert (service_record_id).
-- 3. Expense description separator: ' - ' (ASCII). Existing descriptions fixed below.
-- 4. Load picker: this truck's loads only (open, or delivered / invoiced / paid in the last 30 days), newest first;
--    only when this truck has none, the same kind of loads with no truck assigned. Driver: only his own.
--    The trigger accepts exactly the loads the picker offers (maint_load_ok_for), checked only when load_id changes.
-- 5. Item costs: no item cost above the visit total, and the item sum not above the total (1 cent tolerance).
--    Checked after item insert / update and after a visit's total changes.

do $$ begin
  if to_regprocedure('public.maint_role(uuid)') is null then
    raise exception 'maintenance_log_fix: apply 20261023000100_maintenance_log.sql first';
  end if;
end $$;

-- 1.
create or replace function public.maint_drives_truck(p_truck uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select auth.uid() is not null and exists (
    select 1 from public.trucks t where t.id = p_truck and (
      exists (select 1 from public.drivers d where d.truck_id = t.id and d.auth_user_id = auth.uid() and d.active)
      or exists (select 1 from public.loads l where l.user_id = t.user_id and l.truck_id = t.id
                  and l.assigned_driver_user_id = auth.uid() and l.status in ('booked', 'dispatched', 'in_transit'))
      or (not exists (select 1 from public.drivers d where d.auth_user_id = auth.uid() and d.active and d.truck_id is not null and d.truck_id <> t.id)
          and not exists (select 1 from public.drivers d where d.truck_id = t.id and d.active and d.auth_user_id is not null and d.auth_user_id <> auth.uid())
          and exists (select 1 from public.loads l where l.user_id = t.user_id and l.truck_id is null
                       and l.assigned_driver_user_id = auth.uid() and l.status in ('booked', 'dispatched', 'in_transit')))));
$$;

-- 4.
create or replace function public.maint_load_choices(p_truck uuid)
returns table (id uuid, broker_load_number text, broker_name text, status text, truck_id uuid, created_at timestamptz)
language sql stable security definer set search_path = public as $$
  with t as (
    select t.id, t.user_id from public.trucks t
     where t.id = p_truck and public.maint_can_see(t.user_id, t.id) and public.maint_role(t.user_id) in ('owner', 'management', 'driver')
  ), c as (
    select l.id, l.broker_load_number, l.broker_name, l.status, l.truck_id, l.created_at
      from public.loads l join t on l.user_id = t.user_id
     where (public.maint_role(t.user_id) <> 'driver' or l.assigned_driver_user_id = auth.uid())
       and (l.truck_id = t.id or l.truck_id is null)
       and (l.status in ('booked', 'dispatched', 'in_transit')
            or (l.status in ('delivered', 'invoiced', 'paid') and coalesce(l.updated_at, l.created_at) > now() - interval '30 days'))
  )
  select c.* from c
   where c.truck_id = p_truck or not exists (select 1 from c c2 where c2.truck_id = p_truck)
   order by c.created_at desc
   limit 40;
$$;
create or replace function public.maint_load_ok_for(p_truck uuid, p_load uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select p_load is null or exists (select 1 from public.maint_load_choices(p_truck) c where c.id = p_load);
$$;

-- 3. + 4. BEFORE trigger: same as 0100 except the ASCII separator and the picker-matching load check.
create or replace function public.service_records_before()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_owner uuid; v_unit text; v_want boolean; v_desc text;
begin
  select user_id, unit_number into v_owner, v_unit from public.trucks where id = new.truck_id;
  if v_owner is null then raise exception 'truck_not_found' using errcode = '23503'; end if;
  new.owner_id := v_owner;
  if tg_op = 'INSERT' then
    new.created_by := coalesce(auth.uid(), new.created_by);
    new.created_at := now();
    new.expense_id := null;
  else
    if new.truck_id is distinct from old.truck_id and old.owner_id <> v_owner then raise exception 'other_company_truck' using errcode = '42501'; end if;
    new.created_by := old.created_by; new.created_at := old.created_at;
    -- Keep the link only while that expense still exists. When it was deleted (from Expenses), the FK's
    -- ON DELETE SET NULL arrives here as an UPDATE: drop the link and stop syncing so it isn't re-created.
    if old.expense_id is not null and exists (select 1 from public.expenses e where e.id = old.expense_id) then
      new.expense_id := old.expense_id;
    else
      if old.expense_id is not null then new.add_to_expenses := false; end if;
      new.expense_id := null;
    end if;
  end if;
  if new.odometer is not null and (tg_op = 'INSERT' or new.odometer is distinct from old.odometer)
     and public.maint_odometer_jump(new.truck_id, new.odometer) then
    raise exception 'odometer_jump' using errcode = '22023';
  end if;
  new.updated_at := now();
  if new.load_id is not null and (tg_op = 'INSERT' or new.load_id is distinct from old.load_id) and not public.maint_load_ok_for(new.truck_id, new.load_id) then
    raise exception 'load_not_allowed' using errcode = '42501';
  end if;

  v_want := new.add_to_expenses and new.total_cost > 0 and new.entry_source = 'logged';
  v_desc := left(concat_ws(' - ', 'Maintenance', 'Truck #' || v_unit, nullif(btrim(new.vendor_name), '')), 200);
  if v_want and new.expense_id is null then
    insert into public.expenses (user_id, category, amount, expense_date, description, load_id)
    values (v_owner, 'maintenance', new.total_cost, new.service_date, v_desc, new.load_id)
    returning id into new.expense_id;
  elsif v_want then
    update public.expenses set amount = new.total_cost, expense_date = new.service_date, description = v_desc, load_id = new.load_id
     where id = new.expense_id;
  elsif new.expense_id is not null then
    new.expense_id := null;  -- the AFTER trigger deletes the old expense (FK on the row being updated)
  end if;
  return new;
end $$;

update public.expenses e
   set description = replace(replace(e.description, chr(194) || chr(183), '-'), chr(183), '-')
  from public.service_records r
 where r.expense_id = e.id and e.description like 'Maintenance%' and strpos(e.description, chr(183)) > 0;

-- 5.
create or replace function public.maint_check_item_costs(p_record uuid)
returns void language plpgsql stable security definer set search_path = public as $$
declare v_total numeric; v_max numeric; v_sum numeric;
begin
  select r.total_cost into v_total from public.service_records r where r.id = p_record;
  if v_total is null then return; end if;
  select max(i.cost), coalesce(sum(i.cost), 0) into v_max, v_sum from public.service_record_items i where i.service_record_id = p_record;
  if v_max > v_total then raise exception 'item_over_total' using errcode = '23514'; end if;
  if v_sum > v_total + 0.01 then raise exception 'items_over_total' using errcode = '23514'; end if;
end $$;
create or replace function public.service_record_items_cost_check()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform public.maint_check_item_costs(new.service_record_id);
  return null;
end $$;
drop trigger if exists service_record_items_cost_check on public.service_record_items;
create trigger service_record_items_cost_check after insert or update of cost, service_record_id on public.service_record_items
  for each row execute function public.service_record_items_cost_check();
create or replace function public.service_records_cost_check()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform public.maint_check_item_costs(new.id);
  return null;
end $$;
drop trigger if exists service_records_cost_check on public.service_records;
create trigger service_records_cost_check after update of total_cost on public.service_records
  for each row execute function public.service_records_cost_check();

-- Grants.
do $$ declare f text; begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant insert (service_record_id) on public.documents to authenticated'; -- 2.
  end if;
  foreach f in array array['maint_load_ok_for(uuid,uuid)'] loop
    execute format('revoke all on function public.%s from public', f);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function public.%s from anon', f); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('grant execute on function public.%s to authenticated', f); end if;
  end loop;
  foreach f in array array['maint_check_item_costs(uuid)', 'service_record_items_cost_check()', 'service_records_cost_check()'] loop
    execute format('revoke all on function public.%s from public', f);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function public.%s from anon', f); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke all on function public.%s from authenticated', f); end if;
  end loop;
end $$;
