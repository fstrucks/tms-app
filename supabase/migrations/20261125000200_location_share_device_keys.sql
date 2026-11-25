-- Location sharing: share-only sending keys for the phone app (Nov 25 2026). ADDITIVE ONLY, idempotent. NOT APPLIED.
-- Sam reviews, then Dakota applies. Do not run this against production from a preview or a script.
-- Depends on 20261117000100_location_shares.sql (public.location_shares) and auth.users / public.company_profiles.
--
-- One new table. Nothing existing is altered or dropped.
-- A key lets the phone app add points to ONE live share while the app is in the background, without the user's
-- sign-in token (which stops renewing in the background). Only a SHA-256 hex hash of the key is stored; the plain key
-- is shown to the phone once. The API (service role) is the only reader/writer: RLS is on with NO policies, and
-- anon/authenticated have no grants, so signed-in users cannot read hashes through the REST API.
-- Keys stop working when the share ends, when a new key is issued for the share (old one revoked), or at expires_at
-- (the share's end, capped at 7 days). The daily cron deletes keys revoked or expired more than 7 days ago.
-- Safe to re-run.

create table if not exists public.location_share_device_keys (
  id uuid primary key default gen_random_uuid(),
  share_id uuid not null references public.location_shares(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  company_id uuid not null references public.company_profiles(id) on delete cascade,
  key_hash text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz null,
  last_used_at timestamptz null,
  constraint location_share_device_keys_hash_check check (key_hash ~ '^[0-9a-f]{64}$'),
  constraint location_share_device_keys_expiry_check check (expires_at > created_at)
);

create unique index if not exists location_share_device_keys_hash_key
  on public.location_share_device_keys (key_hash);
-- At most one working key per share.
create unique index if not exists location_share_device_keys_one_live
  on public.location_share_device_keys (share_id) where revoked_at is null;
create index if not exists location_share_device_keys_share_idx
  on public.location_share_device_keys (share_id);

-- user_id / company_id always come from the share (a caller cannot point a key at another company).
create or replace function public.location_share_device_keys_fill_from_share()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  s public.location_shares;
begin
  select * into s from public.location_shares where id = new.share_id;
  if not found then
    raise exception 'location_device_key_no_share' using errcode = 'P0001';
  end if;
  new.user_id := s.user_id;
  new.company_id := s.company_id;
  return new;
end;
$$;

drop trigger if exists location_share_device_keys_fill_from_share on public.location_share_device_keys;
create trigger location_share_device_keys_fill_from_share
  before insert on public.location_share_device_keys
  for each row execute function public.location_share_device_keys_fill_from_share();

revoke execute on function public.location_share_device_keys_fill_from_share() from public, anon, authenticated;

alter table public.location_share_device_keys enable row level security;
revoke all on table public.location_share_device_keys from public, anon, authenticated;
grant select, insert, update, delete on table public.location_share_device_keys to service_role;
