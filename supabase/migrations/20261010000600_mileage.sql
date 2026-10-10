-- Run after 20261010000450 (and 0500 if present). Adds NO tables or columns.
-- mileage_entries RLS + grants, a miles calculation/validation trigger, and automatic
-- loads.total_miles / loads.rate_per_mile maintenance. Safe to re-run.

-- ---------- RLS ----------
alter table public.mileage_entries enable row level security;

drop policy if exists "mileage_select_own" on public.mileage_entries;
create policy "mileage_select_own" on public.mileage_entries
  for select to authenticated using (user_id = auth.uid());

drop policy if exists "mileage_insert_own" on public.mileage_entries;
create policy "mileage_insert_own" on public.mileage_entries
  for insert to authenticated
  with check (
    user_id = auth.uid()
    and (load_id is null or exists (select 1 from public.loads l where l.id = mileage_entries.load_id and l.user_id = auth.uid()))
  );

drop policy if exists "mileage_update_own" on public.mileage_entries;
create policy "mileage_update_own" on public.mileage_entries
  for update to authenticated
  using (user_id = auth.uid())
  with check (
    user_id = auth.uid()
    and (load_id is null or exists (select 1 from public.loads l where l.id = mileage_entries.load_id and l.user_id = auth.uid()))
  );

drop policy if exists "mileage_delete_own" on public.mileage_entries;
create policy "mileage_delete_own" on public.mileage_entries
  for delete to authenticated using (user_id = auth.uid());

grant select, insert, update, delete on public.mileage_entries to authenticated;

-- ---------- miles = end - start when odometers are given; validate ----------
create or replace function public.mileage_entries_compute_miles()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.start_odometer is not null and new.end_odometer is not null then
    if new.end_odometer < new.start_odometer then
      raise exception 'end_odometer must be >= start_odometer' using errcode = '22023';
    end if;
    new.miles := new.end_odometer - new.start_odometer;
  end if;
  if new.miles is null or new.miles <= 0 then
    raise exception 'miles must be greater than 0' using errcode = '22023';
  end if;
  return new;
end;
$$;

drop trigger if exists mileage_entries_compute_miles on public.mileage_entries;
create trigger mileage_entries_compute_miles
  before insert or update on public.mileage_entries
  for each row execute function public.mileage_entries_compute_miles();

-- ---------- loads.rate_per_mile follows rate / total_miles ----------
-- BEFORE trigger that only edits NEW: no extra UPDATE, so no recursion.
create or replace function public.loads_compute_rate_per_mile()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.rate_per_mile := round(new.rate / nullif(new.total_miles, 0), 2);
  return new;
end;
$$;

drop trigger if exists loads_compute_rate_per_mile on public.loads;
create trigger loads_compute_rate_per_mile
  before insert or update of rate, total_miles on public.loads
  for each row execute function public.loads_compute_rate_per_mile();

-- ---------- recalc loads.total_miles from entries ----------
-- SECURITY DEFINER so the recalculation does not depend on the caller's grants; the entry itself
-- has already passed RLS (load must be the user's own). If a load has no entries left,
-- total_miles becomes null (and rate_per_mile null).
create or replace function public.mileage_entries_recalc_load()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ids uuid[];
begin
  if tg_op in ('UPDATE', 'DELETE') and old.load_id is not null then
    v_ids := array_append(v_ids, old.load_id);
  end if;
  if tg_op in ('INSERT', 'UPDATE') and new.load_id is not null then
    v_ids := array_append(v_ids, new.load_id);
  end if;
  if v_ids is null then
    return null;
  end if;

  update public.loads l
     set total_miles = (select sum(m.miles)::int from public.mileage_entries m where m.load_id = l.id)
   where l.id = any (v_ids)
     and l.total_miles is distinct from (select sum(m.miles)::int from public.mileage_entries m where m.load_id = l.id);
  -- rate_per_mile is set by loads_compute_rate_per_mile.
  return null;
end;
$$;

drop trigger if exists mileage_entries_recalc_load on public.mileage_entries;
create trigger mileage_entries_recalc_load
  after insert or update or delete on public.mileage_entries
  for each row execute function public.mileage_entries_recalc_load();

-- Trigger functions are not meant to be called directly.
revoke execute on function public.mileage_entries_compute_miles() from public, anon, authenticated;
revoke execute on function public.loads_compute_rate_per_mile() from public, anon, authenticated;
revoke execute on function public.mileage_entries_recalc_load() from public, anon, authenticated;

-- Backfill: bring existing loads in line.
update public.loads l
   set total_miles = s.total
  from (select load_id, sum(miles)::int as total from public.mileage_entries where load_id is not null group by load_id) s
 where s.load_id = l.id and l.total_miles is distinct from s.total;
update public.loads
   set rate_per_mile = round(rate / nullif(total_miles, 0), 2)
 where rate_per_mile is distinct from round(rate / nullif(total_miles, 0), 2);
