-- Run after 0050, 0000, 0100, 0200, 0250, 0300.
-- loads and stops already exist (schema from Marc). This migration adds NO tables or columns:
-- only RLS, grants, the documents.load_id FK, the documents update check and an updated_at trigger.

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

-- Stops are owned through their load.
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

-- documents.load_id -> loads.id (on delete set null), only if no FK on that column exists yet.
do $$
begin
  if not exists (
    select 1
      from pg_constraint c
      join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any (c.conkey)
     where c.conrelid = 'public.documents'::regclass
       and c.contype = 'f'
       and a.attname = 'load_id'
  ) then
    alter table public.documents
      add constraint documents_load_id_fkey foreign key (load_id) references public.loads (id) on delete set null;
  end if;
end $$;

-- documents.load_id may only be null or one of the user's own loads.
drop policy if exists "documents_update_own" on public.documents;
create policy "documents_update_own" on public.documents
  for update to authenticated
  using (user_id = auth.uid())
  with check (
    user_id = auth.uid()
    and (load_id is null or exists (select 1 from public.loads l where l.id = documents.load_id and l.user_id = auth.uid()))
  );

-- Keep loads.updated_at current.
create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists loads_set_updated_at on public.loads;
create trigger loads_set_updated_at
  before update on public.loads
  for each row execute function public.set_updated_at();
