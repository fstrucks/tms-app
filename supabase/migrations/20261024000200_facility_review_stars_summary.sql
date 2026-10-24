-- Facility summaries: a cleared rating (null stars) is unrated.
-- It is left out of the average and the count. It is never treated as 0.
-- Example: stars 4, null, and 2 → average 3, count 2.
-- Replaces the body of public.facility_summaries from 20261022190000. Same signature, so
-- the existing execute grant is unchanged. No new policies. Not applied: review, then apply.
-- Idempotent. No data changes. Apply after 20261024000100.
begin;

create or replace function public.facility_summaries(p_ids uuid[])
returns table (facility_id uuid, name text, city text, state text, avg_stars numeric, review_count integer)
language sql stable security definer set search_path = public as $$
  select f.id, f.name, f.city, f.state,
    round(avg(r.stars) filter (where r.stars is not null)::numeric, 1),
    count(r.stars)::int
  from public.facilities f
  left join public.facility_reviews r on r.facility_id = f.id and not r.hidden
  where f.id = any(p_ids)
  group by f.id;
$$;

commit;
