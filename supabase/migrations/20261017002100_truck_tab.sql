-- Truck tab (PROPOSED, NOT APPLIED). NEEDS SAM/MARC OK before it is run anywhere.
-- Additive only. Extends the EXISTING prod tables `trucks` and `trailers` (created outside this repo's
-- migrations; see docs/design/maintenance.md §2) instead of duplicating them. Field keys map to columns in
-- app/lib/truckFields.js (truck_number → trucks.unit_number, truck_plate → trucks.license_plate, ...).
-- RLS follows trucks/trailers: own rows, user_id = (select auth.uid()). Guarded so it is safe to re-run and
-- aborts clearly if trucks/trailers are missing.

do $$ begin
  if to_regclass('public.trucks') is null or to_regclass('public.trailers') is null then
    raise exception 'truck_tab: public.trucks / public.trailers not found. These are expected to exist in prod.';
  end if;
end $$;

-- 1. Empty (tare) weights + which trailer the truck pulls now.
alter table public.trucks   add column if not exists empty_weight_lb integer check (empty_weight_lb is null or empty_weight_lb between 0 and 100000);
alter table public.trailers add column if not exists empty_weight_lb integer check (empty_weight_lb is null or empty_weight_lb between 0 and 100000);
alter table public.trucks   add column if not exists current_trailer_id uuid references public.trailers(id) on delete set null;

-- 2. Drivers. One owner (user_id) can have many drivers; each driver is linked to the truck he drives.
create table if not exists public.drivers (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  name text not null check (length(btrim(name)) between 1 and 120),
  phone text,
  cdl_number text,
  cdl_state text check (cdl_state is null or cdl_state ~ '^[A-Z]{2}$'),
  cdl_expiry date,
  med_card_expiry date,
  truck_id uuid references public.trucks(id) on delete set null,
  auth_user_id uuid references auth.users(id) on delete set null, -- later: driver's own login (company member)
  active boolean not null default true,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists drivers_user_idx on public.drivers (user_id, active);
create unique index if not exists drivers_truck_active_uniq on public.drivers (truck_id) where truck_id is not null and active; -- one active driver per truck (team drivers: open question)

-- 3. Scale tickets (weight history). One row per ticket; may link the scanned document and a load.
create table if not exists public.scale_tickets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  truck_id uuid not null references public.trucks(id) on delete cascade,
  trailer_id uuid references public.trailers(id) on delete set null,
  document_id uuid references public.documents(id) on delete set null,
  load_id uuid references public.loads(id) on delete set null,
  ticket_date date not null,
  gross_weight_lb integer not null check (gross_weight_lb between 1000 and 200000),
  steer_axle_lb integer, drive_axle_lb integer, trailer_axle_lb integer,
  scale_name text,
  source text not null default 'manual' check (source in ('manual', 'ai')),
  confirmed boolean not null default true, -- AI-read tickets start false until the user confirms
  created_at timestamptz not null default now()
);
create index if not exists scale_tickets_truck_idx on public.scale_tickets (user_id, truck_id, ticket_date desc, created_at desc);
create unique index if not exists scale_tickets_document_uniq on public.scale_tickets (document_id) where document_id is not null; -- re-scan of the same doc updates, never duplicates

-- 4. RLS: own rows, plus ownership checks on every referenced row (same shape as documents/load_id).
alter table public.drivers enable row level security;
alter table public.scale_tickets enable row level security;

drop policy if exists drivers_select_own on public.drivers;
create policy drivers_select_own on public.drivers for select to authenticated using (user_id = (select auth.uid()));
drop policy if exists drivers_insert_own on public.drivers;
create policy drivers_insert_own on public.drivers for insert to authenticated with check (
  user_id = (select auth.uid())
  and (truck_id is null or exists (select 1 from public.trucks t where t.id = truck_id and t.user_id = (select auth.uid()))));
drop policy if exists drivers_update_own on public.drivers;
create policy drivers_update_own on public.drivers for update to authenticated using (user_id = (select auth.uid())) with check (
  user_id = (select auth.uid())
  and (truck_id is null or exists (select 1 from public.trucks t where t.id = truck_id and t.user_id = (select auth.uid()))));
drop policy if exists drivers_delete_own on public.drivers;
create policy drivers_delete_own on public.drivers for delete to authenticated using (user_id = (select auth.uid()));

drop policy if exists scale_tickets_select_own on public.scale_tickets;
create policy scale_tickets_select_own on public.scale_tickets for select to authenticated using (user_id = (select auth.uid()));
drop policy if exists scale_tickets_insert_own on public.scale_tickets;
create policy scale_tickets_insert_own on public.scale_tickets for insert to authenticated with check (
  user_id = (select auth.uid())
  and exists (select 1 from public.trucks t where t.id = truck_id and t.user_id = (select auth.uid()))
  and (trailer_id is null or exists (select 1 from public.trailers r where r.id = trailer_id and r.user_id = (select auth.uid())))
  and (document_id is null or exists (select 1 from public.documents d where d.id = document_id and d.user_id = (select auth.uid())))
  and (load_id is null or exists (select 1 from public.loads l where l.id = load_id and l.user_id = (select auth.uid()))));
drop policy if exists scale_tickets_update_own on public.scale_tickets;
create policy scale_tickets_update_own on public.scale_tickets for update to authenticated using (user_id = (select auth.uid())) with check (
  user_id = (select auth.uid())
  and exists (select 1 from public.trucks t where t.id = truck_id and t.user_id = (select auth.uid()))
  and (trailer_id is null or exists (select 1 from public.trailers r where r.id = trailer_id and r.user_id = (select auth.uid())))
  and (document_id is null or exists (select 1 from public.documents d where d.id = document_id and d.user_id = (select auth.uid())))
  and (load_id is null or exists (select 1 from public.loads l where l.id = load_id and l.user_id = (select auth.uid()))));
drop policy if exists scale_tickets_delete_own on public.scale_tickets;
create policy scale_tickets_delete_own on public.scale_tickets for delete to authenticated using (user_id = (select auth.uid()));

grant select, insert, update, delete on public.drivers, public.scale_tickets to authenticated;
-- documents.doc_type is plain text (no check), so the new 'scale_ticket' type needs no SQL.
