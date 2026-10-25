-- Email rate cons linked to a deleted load must not return to Docs > Needs attention.
-- Adds documents.handled_at (nullable timestamptz). The only writer is
-- public.mark_load_email_ratecons_handled, called from deleteLoad before the load row
-- is removed and before documents.load_id is cleared. It stamps handled_at. It does
-- not delete a row, a storage file, or edit the load.
--
-- Same rule as emailRateconHandledOnLoadDelete in app/lib/handledRatecons.js:
--   load_id = that load, source = 'email', doc_type = 'rate_confirmation',
--   handled_at is null, and the document's user is the load owner or a member of
--   that owner's company. Other docs are not updated.
--
-- Grants (explicit):
--   SELECT: authenticated already has table-level SELECT on public.documents, so a
--   new column is readable with the row. This migration also grants SELECT (handled_at)
--   to authenticated. That is not an UPDATE grant.
--   INSERT and UPDATE stay the column lists from 20261010000200 (UPDATE load_id,
--   truck_id, doc_type) and 20261023000200 (INSERT service_record_id). handled_at is
--   not in those lists. Revoke below states it again for authenticated, anon, and public.
--   No new RLS policy on public.documents or storage.objects. Delete policies unchanged.
--   EXECUTE: revoked from public, anon, and service_role. Granted to authenticated only.
--
-- Idempotent: add column if not exists, create or replace, grants can be repeated.
-- No backfill. Rows already on file stay null.

begin;

alter table public.documents add column if not exists handled_at timestamptz;

comment on column public.documents.handled_at is
  'Set when the linked load is deleted, for email rate confirmations only. Keeps the file out of Docs Needs attention after load_id is cleared. Null means not handled.';

do $$ begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant select (handled_at) on public.documents to authenticated';
    execute 'revoke insert (handled_at), update (handled_at) on public.documents from authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke insert (handled_at), update (handled_at) on public.documents from anon';
  end if;
end $$;

revoke insert (handled_at), update (handled_at) on public.documents from public;

create or replace function public.mark_load_email_ratecons_handled(p_load uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner uuid;
  v_n integer := 0;
begin
  if auth.uid() is null or p_load is null then
    raise exception 'not_permitted' using errcode = '42501';
  end if;

  select l.user_id into v_owner
    from public.loads l
   where l.id = p_load;

  if v_owner is null then
    raise exception 'not_permitted' using errcode = '42501';
  end if;

  -- Load owner, or an office member of that company (owner / management / dispatcher).
  -- Drivers are not office. packet_role is security definer and does not recurse through RLS.
  if auth.uid() is distinct from v_owner
     and coalesce(public.packet_role(v_owner) in ('owner', 'management', 'dispatcher'), false) is not true
  then
    raise exception 'not_permitted' using errcode = '42501';
  end if;

  -- Do not update the load. Do not delete the document or its file.
  update public.documents d
     set handled_at = now()
   where d.load_id = p_load
     and d.source = 'email'
     and d.doc_type = 'rate_confirmation'
     and d.handled_at is null
     and (
       d.user_id = v_owner
       or exists (
         select 1
           from public.company_members m
           join public.company_profiles p on p.id = m.profile_id
          where p.owner_id = v_owner
            and m.user_id = d.user_id
       )
     );

  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

revoke all on function public.mark_load_email_ratecons_handled(uuid) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function public.mark_load_email_ratecons_handled(uuid) from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function public.mark_load_email_ratecons_handled(uuid) to authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'revoke all on function public.mark_load_email_ratecons_handled(uuid) from service_role';
  end if;
end $$;

commit;
