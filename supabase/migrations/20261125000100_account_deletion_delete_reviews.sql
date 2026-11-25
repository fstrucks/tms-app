-- Optional "delete my reviews too" for account deletion (Marc, Nov 25). Not applied from the app.
-- Sam reviews, Dakota applies. Additive only: one new column with a default, one new function.
-- public.account_deletion_apply is NOT changed; the new function wraps it.
--
-- What it does, in plain English:
--   account_deletion_requests.delete_reviews (default false) records the person's choice.
--   Unticked (false): nothing changes. The app keeps calling account_deletion_apply, so reviews
--   and notes stay in the shared directory with no name attached, as today.
--   Ticked (true): the app calls account_deletion_apply_with_reviews instead. In ONE transaction it
--     1) picks the review and note ids to remove, while they still carry the author / company,
--     2) runs account_deletion_apply exactly as today,
--     3) deletes those ids, unless step 2 cancelled the deletion (signed in again) or had already
--        run. Any error in step 2 rolls back step 3 too.
--   Member: reviews and notes the person wrote (author_id = them).
--   Company owner: reviews and notes written for this company (company_id), by the owner, and by
--     teammates who lose their sign-in with the company.
--   Facilities stay. Report rows go with their review / note (existing on delete cascade).
--   Facility ratings are computed when read (facility_summaries), so they update at once.
--
-- Idempotent: add column if not exists, create or replace. Safe to run again. No data changes.
-- Rollback: stop calling the new function (the app then behaves as before). Dropping the column
-- or function is a separate decision.

begin;

alter table public.account_deletion_requests
  add column if not exists delete_reviews boolean not null default false;

create or replace function public.account_deletion_apply_with_reviews(p_user uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_request public.account_deletion_requests%rowtype;
  v_profile public.company_profiles%rowtype;
  v_has_profile boolean := false;
  v_authors uuid[] := array[]::uuid[];
  v_review_ids uuid[] := array[]::uuid[];
  v_note_ids uuid[] := array[]::uuid[];
  v_result jsonb;
  v_reviews integer := 0;
  v_notes integer := 0;
begin
  if p_user is null then raise exception 'missing_user'; end if;

  select * into v_request
    from public.account_deletion_requests
   where user_id = p_user and cancelled_at is null and completed_at is null
   order by requested_at desc
   limit 1;

  if v_request.id is not null and v_request.delete_reviews and v_request.applied_at is null then
    select * into v_profile from public.company_profiles where owner_id = p_user;
    v_has_profile := found;
    v_authors := array[p_user];
    if v_has_profile then
      -- Teammates who lose their sign-in with the company (same rule as account_deletion_apply).
      v_authors := v_authors || coalesce((
        select array_agg(m.user_id)
          from public.company_members m
         where m.profile_id = v_profile.id and m.user_id <> p_user
           and not exists (select 1 from public.company_members m2 where m2.user_id = m.user_id and m2.profile_id <> v_profile.id)
           and not exists (select 1 from public.company_profiles p2 where p2.owner_id = m.user_id and p2.id <> v_profile.id)
      ), array[]::uuid[]);
    end if;
    if to_regclass('public.facility_reviews') is not null then
      select coalesce(array_agg(r.id), array[]::uuid[]) into v_review_ids
        from public.facility_reviews r
       where r.author_id = any(v_authors) or (v_has_profile and r.company_id = v_profile.id);
    end if;
    if to_regclass('public.facility_notes') is not null then
      select coalesce(array_agg(n.id), array[]::uuid[]) into v_note_ids
        from public.facility_notes n
       where n.author_id = any(v_authors) or (v_has_profile and n.company_id = v_profile.id);
    end if;
  end if;

  v_result := public.account_deletion_apply(p_user);

  if coalesce((v_result ->> 'cancelled')::boolean, false) or coalesce((v_result ->> 'already_applied')::boolean, false) then
    return v_result || jsonb_build_object('reviews_deleted', 0, 'notes_deleted', 0);
  end if;

  if cardinality(v_review_ids) > 0 then
    delete from public.facility_reviews where id = any(v_review_ids);
    get diagnostics v_reviews = row_count;
  end if;
  if cardinality(v_note_ids) > 0 then
    delete from public.facility_notes where id = any(v_note_ids);
    get diagnostics v_notes = row_count;
  end if;

  return v_result || jsonb_build_object('reviews_deleted', v_reviews, 'notes_deleted', v_notes);
end
$fn$;

revoke all on function public.account_deletion_apply_with_reviews(uuid) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function public.account_deletion_apply_with_reviews(uuid) from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on function public.account_deletion_apply_with_reviews(uuid) from authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.account_deletion_apply_with_reviews(uuid) to service_role';
  end if;
end $$;

commit;
