-- Public reviews: show whether the visit was a pickup or a dropoff.
-- Reuses public.stops.stop_type. No new column. created_at is already returned and is the date.
-- Null stars stay null. They are not turned into 0. Names, companies, stop ids and load ids stay out.
-- Replaces public.facility_public_reviews from 20261022190000. The return row gains stop_type,
-- so the function is dropped and recreated (create or replace cannot change a return type) and the
-- existing execute grant is put back. Not applied: review, then apply. Idempotent. No data changes.
-- Apply after 20261024000100. Independent of the summary function in 20261024000200.
begin;

drop function if exists public.facility_public_reviews(uuid, integer);

create function public.facility_public_reviews(p_facility uuid, p_limit integer default 50)
returns table (
  id uuid,
  stars smallint,
  better_note text,
  need_to_know text,
  created_at timestamptz,
  updated_at timestamptz,
  stop_type text
)
language sql stable security definer set search_path = public as $$
  select r.id, r.stars, r.better_note, r.need_to_know, r.created_at, r.updated_at,
    case when s.stop_type in ('pickup', 'delivery') then s.stop_type else null end
  from public.facility_reviews r
  left join public.stops s on s.id = r.stop_id
  where r.facility_id = p_facility and not r.hidden
  order by r.created_at desc
  limit least(greatest(coalesce(p_limit, 50), 1), 200);
$$;

revoke all on function public.facility_public_reviews(uuid, integer) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function public.facility_public_reviews(uuid, integer) from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function public.facility_public_reviews(uuid, integer) to authenticated';
  end if;
end $$;

commit;
