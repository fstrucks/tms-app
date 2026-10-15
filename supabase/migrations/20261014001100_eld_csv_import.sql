-- ELD mileage CSV import (PR feat/eld-csv-import). Run after 20261010000600_mileage. Safe to re-run.
-- Adds nullable columns to mileage_entries (existing rows/forms unaffected) and a per-user
-- eld_import_mappings table for saved column mappings (e.g. "HOS247").

alter table public.mileage_entries
  add column if not exists jurisdiction text,
  add column if not exists truck_label text,
  add column if not exists fuel_gallons numeric(10,3),
  add column if not exists import_hash text,
  add column if not exists import_source text;

-- Duplicate prevention: one row per (user, normalized row hash). NULL hashes (manual entries)
-- never conflict. Non-partial so PostgREST upsert(on_conflict=user_id,import_hash) can use it.
create unique index if not exists mileage_entries_user_import_hash_key
  on public.mileage_entries (user_id, import_hash);

create index if not exists mileage_entries_user_jurisdiction_idx
  on public.mileage_entries (user_id, jurisdiction, entry_date) where jurisdiction is not null;

create table if not exists public.eld_import_mappings (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name text not null check (length(btrim(name)) between 1 and 60),
  mapping jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, name)
);

alter table public.eld_import_mappings enable row level security;
drop policy if exists "eld_mappings_select_own" on public.eld_import_mappings;
drop policy if exists "eld_mappings_insert_own" on public.eld_import_mappings;
drop policy if exists "eld_mappings_update_own" on public.eld_import_mappings;
drop policy if exists "eld_mappings_delete_own" on public.eld_import_mappings;
create policy "eld_mappings_select_own" on public.eld_import_mappings for select to authenticated using (user_id = auth.uid());
create policy "eld_mappings_insert_own" on public.eld_import_mappings for insert to authenticated with check (user_id = auth.uid());
create policy "eld_mappings_update_own" on public.eld_import_mappings for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "eld_mappings_delete_own" on public.eld_import_mappings for delete to authenticated using (user_id = auth.uid());
grant select, insert, update, delete on public.eld_import_mappings to authenticated;
