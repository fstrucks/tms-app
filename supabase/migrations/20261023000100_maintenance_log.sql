-- 20261023000100: Truck maintenance log, PR 1 (PROPOSED, NOT APPLIED). Sam reviews, Dakota applies.
-- One service_records row = one shop visit (truck, date, miles, vendor, total cost, receipts, optional load).
-- service_record_items = the services done on that visit (oil and filter, tires, ...), with optional cost each.
-- Company scoped like 20261022250000: the data owner is the company owner (owner_id = trucks.user_id), and access
-- comes from company_role() of that owner's company:
--   owner / management : full access in their company
--   dispatcher         : read only
--   driver             : read + add for the truck he drives (drivers.auth_user_id → truck_id, or a load with that
--                        truck assigned to him); change / delete only his own entries within 24 hours
-- Expenses: a BEFORE trigger (security definer) keeps exactly one expenses row per visit while total_cost > 0,
-- add_to_expenses is true and entry_source = 'logged'. Removing the visit removes that expense.
-- trucks was created outside migrations (design §1.1): catalog-checked, only missing pieces are added.
-- Idempotent: if not exists / create or replace / drop policy if exists. Safe to re-run.
begin;

do $$ begin
  if to_regclass('public.trucks') is null or to_regclass('public.loads') is null or to_regclass('public.expenses') is null
     or to_regclass('public.documents') is null or to_regclass('public.company_profiles') is null or to_regclass('public.drivers') is null then
    raise exception 'maintenance_log: trucks / loads / expenses / documents / company_profiles / drivers must exist first';
  end if;
end $$;

-- 1. trucks (§1.1): only what's missing.
alter table public.trucks add column if not exists odometer integer;
alter table public.trucks add column if not exists odometer_updated_at timestamptz;
do $$ begin
  -- design §1.1 ("id default: set gen_random_uuid() only if missing"), kept as specified there.
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'trucks' and column_name = 'id' and column_default is null) then
    alter table public.trucks alter column id set default gen_random_uuid();
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.trucks'::regclass and conname = 'trucks_odometer_nonneg') then
    alter table public.trucks add constraint trucks_odometer_nonneg check (odometer is null or odometer >= 0) not valid;
  end if;
  -- Validate now; if prod already has negative readings, leave it NOT VALID (new writes are still checked) and say so.
  if exists (select 1 from pg_constraint where conrelid = 'public.trucks'::regclass and conname = 'trucks_odometer_nonneg' and not convalidated) then
    if exists (select 1 from public.trucks where odometer < 0) then
      raise notice 'maintenance_log: trucks has negative odometer rows; trucks_odometer_nonneg left NOT VALID until they are fixed';
    else
      alter table public.trucks validate constraint trucks_odometer_nonneg;
    end if;
  end if;
  if not exists (select 1 from pg_class where oid = 'public.trucks'::regclass and relrowsecurity) then
    raise notice 'maintenance_log: RLS is OFF on public.trucks (not changed here; report to Sam)';
  end if;
end $$;

