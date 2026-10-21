-- Setup checklist status. ADDITIVE ONLY. Do not apply from the app; Dakota applies after review.
-- The master list of items lives in app/lib/setupCatalog.js (no admin screen, no item table).
-- Depends on company_profiles / company_role / company_can_edit (20261015001200).
-- drivers and trucks are read only inside checklist_driver_truck(); the function is safe if those tables are missing.

alter table public.company_profiles
  add column if not exists setup_started_at timestamptz,
  add column if not exists setup_completed_at timestamptz,
  add column if not exists setup_dismissed_at timestamptz,
  add column if not exists setup_prompted_at timestamptz,
  add column if not exists operation_answers jsonb not null default '{}'::jsonb,
  add column if not exists ifta_renewal_on date,
  add column if not exists irp_renewal_on date,
  add column if not exists hvut_first_use_on date;

alter table public.company_profiles drop constraint if exists company_profiles_operation_answers_object;
alter table public.company_profiles
  add constraint company_profiles_operation_answers_object check (jsonb_typeof(operation_answers) = 'object');

-- One row per company + item + truck/trailer/driver. Status is the user's tick; uploads are still read from documents.
create table if not exists public.company_checklist_status (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.company_profiles(id) on delete cascade,
  item_key text not null check (length(btrim(item_key)) between 1 and 80),
  truck_id uuid,
  trailer_id uuid,
  driver_id uuid,
  status text not null check (status in ('done', 'not_yet', 'not_needed', 'skipped')),
  checked_by uuid references auth.users(id),
  checked_at timestamptz not null default now(),
  expiry_on date,
  note text,
  document_id uuid references public.documents(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists company_checklist_status_company_idx on public.company_checklist_status (company_id, item_key);
create unique index if not exists company_checklist_status_uniq on public.company_checklist_status (
  company_id,
  item_key,
  coalesce(truck_id, '00000000-0000-0000-0000-000000000000'::uuid),
  coalesce(trailer_id, '00000000-0000-0000-0000-000000000000'::uuid),
  coalesce(driver_id, '00000000-0000-0000-0000-000000000000'::uuid)
);

-- Mirrors app/lib/setupCatalog.js driverAccess. Equipment: a driver may tick. Binder: a driver may read.
create or replace function public.checklist_item_access(p_key text)
returns text
language sql
immutable
as $$
  select case
    when p_key in (
      'fire_extinguisher', 'warning_devices', 'spare_fuses', 'pretrip_gear', 'tiedowns', 'tire_chains',
      'spare_bulbs', 'tire_gauges', 'night_gear', 'first_aid', 'wheel_chocks', 'tool_kit', 'tarps',
      'phone_power', 'breakaway'
    ) then 'equipment'
    when p_key in (
      'eld_manual', 'eld_transfer', 'eld_malfunction', 'blank_logs', 'accident_kit', 'bol_papers', 'hazmat_papers'
    ) then 'binder'
    else 'office'
  end;
$$;

-- True when this driver login may see that truck. A linked drivers.auth_user_id wins.
-- If no driver row is linked yet, any truck of their company is allowed so a one-truck fleet is not locked out.
create or replace function public.checklist_driver_truck(p_truck uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if p_truck is null then
    return false;
  end if;
  if to_regclass('public.drivers') is null or to_regclass('public.trucks') is null then
    return false;
  end if;
  if exists (
    select 1 from public.drivers d
    where d.auth_user_id = auth.uid() and coalesce(d.active, true) and d.truck_id = p_truck
  ) then
    return true;
  end if;
  if exists (
    select 1 from public.drivers d
    where d.auth_user_id = auth.uid() and d.truck_id is not null
  ) then
    return false;
  end if;
  return exists (
    select 1 from public.trucks t
    join public.company_profiles p on p.owner_id = t.user_id
    where t.id = p_truck and public.company_role(p.id) = 'driver'
  );
end $$;

revoke all on function public.checklist_item_access(text) from public;
revoke all on function public.checklist_driver_truck(uuid) from public;
grant execute on function public.checklist_item_access(text) to authenticated;
grant execute on function public.checklist_driver_truck(uuid) to authenticated;

alter table public.company_checklist_status enable row level security;

drop policy if exists company_checklist_status_select on public.company_checklist_status;
create policy company_checklist_status_select on public.company_checklist_status
  for select to authenticated
  using (
    public.company_can_edit(company_id)
    or (
      public.company_role(company_id) = 'driver'
      and public.checklist_item_access(item_key) in ('equipment', 'binder')
      and public.checklist_driver_truck(truck_id)
    )
  );

drop policy if exists company_checklist_status_insert on public.company_checklist_status;
create policy company_checklist_status_insert on public.company_checklist_status
  for insert to authenticated
  with check (
    public.company_can_edit(company_id)
    or (
      public.company_role(company_id) = 'driver'
      and public.checklist_item_access(item_key) = 'equipment'
      and public.checklist_driver_truck(truck_id)
    )
  );

drop policy if exists company_checklist_status_update on public.company_checklist_status;
create policy company_checklist_status_update on public.company_checklist_status
  for update to authenticated
  using (
    public.company_can_edit(company_id)
    or (
      public.company_role(company_id) = 'driver'
      and public.checklist_item_access(item_key) = 'equipment'
      and public.checklist_driver_truck(truck_id)
    )
  )
  with check (
    public.company_can_edit(company_id)
    or (
      public.company_role(company_id) = 'driver'
      and public.checklist_item_access(item_key) = 'equipment'
      and public.checklist_driver_truck(truck_id)
    )
  );

drop policy if exists company_checklist_status_delete on public.company_checklist_status;
create policy company_checklist_status_delete on public.company_checklist_status
  for delete to authenticated
  using (public.company_can_edit(company_id));

grant select, insert, update, delete on public.company_checklist_status to authenticated;
