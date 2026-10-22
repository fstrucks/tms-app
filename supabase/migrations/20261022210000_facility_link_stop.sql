-- Facility reviews follow-up (PR #130): link a completed stop to a facility on demand.
-- Older stops (e.g. from rate cons) the trigger/backfill couldn't match (no street address) stay unlinked, so the
-- review prompt never showed. The app calls this (service role only) when a driver saves a review for such a stop.
-- Uses the normal facility_key when possible; otherwise a looser key from name + city/state/ZIP (street blank).
-- Returns the facility id, or null when the stop still lacks a name or a city/ZIP. No other data changes.
create or replace function public.facility_link_stop(p_stop uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare s public.stops%rowtype; v_key text; v_id uuid;
begin
  select * into s from public.stops where id = p_stop;
  if not found or s.stop_type not in ('pickup', 'delivery') then return null; end if;
  if s.facility_id is not null then return s.facility_id; end if;
  v_key := public.facility_key(s.company_name, s.address_line1, s.city, s.state, s.zip);
  if v_key is null then
    if public.facility_norm(s.company_name) = '' or (public.facility_norm(s.city) = '' and regexp_replace(coalesce(s.zip, ''), '[^0-9]', '', 'g') = '') then
      return null;
    end if;
    v_key := concat_ws('|', public.facility_norm(s.company_name), '', public.facility_norm(s.city),
      public.facility_norm(s.state), left(regexp_replace(coalesce(s.zip, ''), '[^0-9]', '', 'g'), 5));
  end if;
  insert into public.facilities (key, name, address_line1, city, state, zip)
    values (v_key, btrim(s.company_name), nullif(btrim(coalesce(s.address_line1, '')), ''), nullif(btrim(coalesce(s.city, '')), ''),
      nullif(upper(btrim(coalesce(s.state, ''))), ''), nullif(left(btrim(coalesce(s.zip, '')), 10), ''))
    on conflict (key) do nothing;
  select f.id into v_id from public.facilities f where f.key = v_key;
  update public.stops set facility_id = v_id where id = p_stop and facility_id is null;
  return v_id;
end $$;

revoke all on function public.facility_link_stop(uuid) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on function public.facility_link_stop(uuid) from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'revoke all on function public.facility_link_stop(uuid) from authenticated'; end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then execute 'grant execute on function public.facility_link_stop(uuid) to service_role'; end if;
end $$;
