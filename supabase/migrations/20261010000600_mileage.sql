-- Run after 20261010000450 (and 0500 if present). Adds NO tables or columns. Safe to re-run.
--
-- mileage_entries RLS + grants; miles calculation/validation; loads.total_miles and
-- loads.rate_per_mile maintained by triggers (the single source of truth):
--   * a load WITH entries:    total_miles = sum(miles > 0), and manual edits are overwritten
--   * a load with NO entries: total_miles may be edited manually; deleting the last entry sets it to null
--   * rate_per_mile is always round(rate / total_miles, 2) and cannot be set directly
-- Limitation: mileage_entries.miles and loads.total_miles are INTEGER, so fractional miles are not stored.

-- ---------- RLS: replace ALL existing policies on mileage_entries ----------
alter table public.mileage_entries enable row level security;

do $$
declare
  p record;
begin
  for p in
    select policyname from pg_policies where schemaname = 'public' and tablename = 'mileage_entries'
  loop
    execute format('drop policy %I on public.mileage_entries', p.policyname);
  end loop;
end $$;

create policy "mileage_select_own" on public.mileage_entries
  for select to authenticated using (user_id = auth.uid());

create policy "mileage_insert_own" on public.mileage_entries
  for insert to authenticated
  with check (
    user_id = auth.uid()
    and (load_id is null or exists (select 1 from public.loads l where l.id = mileage_entries.load_id and l.user_id = auth.uid()))
  );

create policy "mileage_update_own" on public.mileage_entries
  for update to authenticated
  using (user_id = auth.uid())
  with check (
    user_id = auth.uid()
    and (load_id is null or exists (select 1 from public.loads l where l.id = mileage_entries.load_id and l.user_id = auth.uid()))
  );

create policy "mileage_delete_own" on public.mileage_entries
  for delete to authenticated using (user_id = auth.uid());

grant select, insert, update, delete on public.mileage_entries to authenticated;

-- ---------- mileage_entries: miles = end - start when odometers are given; validate ----------
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

-- ---------- loads: enforce total_miles from entries + always recompute rate_per_mile ----------
-- BEFORE trigger that only edits NEW (no extra UPDATE), so no recursion.
-- SECURITY DEFINER so the entry sum is complete regardless of the caller's RLS view.
create or replace function public.loads_compute_rate_per_mile()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sum numeric;
begin
  if tg_op = 'UPDATE' then
    select sum(m.miles)::numeric into v_sum
      from public.mileage_entries m
     where m.load_id = new.id and m.miles > 0;
    if v_sum is not null then
      new.total_miles := v_sum::int;  -- entries exist: they win over manual edits
    end if;
  end if;
  new.rate_per_mile := round((new.rate / nullif(new.total_miles, 0)::numeric)::numeric, 2);
  return new;
end;
$$;

drop trigger if exists loads_compute_rate_per_mile on public.loads;
create trigger loads_compute_rate_per_mile
  before insert or update on public.loads
  for each row execute function public.loads_compute_rate_per_mile();

-- ---------- mileage_entries -> recalc affected loads ----------
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

  -- Serialize concurrent recalculations of the same load(s).
  perform 1 from public.loads where id = any (v_ids) order by id for update;

  -- No entries left => null (and rate_per_mile null via the loads trigger).
  update public.loads l
     set total_miles = s.total
    from (
      select x.id, (select sum(m.miles)::numeric from public.mileage_entries m where m.load_id = x.id and m.miles > 0)::int as total
        from unnest(v_ids) as x(id)
    ) s
   where l.id = s.id
     and l.total_miles is distinct from s.total;
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

-- ---------- rate_per_mile is derived: no direct client updates ----------
-- Replaces the table-level UPDATE grant from 0400 with column grants for every column except
-- id, created_at and rate_per_mile. (The trigger recomputes rate_per_mile regardless.)
revoke update on public.loads from authenticated;
grant update (user_id, truck_id, status, broker_name, broker_load_number, rate, commodity, weight,
              equipment_type, special_instructions, total_miles, notes, updated_at)
  on public.loads to authenticated;

-- ---------- Backfill (only rows whose values change) ----------
update public.loads l
   set total_miles = s.total
  from (
    select load_id, sum(miles)::numeric::int as total
      from public.mileage_entries
     where load_id is not null and miles > 0
     group by load_id
  ) s
 where s.load_id = l.id
   and l.total_miles is distinct from s.total;

update public.loads
   set rate_per_mile = round((rate / nullif(total_miles, 0)::numeric)::numeric, 2)
 where rate_per_mile is distinct from round((rate / nullif(total_miles, 0)::numeric)::numeric, 2);
