-- Location sharing: deleting a load must never be blocked by its shares (Taylor QA, TEST-QA179J, Nov 18 2026).
-- DRAFT for Sam's review. NOT APPLIED. Replaces ONE function body (create or replace); no table, column, policy or grant
-- changes, and no data is touched. Copy: /workspace/powerhaul-docs/2026-11-18_location-shares-delete-fix_DRAFT.sql
--
-- Root cause: location_shares.load_id references loads(id) ON DELETE SET NULL. Deleting a load makes Postgres run
-- UPDATE location_shares SET load_id = NULL for every share tied to it. That UPDATE fires location_shares_guard_update;
-- it is not service_role (the owner's JWT is still the session's role), so a stopped share raised
-- location_share_already_stopped, and a live one raised location_share_not_allowed (load_id may not change).
-- The delete is a direct browser delete as the owner (lib/loadDelete.js), so there was no app-side place to detach first.
-- Fix: one narrow exception at the top of the guard (see the comment inside). Share history stays intact except load_id.

create or replace function public.location_shares_guard_update()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  is_sharer boolean := (auth.uid() is not null and auth.uid() = old.user_id);
  is_office boolean := public.location_is_office(old.company_id);
  stop_only boolean;
begin
  if public.location_is_service_role() then
    return new;
  end if;

  -- Load delete (FK location_shares.load_id ... on delete set null): the cascade UPDATE runs inside the caller's session, so
  -- auth.role() is still 'authenticated' and the checks below used to reject it (location_share_already_stopped /
  -- location_share_not_allowed), blocking the delete. Allow exactly that update: load_id goes from a value to NULL, the
  -- load row no longer exists, and every other column is unchanged. A client cannot use this to detach a share from a load
  -- that still exists, because then the load row is still there.
  if old.load_id is not null and new.load_id is null
     and not exists (select 1 from public.loads l where l.id = old.load_id)
     and (to_jsonb(new) - 'load_id') = (to_jsonb(old) - 'load_id') then
    return new;
  end if;

  if new.company_id is distinct from old.company_id
     or new.user_id is distinct from old.user_id
     or new.started_at is distinct from old.started_at
     or new.mode is distinct from old.mode
     or new.duration_hours is distinct from old.duration_hours
     or new.expires_at is distinct from old.expires_at
     or new.id is distinct from old.id
     or new.created_at is distinct from old.created_at then
    raise exception 'location_share_locked' using errcode = 'P0001';
  end if;

  if old.stopped_at is not null then
    raise exception 'location_share_already_stopped' using errcode = 'P0001';
  end if;

  -- Reminder only (sharer): last_reminded_at may change; everything else must stay the same.
  if new.stopped_at is null and new.stopped_reason is not distinct from old.stopped_reason
     and new.stopped_by is not distinct from old.stopped_by then
    if new.truck_id is distinct from old.truck_id
       or new.load_id is distinct from old.load_id
       or new.auto_stop_on_delivered is distinct from old.auto_stop_on_delivered then
      raise exception 'location_share_not_allowed' using errcode = 'P0001';
    end if;
    if new.last_reminded_at is distinct from old.last_reminded_at then
      if not is_sharer then
        raise exception 'location_share_not_allowed' using errcode = 'P0001';
      end if;
      return new;
    end if;
    return new;
  end if;

  -- Stop only: stopped_at / stopped_reason / stopped_by. last_reminded_at and other fields must not change.
  if new.last_reminded_at is distinct from old.last_reminded_at
     or new.truck_id is distinct from old.truck_id
     or new.load_id is distinct from old.load_id
     or new.auto_stop_on_delivered is distinct from old.auto_stop_on_delivered then
    raise exception 'location_share_not_allowed' using errcode = 'P0001';
  end if;

  if new.stopped_at is null then
    raise exception 'location_share_not_allowed' using errcode = 'P0001';
  end if;
  if new.stopped_at < now() - interval '60 seconds' or new.stopped_at > now() + interval '60 seconds' then
    raise exception 'location_share_stop_time' using errcode = 'P0001';
  end if;

  if is_sharer then
    if new.stopped_reason is null or new.stopped_reason not in ('user', 'delivered') then
      raise exception 'location_share_stop_reason' using errcode = 'P0001';
    end if;
    if new.stopped_by is not null and new.stopped_by is distinct from auth.uid() then
      raise exception 'location_share_stop_by' using errcode = 'P0001';
    end if;
    return new;
  end if;

  if is_office then
    if new.stopped_reason = 'office' then
      if new.stopped_by is distinct from auth.uid() then
        raise exception 'location_share_stop_by' using errcode = 'P0001';
      end if;
      return new;
    end if;
    -- Office (or a dispatcher marking the load delivered through a user token) may end a share
    -- tied to that load when auto_stop_on_delivered is on. The production path uses service_role
    -- (exempt above) from POST /api/loads/:id/stops/:stopId.
    if new.stopped_reason = 'delivered' and old.auto_stop_on_delivered and old.load_id is not null then
      if new.stopped_by is not null and new.stopped_by is distinct from auth.uid() then
        raise exception 'location_share_stop_by' using errcode = 'P0001';
      end if;
      return new;
    end if;
    raise exception 'location_share_stop_reason' using errcode = 'P0001';
  end if;

  raise exception 'location_share_not_allowed' using errcode = 'P0001';
end;
$$;
