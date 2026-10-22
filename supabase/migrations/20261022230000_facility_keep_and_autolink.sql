-- Facility directory follow-up (stacked on PR #130). Marc-approved Oct 22, 2026. Idempotent.
-- 1. Reviews survive load / stop deletion: facility_reviews.stop_id becomes nullable, FK on delete set null.
-- 2. Every pickup / delivery stop is saved to the facility directory on insert, even without a street address
--    (loose key: name + city/state/ZIP). When company_name is empty and address_line1 has no digits, address_line1
--    is treated as the facility name (e.g. 'Acme Dock').
-- 3. A stop with a street address for a place already saved under the loose key links to that facility (and fills
--    its address_line1 if empty) instead of creating a duplicate.
-- 4. ONE-TIME BACKFILL (CHANGES DATA): links existing unlinked pickup/delivery stops; may insert facilities rows.
--    Only sets stops.facility_id where it is null. Never deletes anything.
begin;

-- 1. Keep reviews when their stop (or load) is deleted.
alter table public.facility_reviews alter column stop_id drop not null;
alter table public.facility_reviews drop constraint if exists facility_reviews_stop_id_fkey;
alter table public.facility_reviews add constraint facility_reviews_stop_id_fkey
  foreign key (stop_id) references public.stops(id) on delete set null;

-- 2. Effective facility name: company_name, else address_line1 when it has no digits (it's really a name).
create or replace function public.facility_stop_name(p_name text, p_line1 text)
returns text language sql immutable set search_path = public as $$
  select case when public.facility_norm(p_name) <> '' then btrim(p_name)
    when public.facility_norm(p_line1) <> '' and coalesce(p_line1, '') !~ '[0-9]' then btrim(p_line1)
    else null end;
$$;
-- Loose key: name | '' | city | state | zip5. Null without a name, or without both city and ZIP.
create or replace function public.facility_loose_key(p_name text, p_line1 text, p_city text, p_state text, p_zip text)
returns text language sql immutable set search_path = public as $$
  select case when public.facility_stop_name(p_name, p_line1) is null
      or (public.facility_norm(p_city) = '' and regexp_replace(coalesce(p_zip, ''), '[^0-9]', '', 'g') = '') then null
    else concat_ws('|', public.facility_norm(public.facility_stop_name(p_name, p_line1)), '', public.facility_norm(p_city),
      public.facility_norm(p_state), left(regexp_replace(coalesce(p_zip, ''), '[^0-9]', '', 'g'), 5)) end;
$$;

-- Find or create the facility for a stop's fields. Order (deterministic):
--   a) strict key exists → that facility;
--   b) else loose key exists → that facility (fill address_line1 if empty, when we have a real street);
--   c) else insert under the strict key if there is one, otherwise the loose key.
-- The strict key is only used when company_name itself is set (a name-only address_line1 isn't a street).
create or replace function public.facility_resolve(p_name text, p_line1 text, p_city text, p_state text, p_zip text)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_strict text; v_loose text; v_key text; v_id uuid; v_street text;
begin
  if public.facility_norm(p_name) <> '' then
    v_strict := public.facility_key(p_name, p_line1, p_city, p_state, p_zip);
  end if;
  v_loose := public.facility_loose_key(p_name, p_line1, p_city, p_state, p_zip);
  v_street := case when v_strict is not null then nullif(btrim(coalesce(p_line1, '')), '') end;
  if v_strict is not null then
    select f.id into v_id from public.facilities f where f.key = v_strict;
    if v_id is not null then return v_id; end if;
  end if;
  if v_loose is not null then
    select f.id into v_id from public.facilities f where f.key = v_loose;
    if v_id is not null then
      if v_street is not null then
        update public.facilities set address_line1 = v_street where id = v_id and address_line1 is null;
      end if;
      return v_id;
    end if;
  end if;
  v_key := coalesce(v_strict, v_loose);
  if v_key is null then return null; end if;
  insert into public.facilities (key, name, address_line1, city, state, zip)
    values (v_key, public.facility_stop_name(p_name, p_line1), v_street, nullif(btrim(coalesce(p_city, '')), ''),
      nullif(upper(btrim(coalesce(p_state, ''))), ''), nullif(left(btrim(coalesce(p_zip, '')), 10), ''))
    on conflict (key) do nothing;
  select f.id into v_id from public.facilities f where f.key = v_key;
  return v_id;
end $$;

-- Trigger: link on insert / address change, now with the loose fallback.
create or replace function public.stops_link_facility()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.stop_type not in ('pickup', 'delivery') then new.facility_id := null; return new; end if;
  new.facility_id := public.facility_resolve(new.company_name, new.address_line1, new.city, new.state, new.zip);
  return new;
exception when others then
  return new; -- never block saving a stop
end $$;
drop trigger if exists stops_link_facility on public.stops;
create trigger stops_link_facility before insert or update of company_name, address_line1, city, state, zip, stop_type on public.stops
  for each row execute function public.stops_link_facility();

-- On-demand link (review route) uses the same logic.
create or replace function public.facility_link_stop(p_stop uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare s public.stops%rowtype; v_id uuid;
begin
  select * into s from public.stops where id = p_stop;
  if not found or s.stop_type not in ('pickup', 'delivery') then return null; end if;
  if s.facility_id is not null then return s.facility_id; end if;
  v_id := public.facility_resolve(s.company_name, s.address_line1, s.city, s.state, s.zip);
  if v_id is null then return null; end if;
  update public.stops set facility_id = v_id where id = p_stop and facility_id is null;
  return v_id;
end $$;

revoke all on function public.facility_resolve(text, text, text, text, text) from public;
revoke all on function public.facility_link_stop(uuid) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function public.facility_resolve(text, text, text, text, text) from anon';
    execute 'revoke all on function public.facility_link_stop(uuid) from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on function public.facility_resolve(text, text, text, text, text) from authenticated';
    execute 'revoke all on function public.facility_link_stop(uuid) from authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.facility_link_stop(uuid) to service_role';
  end if;
end $$;

-- 4. One-time backfill (CHANGES DATA): link unlinked pickup/delivery stops. Updating only facility_id doesn't fire
--    the trigger (it's limited to the address columns). Re-running is a no-op for already-linked stops.
update public.stops s
  set facility_id = public.facility_resolve(s.company_name, s.address_line1, s.city, s.state, s.zip)
  where s.facility_id is null and s.stop_type in ('pickup', 'delivery')
    and public.facility_resolve(s.company_name, s.address_line1, s.city, s.state, s.zip) is not null;

commit;