-- 2. Tables.
create table if not exists public.service_records (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,    -- company owner (data owner)
  truck_id uuid not null references public.trucks(id) on delete cascade,
  load_id uuid references public.loads(id) on delete set null,
  service_date date not null,
  odometer integer check (odometer is null or odometer between 0 and 9999999),
  vendor_name text check (vendor_name is null or length(vendor_name) <= 120),
  total_cost numeric(10,2) not null default 0 check (total_cost >= 0),
  notes text check (notes is null or length(notes) <= 1000),
  add_to_expenses boolean not null default true,
  entry_source text not null default 'logged' check (entry_source in ('logged', 'baseline')),
  expense_id uuid unique references public.expenses(id) on delete set null,
  created_by uuid default auth.uid() references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists service_records_truck_idx on public.service_records (owner_id, truck_id, service_date desc, created_at desc);
create index if not exists service_records_load_idx on public.service_records (load_id) where load_id is not null;

create table if not exists public.service_record_items (
  id uuid primary key default gen_random_uuid(),
  service_record_id uuid not null references public.service_records(id) on delete cascade,
  service_type text not null,
  service_label text check (service_label is null or length(service_label) <= 80),
  cost numeric(10,2) check (cost is null or cost >= 0),
  notes text check (notes is null or length(notes) <= 300),
  created_at timestamptz not null default now()
);
-- Named check so PR 2 can drop / re-add it with more types.
do $$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.service_record_items'::regclass and conname = 'service_record_items_type_check') then
    alter table public.service_record_items add constraint service_record_items_type_check check (service_type in
      ('oil_filter', 'fuel_filters', 'air_filter', 'coolant', 'def_filter', 'valve_adjustment', 'transmission',
       'differential', 'tires', 'brakes', 'grease', 'dot_annual', 'other'));
  end if;
end $$;
create index if not exists service_record_items_record_idx on public.service_record_items (service_record_id);

-- Receipts: documents.service_record_id (many per visit, max 10). doc_type 'maintenance_receipt'.
alter table public.documents add column if not exists service_record_id uuid references public.service_records(id) on delete set null;
create index if not exists documents_service_record_idx on public.documents (service_record_id) where service_record_id is not null;
do $$ declare c record; begin  -- extend a doc_type check only if prod has one
  for c in select conname, pg_get_constraintdef(oid) def from pg_constraint
            where conrelid = 'public.documents'::regclass and contype = 'c' and pg_get_constraintdef(oid) ilike '%doc_type%' loop
    if c.def not ilike '%maintenance_receipt%' then
      raise exception 'maintenance_log: documents has a doc_type check (%) without maintenance_receipt. Extend it by hand after review: %', c.conname, c.def;
    end if;
  end loop;
end $$;

-- 3. Access helpers (security definer; read only).
-- Caller's role in the company whose owner is p_owner ('owner' for the owner himself).
create or replace function public.maint_role(p_owner uuid)
returns text language sql stable security definer set search_path = public as $$
  select case when p_owner is null or auth.uid() is null then null
    when p_owner = auth.uid() then 'owner'
    else (select m.role from public.company_members m join public.company_profiles cp on cp.id = m.profile_id
           where cp.owner_id = p_owner and m.user_id = auth.uid()
           order by case m.role when 'management' then 1 when 'dispatcher' then 2 when 'driver' then 3 else 4 end limit 1) end;
$$;
-- Does the caller drive this truck? An active driver record linking his login to it, or an open load
-- (booked / dispatched / in_transit) on this truck assigned to him. Old delivered loads don't count.
create or replace function public.maint_drives_truck(p_truck uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select auth.uid() is not null and (
    exists (select 1 from public.drivers d where d.truck_id = p_truck and d.auth_user_id = auth.uid() and d.active)
    or exists (select 1 from public.loads l where l.truck_id = p_truck and l.assigned_driver_user_id = auth.uid()
                and l.status in ('booked', 'dispatched', 'in_transit')));
$$;
create or replace function public.maint_can_see(p_owner uuid, p_truck uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select case public.maint_role(p_owner) when 'owner' then true when 'management' then true when 'dispatcher' then true
    when 'driver' then public.maint_drives_truck(p_truck) else false end;
$$;
-- May the caller change / delete this visit? Office: always. Driver: own entry, his truck, within 24 h.
create or replace function public.maint_can_change(p_owner uuid, p_truck uuid, p_created_by uuid, p_created_at timestamptz)
returns boolean language sql stable security definer set search_path = public as $$
  select case public.maint_role(p_owner) when 'owner' then true when 'management' then true
    when 'driver' then p_created_by = auth.uid() and p_created_at > now() - interval '24 hours' and public.maint_drives_truck(p_truck)
    else false end;
$$;
-- Load picker rule: load of the same company; a driver only his own assigned loads.
create or replace function public.maint_load_ok(p_owner uuid, p_load uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select p_load is null or exists (select 1 from public.loads l where l.id = p_load and l.user_id = p_owner
    and (public.maint_role(p_owner) <> 'driver' or l.assigned_driver_user_id = auth.uid()));
$$;
create or replace function public.maint_truck_owner(p_truck uuid)
returns uuid language sql stable security definer set search_path = public as $$
  select t.user_id from public.trucks t where t.id = p_truck and public.maint_role(t.user_id) is not null; -- null unless the caller is in that company
$$;
create or replace function public.maint_record_visible(p_record uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.service_records r where r.id = p_record and public.maint_can_see(r.owner_id, r.truck_id));
$$;
create or replace function public.maint_record_changeable(p_record uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.service_records r where r.id = p_record and public.maint_can_change(r.owner_id, r.truck_id, r.created_by, r.created_at)
    and (r.entry_source = 'logged' or public.maint_role(r.owner_id) = 'owner')); -- baseline visits: owner only
$$;

-- Loads for the "Add to a load" picker: the caller's company only (a driver: only loads assigned to him).
-- Open loads, plus delivered / invoiced / paid ones from the last 30 days; this truck's loads first, newest first.
create or replace function public.maint_load_choices(p_truck uuid)
returns table (id uuid, broker_load_number text, broker_name text, status text, truck_id uuid, created_at timestamptz)
language sql stable security definer set search_path = public as $$
  select l.id, l.broker_load_number, l.broker_name, l.status, l.truck_id, l.created_at
    from public.trucks t join public.loads l on l.user_id = t.user_id
   where t.id = p_truck and public.maint_can_see(t.user_id, t.id)
     and public.maint_role(t.user_id) in ('owner', 'management', 'driver')
     and (public.maint_role(t.user_id) <> 'driver' or l.assigned_driver_user_id = auth.uid())
     and (l.status in ('booked', 'dispatched', 'in_transit')
          or (l.status in ('delivered', 'invoiced', 'paid') and coalesce(l.updated_at, l.created_at) > now() - interval '30 days'))
   order by (l.truck_id = p_truck) desc nulls last, l.created_at desc
   limit 40;
$$;

-- Sanity cap: a reading more than 50,000 mi above the truck's current odometer is rejected unless the caller is the owner.
create or replace function public.maint_odometer_jump(p_truck uuid, p_odometer integer)
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select p_odometer > t.odometer + 50000 and public.maint_role(t.user_id) is distinct from 'owner'
                     from public.trucks t where t.id = p_truck), false);
$$;

-- Manual odometer edit (owner / management). Can lower it (typo fix); stamps odometer_updated_at.
create or replace function public.set_truck_odometer(p_truck uuid, p_odometer integer)
returns timestamptz language plpgsql security definer set search_path = public as $$
declare v_owner uuid; v_now timestamptz := now();
begin
  select user_id into v_owner from public.trucks where id = p_truck;
  if v_owner is null or coalesce(public.maint_role(v_owner) in ('owner', 'management'), false) is false then
    raise exception 'not_allowed' using errcode = '42501';
  end if;
  if p_odometer is null or p_odometer < 0 or p_odometer > 9999999 then raise exception 'bad_odometer' using errcode = '22023'; end if;
  if public.maint_odometer_jump(p_truck, p_odometer) then raise exception 'odometer_jump' using errcode = '22023'; end if;
  update public.trucks set odometer = p_odometer, odometer_updated_at = v_now where id = p_truck;
  return v_now;
end $$;

-- 4. Triggers.
-- BEFORE: owner_id always = the truck's owner; created_by / expense_id not client-settable; load must pass the
-- picker rule; keeps the one linked expense in sync (create once, update in place, delete when no longer wanted).
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
  if new.load_id is not null and (tg_op = 'INSERT' or new.load_id is distinct from old.load_id) and not public.maint_load_ok(v_owner, new.load_id) then
    raise exception 'load_not_allowed' using errcode = '42501';
  end if;

  v_want := new.add_to_expenses and new.total_cost > 0 and new.entry_source = 'logged';
  v_desc := left(concat_ws(' · ', 'Maintenance', 'Truck #' || v_unit, nullif(btrim(new.vendor_name), '')), 200);
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
drop trigger if exists service_records_before on public.service_records;
create trigger service_records_before before insert or update on public.service_records
  for each row execute function public.service_records_before();

-- AFTER insert/update: raise trucks.odometer to the visit's miles if higher (never lowers it).
create or replace function public.service_records_bump_odometer()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.odometer is not null then
    update public.trucks set odometer = new.odometer, odometer_updated_at = now()
     where id = new.truck_id and (odometer is null or odometer < new.odometer);
  end if;
  return null;
end $$;
drop trigger if exists service_records_bump_odometer on public.service_records;
create trigger service_records_bump_odometer after insert or update of odometer, truck_id on public.service_records
  for each row execute function public.service_records_bump_odometer();

-- AFTER update / delete: remove the auto-created expense once the visit no longer wants it, or is deleted.
create or replace function public.service_records_after_delete()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if old.expense_id is not null and (tg_op = 'DELETE' or new.expense_id is null) then
    delete from public.expenses where id = old.expense_id;
  end if;
  return null;
end $$;
drop trigger if exists service_records_after_delete on public.service_records;
create trigger service_records_after_delete after update or delete on public.service_records
  for each row execute function public.service_records_after_delete();

-- BEFORE delete: remove the visit's receipt rows. Must run BEFORE: the FK's ON DELETE SET NULL on
-- documents.service_record_id (an AFTER action) would otherwise unlink them first. Storage files are not removed
-- here (Supabase wants the Storage API for that); the app removes them, see app/api/truck/maintenance.
create or replace function public.service_records_before_delete()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  delete from public.documents where service_record_id = old.id and doc_type = 'maintenance_receipt';
  return old;
end $$;
drop trigger if exists service_records_before_delete on public.service_records;
create trigger service_records_before_delete before delete on public.service_records
  for each row execute function public.service_records_before_delete();

-- documents.service_record_id: caller must be allowed to change that visit; only untyped or maintenance_receipt
-- documents may be linked (an existing BOL or rate con is never relabelled); max 10 per visit, under a lock.
create or replace function public.documents_service_record_check()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.service_record_id is not null and (tg_op = 'INSERT' or new.service_record_id is distinct from old.service_record_id) then
    if auth.uid() is not null and not public.maint_record_changeable(new.service_record_id) then
      raise exception 'service_record_not_allowed' using errcode = '42501';
    end if;
    if new.doc_type is not null and new.doc_type <> 'maintenance_receipt' then
      raise exception 'not_a_receipt' using errcode = '23514';
    end if;
    perform pg_advisory_xact_lock(hashtextextended('maint_receipts:' || new.service_record_id::text, 0)); -- no race past 10
    if (select count(*) from public.documents d where d.service_record_id = new.service_record_id and d.id <> new.id) >= 10 then
      raise exception 'too_many_receipts' using errcode = '23514';
    end if;
    new.doc_type := 'maintenance_receipt';
  end if;
  return new;
end $$;
drop trigger if exists documents_service_record_check on public.documents;
create trigger documents_service_record_check before insert or update of service_record_id on public.documents
  for each row execute function public.documents_service_record_check();

-- 5. RLS.
alter table public.service_records enable row level security;
alter table public.service_record_items enable row level security;

drop policy if exists service_records_select on public.service_records;
create policy service_records_select on public.service_records for select to authenticated
  using (public.maint_can_see(owner_id, truck_id));
drop policy if exists service_records_insert on public.service_records;
create policy service_records_insert on public.service_records for insert to authenticated
  with check (owner_id = public.maint_truck_owner(truck_id)
    and (coalesce(public.maint_role(owner_id) = 'owner', false)
         or (public.maint_role(owner_id) = 'management' and entry_source = 'logged')
         or (public.maint_role(owner_id) = 'driver' and public.maint_drives_truck(truck_id) and entry_source = 'logged')));
drop policy if exists service_records_update on public.service_records;
create policy service_records_update on public.service_records for update to authenticated
  using (public.maint_can_change(owner_id, truck_id, created_by, created_at))
  with check (public.maint_can_change(owner_id, truck_id, created_by, created_at)
    and (entry_source = 'logged' or coalesce(public.maint_role(owner_id) = 'owner', false)));
drop policy if exists service_records_delete on public.service_records;
create policy service_records_delete on public.service_records for delete to authenticated
  using (public.maint_can_change(owner_id, truck_id, created_by, created_at));

drop policy if exists service_record_items_select on public.service_record_items;
create policy service_record_items_select on public.service_record_items for select to authenticated
  using (public.maint_record_visible(service_record_id));
drop policy if exists service_record_items_insert on public.service_record_items;
create policy service_record_items_insert on public.service_record_items for insert to authenticated
  with check (public.maint_record_changeable(service_record_id));
drop policy if exists service_record_items_update on public.service_record_items;
create policy service_record_items_update on public.service_record_items for update to authenticated
  using (public.maint_record_changeable(service_record_id)) with check (public.maint_record_changeable(service_record_id));
drop policy if exists service_record_items_delete on public.service_record_items;
create policy service_record_items_delete on public.service_record_items for delete to authenticated
  using (public.maint_record_changeable(service_record_id));

-- Receipts: readable by everyone who can see the visit (adds to the existing own-row documents policies).
drop policy if exists documents_select_service_record on public.documents;
create policy documents_select_service_record on public.documents for select to authenticated
  using (service_record_id is not null and public.maint_record_visible(service_record_id));
do $$ begin
  if to_regclass('storage.objects') is not null then
    execute 'drop policy if exists documents_select_service_record on storage.objects';
    execute $p$create policy documents_select_service_record on storage.objects for select to authenticated
      using (bucket_id = 'documents' and exists (select 1 from public.documents d where d.file_path = storage.objects.name
        and d.service_record_id is not null and public.maint_record_visible(d.service_record_id)))$p$;
  end if;
end $$;

-- 6. Grants: authenticated only. owner_id / created_by / expense_id / timestamps are trigger-set, not client columns.
revoke all on public.service_records, public.service_record_items from public;
do $$ declare f text; begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on public.service_records, public.service_record_items from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant select, delete on public.service_records, public.service_record_items to authenticated';
    execute 'grant insert (id, truck_id, load_id, service_date, odometer, vendor_name, total_cost, notes, add_to_expenses, entry_source, owner_id) on public.service_records to authenticated';
    execute 'grant update (truck_id, load_id, service_date, odometer, vendor_name, total_cost, notes, add_to_expenses) on public.service_records to authenticated';
    execute 'grant insert (id, service_record_id, service_type, service_label, cost, notes), update (service_type, service_label, cost, notes) on public.service_record_items to authenticated';
  end if;
  foreach f in array array['maint_role(uuid)', 'maint_drives_truck(uuid)', 'maint_can_see(uuid,uuid)', 'maint_can_change(uuid,uuid,uuid,timestamptz)',
      'maint_load_ok(uuid,uuid)', 'maint_record_visible(uuid)', 'maint_truck_owner(uuid)', 'maint_record_changeable(uuid)', 'maint_odometer_jump(uuid,integer)', 'maint_load_choices(uuid)', 'set_truck_odometer(uuid,integer)'] loop
    execute format('revoke all on function public.%s from public', f);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function public.%s from anon', f); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('grant execute on function public.%s to authenticated', f); end if;
  end loop;
  foreach f in array array['service_records_before()', 'service_records_bump_odometer()', 'service_records_after_delete()', 'service_records_before_delete()', 'documents_service_record_check()'] loop
    execute format('revoke all on function public.%s from public', f);
  end loop;
end $$;

commit;
