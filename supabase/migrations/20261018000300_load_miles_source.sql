-- PR A, rate con miles (Marc approved Oct 18; Marc decided "I like seeing both": Planned and Actual miles). NOT APPLIED by this PR.
-- Run after 20261010000600_mileage.sql. Idempotent: safe to re-run.
--
-- 1. loads.miles_source: where the planned miles (loads.total_miles) came from: 'typed', 'rate_con' or
--    'calculated' (route miles, written by PR B; allowed now so PR B needs no change here).
--    Precedence is enforced by the app: typed > rate_con > calculated.
--    Nullable, no default, no backfill (existing loads keep their miles; the app infers a note for them).
-- 2. Logged miles become "actual" only: mileage_entries no longer overwrite loads.total_miles.
--    The 0600 rule "a load WITH entries: total_miles = sum(entries), manual edits are overwritten" is removed.
--    rate_per_mile is still always round(rate / total_miles, 2), now from the planned/typed miles.
--    Existing total_miles values are NOT changed.
-- Actual miles = sum of mileage_entries, computed by the app (no column needed).
-- To undo the logged-miles choice later, re-run 20261010000600_mileage.sql.

alter table public.loads add column if not exists miles_source text;
alter table public.loads drop constraint if exists loads_miles_source_check;
alter table public.loads add constraint loads_miles_source_check
  check (miles_source is null or miles_source in ('typed', 'rate_con', 'calculated'));

-- loads UPDATE is column-granted (0600); add the new column so the owner can set it.
grant update (miles_source) on public.loads to authenticated;

-- rate_per_mile only; no longer copies the mileage-log sum into total_miles.
create or replace function public.loads_compute_rate_per_mile()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.rate_per_mile := round((new.rate / nullif(new.total_miles, 0)::numeric)::numeric, 2);
  return new;
end;
$$;

drop trigger if exists loads_compute_rate_per_mile on public.loads;
create trigger loads_compute_rate_per_mile
  before insert or update on public.loads
  for each row execute function public.loads_compute_rate_per_mile();
revoke execute on function public.loads_compute_rate_per_mile() from public, anon, authenticated;

-- Adding, editing or deleting a mileage entry no longer rewrites loads.total_miles.
drop trigger if exists mileage_entries_recalc_load on public.mileage_entries;
drop function if exists public.mileage_entries_recalc_load();

notify pgrst, 'reload schema';
