-- Carrier packet PR A: company profile + roles. ADDITIVE ONLY (new tables, functions, policies).
-- Ownership: keyed by owner_id now. company_id is reserved for company accounts (#27); when that lands,
-- backfill company_id and swap the helper functions below; policies call only the helpers.
-- Sensitive values (EIN/TIN) are stored as AES-256-GCM ciphertext produced server-side with
-- PACKET_ENCRYPTION_KEY. Postgres never sees the plaintext or the key.

create table if not exists public.company_profiles (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  company_id uuid null, -- reserved for #27 (no FK yet; companies table does not exist)
  legal_name text,
  dba_name text,
  mc_number text,
  dot_number text,
  address_line1 text,
  address_line2 text,
  city text,
  state text,
  postal_code text,
  phone text,
  email text,
  signer_name text,
  signer_title text,
  ein_ciphertext text,       -- "v1:<iv>:<tag>:<data>" base64, AES-256-GCM
  ein_last4 text check (ein_last4 is null or ein_last4 ~ '^[0-9]{4}$'),
  enc_key_version smallint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint company_profiles_owner_unique unique (owner_id)
);

create table if not exists public.company_members (
  profile_id uuid not null references public.company_profiles(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('owner', 'dispatcher', 'management', 'driver')),
  created_at timestamptz not null default now(),
  primary key (profile_id, user_id)
);
create index if not exists company_members_user_idx on public.company_members(user_id);

-- Role helpers (security definer so policies don't recurse through company_members RLS).
create or replace function public.company_role(p_profile uuid)
returns text language sql stable security definer set search_path = public as $$
  select case
    when exists (select 1 from public.company_profiles p where p.id = p_profile and p.owner_id = auth.uid()) then 'owner'
    else (select m.role from public.company_members m where m.profile_id = p_profile and m.user_id = auth.uid())
  end;
$$;
create or replace function public.company_can_edit(p_profile uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(public.company_role(p_profile) in ('owner', 'dispatcher', 'management'), false);
$$;
-- Same set as edit today; kept separate so signing can be narrowed later without touching policies.
create or replace function public.company_can_sign(p_profile uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(public.company_role(p_profile) in ('owner', 'dispatcher', 'management'), false);
$$;

-- Owner automatically becomes an 'owner' member.
create or replace function public.company_profiles_add_owner()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.company_members(profile_id, user_id, role) values (new.id, new.owner_id, 'owner')
  on conflict do nothing;
  return new;
end $$;
drop trigger if exists company_profiles_add_owner on public.company_profiles;
create trigger company_profiles_add_owner after insert on public.company_profiles
  for each row execute function public.company_profiles_add_owner();

create or replace function public.company_profiles_touch()
returns trigger language plpgsql as $$
begin new.updated_at = now(); new.owner_id = old.owner_id; return new; end $$;
drop trigger if exists company_profiles_touch on public.company_profiles;
create trigger company_profiles_touch before update on public.company_profiles
  for each row execute function public.company_profiles_touch();

alter table public.company_profiles enable row level security;
alter table public.company_members enable row level security;

drop policy if exists company_profiles_select on public.company_profiles;
create policy company_profiles_select on public.company_profiles for select to authenticated
  using (public.company_role(id) is not null);
drop policy if exists company_profiles_insert on public.company_profiles;
create policy company_profiles_insert on public.company_profiles for insert to authenticated
  with check (owner_id = auth.uid());
drop policy if exists company_profiles_update on public.company_profiles;
create policy company_profiles_update on public.company_profiles for update to authenticated
  using (public.company_can_edit(id)) with check (public.company_can_edit(id));
drop policy if exists company_profiles_delete on public.company_profiles;
create policy company_profiles_delete on public.company_profiles for delete to authenticated
  using (owner_id = auth.uid());

drop policy if exists company_members_select on public.company_members;
create policy company_members_select on public.company_members for select to authenticated
  using (user_id = auth.uid() or public.company_role(profile_id) is not null);
-- Only the profile owner manages members.
drop policy if exists company_members_write on public.company_members;
create policy company_members_write on public.company_members for all to authenticated
  using (exists (select 1 from public.company_profiles p where p.id = profile_id and p.owner_id = auth.uid()))
  with check (exists (select 1 from public.company_profiles p where p.id = profile_id and p.owner_id = auth.uid()));
