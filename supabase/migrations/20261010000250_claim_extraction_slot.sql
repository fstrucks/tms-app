-- Run after 20261010000200 (needs public.extraction_runs).
-- Atomic per-user rate limit: 20/hour, 100/day. Returns the new run id, or null if over the limit.
create or replace function public.claim_extraction_slot(p_user uuid, p_document uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_hour int;
  v_day int;
  v_id uuid;
begin
  perform pg_advisory_xact_lock(hashtext(p_user::text));

  select count(*) filter (where created_at > now() - interval '1 hour'),
         count(*)
    into v_hour, v_day
    from public.extraction_runs
   where user_id = p_user
     and created_at > now() - interval '1 day';

  if v_hour >= 20 or v_day >= 100 then
    return null;
  end if;

  insert into public.extraction_runs (user_id, document_id, status)
  values (p_user, p_document, 'started')
  returning id into v_id;

  return v_id;
end;
$$;

revoke execute on function public.claim_extraction_slot(uuid, uuid) from public, anon, authenticated;
grant execute on function public.claim_extraction_slot(uuid, uuid) to service_role;
