-- Follow-up to 20261125000100 (already applied in prod; that file is not edited).
-- Marc, Nov 25: ticking "delete my reviews too" deletes facility REVIEWS only.
-- Facility notes stay, with no name attached, exactly as account_deletion_apply already leaves them.
--
-- Change: create or replace public.account_deletion_apply_with_reviews with the same signature,
-- security definer, and pinned search_path. The only difference is that the facility_notes
-- selection and delete are removed. notes_deleted stays in the result (always 0), so the result shape is unchanged.
-- No table changes, no data changes. account_deletion_apply is not changed.
-- The revoke/grant is repeated below: public, anon and authenticated get nothing, and service_role may execute.
-- Idempotent: safe to run again. Not applied from the app: Sam reviews, Dakota applies.

begin;

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
  v_result jsonb;
  v_reviews integer := 0;
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
  end if;

  v_result := public.account_deletion_apply(p_user);

  if coalesce((v_result ->> 'cancelled')::boolean, false) or coalesce((v_result ->> 'already_applied')::boolean, false) then
    return v_result || jsonb_build_object('reviews_deleted', 0, 'notes_deleted', 0);
  end if;

  if cardinality(v_review_ids) > 0 then
    delete from public.facility_reviews where id = any(v_review_ids);
    get diagnostics v_reviews = row_count;
  end if;

  return v_result || jsonb_build_object('reviews_deleted', v_reviews, 'notes_deleted', 0);
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
