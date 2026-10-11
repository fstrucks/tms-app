-- Run after 20261010000200 (extraction_runs) and 20261010000250 (claim_extraction_slot).
-- Separate per-kind extraction quotas so receipt auto-fill never consumes the rate-confirmation quota.

alter table public.extraction_runs
  add column if not exists kind text not null default 'rate_confirmation';

-- Explicit backfill (the NOT NULL default already fills existing rows).
update public.extraction_runs set kind = 'rate_confirmation' where kind is null;

do $$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.extraction_runs'::regclass and conname = 'extraction_runs_kind_check') then
    alter table public.extraction_runs
      add constraint extraction_runs_kind_check check (kind in ('rate_confirmation', 'receipt'));
  end if;
end $$;

create index if not exists extraction_runs_user_kind_created_idx
  on public.extraction_runs (user_id, kind, created_at desc);

-- Drop the old 2-arg function; no overload is kept, because
-- rpc('claim_extraction_slot', { p_user, p_document }) (used unchanged by /api/extract)
-- would be ambiguous. With p_kind defaulting to 'rate_confirmation', that call resolves here.
drop function if exists public.claim_extraction_slot(uuid, uuid);

create or replace function public.claim_extraction_slot(p_user uuid, p_document uuid, p_kind text default 'rate_confirmation')
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_hour_limit int;
  v_day_limit int;
  v_hour int;
  v_day int;
  v_id uuid;
begin
  case p_kind
    when 'rate_confirmation' then v_hour_limit := 20; v_day_limit := 100;
    when 'receipt'           then v_hour_limit := 30; v_day_limit := 150;
    else raise exception 'unknown extraction kind: %', p_kind using errcode = '22023';
  end case;

  -- Per-user lock (same as before).
  perform pg_advisory_xact_lock(hashtext(p_user::text));

  select count(*) filter (where created_at > now() - interval '1 hour'),
         count(*)
    into v_hour, v_day
    from public.extraction_runs
   where user_id = p_user
     and kind = p_kind
     and created_at > now() - interval '1 day';

  if v_hour >= v_hour_limit or v_day >= v_day_limit then
    return null;
  end if;

  insert into public.extraction_runs (user_id, document_id, status, kind)
  values (p_user, p_document, 'started', p_kind)
  returning id into v_id;

  return v_id;
end;
$$;

revoke execute on function public.claim_extraction_slot(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.claim_extraction_slot(uuid, uuid, text) to service_role;

-- Ask PostgREST to pick up the new signature.
notify pgrst, 'reload schema';
