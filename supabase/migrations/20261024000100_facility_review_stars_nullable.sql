-- Facility reviews: a shipper or receiver rating can be cleared.
-- Reuses public.facility_reviews.stars from 20261022190000. No new column.
-- When set, stars is still 1–4. Null means no rating. Existing rows are unchanged.
-- Not applied: review, then apply. Idempotent. No data changes.
--
-- RLS is unchanged. facility_reviews stays revoked from anon and authenticated, with no
-- client policies. The server writes the row after the same access check as other reviews.
begin;

alter table public.facility_reviews alter column stars drop not null;

-- Drop whatever the original column check was named, then install the nullable 1–4 check.
do $$
declare con name;
begin
  for con in
    select c.conname
    from pg_constraint c
    join pg_class rel on rel.oid = c.conrelid
    join pg_namespace nsp on nsp.oid = rel.relnamespace
    where nsp.nspname = 'public'
      and rel.relname = 'facility_reviews'
      and c.contype = 'c'
      and pg_get_constraintdef(c.oid) ilike '%stars%'
  loop
    execute format('alter table public.facility_reviews drop constraint %I', con);
  end loop;
end $$;

alter table public.facility_reviews drop constraint if exists facility_reviews_stars_check;

alter table public.facility_reviews
  add constraint facility_reviews_stars_check
  check (stars is null or stars between 1 and 4);

commit;
