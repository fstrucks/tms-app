-- Stop "Arrived" step + stop delays (Oct 22). Not applied: review, then apply. Idempotent; no data changes.
begin;

-- 1. Arrived at shipper / receiver. Optional; the app never changes the load status for it.
alter table public.stops add column if not exists arrived_at timestamptz null;
alter table public.stops add column if not exists arrived_by uuid null references auth.users(id) on delete set null;

-- 2. Delays at a stop: one row per delay, several per stop. The app writes through the server (service role) after
--    the same access check as stop check-off; RLS below mirrors that rule for any direct access.
create table if not exists public.stop_delays (
  id uuid primary key default gen_random_uuid(),
  stop_id uuid not null references public.stops(id) on delete cascade,
  load_id uuid not null references public.loads(id) on delete cascade,
  owner_id uuid not null references auth.users(id) on delete cascade, -- = loads.user_id
  reason text not null check (reason in ('waiting_to_load', 'waiting_to_unload', 'facility_closed', 'breakdown', 'weather', 'traffic', 'other')),
  note text null check (note is null or length(note) <= 300),
  started_at timestamptz not null default now(),
  ended_at timestamptz null,
  created_by uuid null references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint stop_delays_end_after_start check (ended_at is null or ended_at >= started_at),
  constraint stop_delays_other_note check (reason <> 'other' or length(btrim(coalesce(note, ''))) > 0)
);
create index if not exists stop_delays_load_idx on public.stop_delays (load_id, started_at);
create index if not exists stop_delays_stop_idx on public.stop_delays (stop_id);

-- Keep load_id / owner_id consistent with the stop, and bump updated_at.
create or replace function public.stop_delays_guard()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_load uuid; v_owner uuid;
begin
  select s.load_id, l.user_id into v_load, v_owner from public.stops s join public.loads l on l.id = s.load_id where s.id = new.stop_id;
  if v_load is null then raise exception 'stop_not_found' using errcode = 'P0001'; end if;
  new.load_id := v_load; new.owner_id := v_owner;
  if tg_op = 'UPDATE' then new.created_at := old.created_at; new.created_by := old.created_by; end if;
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists stop_delays_guard on public.stop_delays;
create trigger stop_delays_guard before insert or update on public.stop_delays for each row execute function public.stop_delays_guard();

-- Access: owner / management / dispatcher of the load's company, or the load's assigned driver.
create or replace function public.can_access_stop_delays(p_load uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.loads l where l.id = p_load and (
    coalesce(public.packet_role(l.user_id) in ('owner', 'management', 'dispatcher'), false)
    or (l.assigned_driver_user_id is not null and l.assigned_driver_user_id = auth.uid())));
$$;
revoke all on function public.can_access_stop_delays(uuid) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on function public.can_access_stop_delays(uuid) from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'grant execute on function public.can_access_stop_delays(uuid) to authenticated'; end if;
end $$;

alter table public.stop_delays enable row level security;
revoke all on public.stop_delays from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on public.stop_delays from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant select, insert, delete on public.stop_delays to authenticated';
    execute 'grant update (reason, note, started_at, ended_at) on public.stop_delays to authenticated';
  end if;
end $$;
drop policy if exists stop_delays_select on public.stop_delays;
create policy stop_delays_select on public.stop_delays for select to authenticated using (public.can_access_stop_delays(load_id));
drop policy if exists stop_delays_insert on public.stop_delays;
create policy stop_delays_insert on public.stop_delays for insert to authenticated
  with check (public.can_access_stop_delays(load_id) and created_by = auth.uid());
drop policy if exists stop_delays_update on public.stop_delays;
create policy stop_delays_update on public.stop_delays for update to authenticated
  using (public.can_access_stop_delays(load_id)) with check (public.can_access_stop_delays(load_id));
drop policy if exists stop_delays_delete on public.stop_delays;
create policy stop_delays_delete on public.stop_delays for delete to authenticated using (public.can_access_stop_delays(load_id));

-- 3. Review nit on #127 (Sam): email_doc_company is only called from inside the security-definer helpers
--    can_see_email_doc and create_load_from_email_document (they run as the function owner), so signed-in users
--    don't need to call it directly. Skipped when #127's migration hasn't run yet.
do $$ begin
  if to_regprocedure('public.email_doc_company(uuid, uuid)') is not null and exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke execute on function public.email_doc_company(uuid, uuid) from authenticated';
  end if;
end $$;

commit;
