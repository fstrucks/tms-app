-- Run LAST (after 0050, 0000, 0100, 0200, 0250, 0300).
--
-- ASSUMPTION: the live loads/stops schema could not be read (no migrations/types in the repo and no
-- Supabase credentials available). This migration is defensive: it creates the tables if missing and
-- adds any missing columns the /loads pages use. Existing columns are never altered or dropped.
-- If an existing column has the same name but a different type (e.g. status as an enum, rate as text),
-- review before running.

create table if not exists public.loads (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  created_at timestamptz not null default now()
);
alter table public.loads add column if not exists user_id uuid default auth.uid() references auth.users on delete cascade;
alter table public.loads add column if not exists truck_id uuid;
alter table public.loads add column if not exists status text default 'booked';
alter table public.loads add column if not exists broker_name text;
alter table public.loads add column if not exists load_number text;
alter table public.loads add column if not exists reference_numbers text[];
alter table public.loads add column if not exists rate numeric(12,2);
alter table public.loads add column if not exists notes text;
alter table public.loads add column if not exists created_at timestamptz default now();

create table if not exists public.stops (
  id uuid primary key default gen_random_uuid(),
  load_id uuid not null references public.loads on delete cascade,
  created_at timestamptz not null default now()
);
alter table public.stops add column if not exists load_id uuid references public.loads on delete cascade;
alter table public.stops add column if not exists sequence int;
alter table public.stops add column if not exists stop_type text; -- 'pickup' | 'delivery'
alter table public.stops add column if not exists name text;
alter table public.stops add column if not exists address text;
alter table public.stops add column if not exists scheduled_date date;
alter table public.stops add column if not exists scheduled_time text;
alter table public.stops add column if not exists created_at timestamptz default now();
create index if not exists stops_load_seq_idx on public.stops (load_id, sequence);
create index if not exists loads_user_created_idx on public.loads (user_id, created_at desc);

-- documents.load_id -> loads.id (set null if the load is deleted), only if no FK exists yet.
do $$
begin
  if not exists (
    select 1 from pg_constraint c
    join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any (c.conkey)
    where c.conrelid = 'public.documents'::regclass and c.contype = 'f' and a.attname = 'load_id'
  ) then
    alter table public.documents
      add constraint documents_load_id_fkey foreign key (load_id) references public.loads on delete set null;
  end if;
end $$;

-- RLS: own rows only (same approach as documents).
alter table public.loads enable row level security;
alter table public.stops enable row level security;

drop policy if exists "loads_select_own" on public.loads;
create policy "loads_select_own" on public.loads for select to authenticated using (user_id = auth.uid());
drop policy if exists "loads_insert_own" on public.loads;
create policy "loads_insert_own" on public.loads for insert to authenticated with check (user_id = auth.uid());
drop policy if exists "loads_update_own" on public.loads;
create policy "loads_update_own" on public.loads for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists "loads_delete_own" on public.loads;
create policy "loads_delete_own" on public.loads for delete to authenticated using (user_id = auth.uid());

-- Stops are owned through their load (no user_id column needed on stops).
drop policy if exists "stops_select_own" on public.stops;
create policy "stops_select_own" on public.stops for select to authenticated
  using (exists (select 1 from public.loads l where l.id = stops.load_id and l.user_id = auth.uid()));
drop policy if exists "stops_insert_own" on public.stops;
create policy "stops_insert_own" on public.stops for insert to authenticated
  with check (exists (select 1 from public.loads l where l.id = stops.load_id and l.user_id = auth.uid()));
drop policy if exists "stops_update_own" on public.stops;
create policy "stops_update_own" on public.stops for update to authenticated
  using (exists (select 1 from public.loads l where l.id = stops.load_id and l.user_id = auth.uid()))
  with check (exists (select 1 from public.loads l where l.id = stops.load_id and l.user_id = auth.uid()));
drop policy if exists "stops_delete_own" on public.stops;
create policy "stops_delete_own" on public.stops for delete to authenticated
  using (exists (select 1 from public.loads l where l.id = stops.load_id and l.user_id = auth.uid()));

grant select, insert, update, delete on public.loads to authenticated;
grant select, insert, update, delete on public.stops to authenticated;

-- documents.load_id must point at the user's own load (update grant on load_id already exists from 0200).
drop policy if exists "documents_update_own" on public.documents;
create policy "documents_update_own" on public.documents
  for update to authenticated
  using (user_id = auth.uid())
  with check (
    user_id = auth.uid()
    and (load_id is null or exists (select 1 from public.loads l where l.id = documents.load_id and l.user_id = auth.uid()))
  );
