-- Facility reviews, PR 1 (Marc-approved; platform-wide, anonymous). Not applied: review, then apply. Idempotent.
-- No data backfill here: existing stops get a facility the next time they're saved, or by the optional backfill in
-- the PR description.
--
-- Privacy model:
--   * facilities: shared directory (name + address only). Readable by any signed-in user.
--   * facility_reviews / facility_review_reports: NO client access at all (RLS on, no grants, no policies). The app
--     writes through the server after the access + content checks, and reads public data ONLY through the
--     security-definer functions below, which return stars, notes and dates, never author / company / load / rate /
--     broker. A user reads their own review through the server (filtered to author_id = caller).
--   * hidden = true (moderation, PR 2) is excluded from every public read.
begin;

-- 1. Normalized key: lowercased name + street line + city + state + 5-digit zip, punctuation removed, common street
--    words shortened. Same input → same facility for every company.
create or replace function public.facility_norm(p text)
returns text language sql immutable set search_path = public as $$
  select btrim(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(
    lower(coalesce(p, '')), '[^a-z0-9 ]+', ' ', 'g'),
    '\mstreet\M', 'st', 'g'), '\mavenue\M', 'ave', 'g'), '\mroad\M', 'rd', 'g'), '\mdrive\M', 'dr', 'g'),
    '\mboulevard\M', 'blvd', 'g'), '\mhighway\M', 'hwy', 'g'), '\s+', ' ', 'g'));
$$;
create or replace function public.facility_key(p_name text, p_line1 text, p_city text, p_state text, p_zip text)
returns text language sql immutable set search_path = public as $$
  select case when public.facility_norm(p_name) = '' or public.facility_norm(p_line1) = '' or (public.facility_norm(p_city) = '' and coalesce(p_zip, '') = '')
    then null
    else concat_ws('|', public.facility_norm(p_name), public.facility_norm(p_line1), public.facility_norm(p_city),
      public.facility_norm(p_state), left(regexp_replace(coalesce(p_zip, ''), '[^0-9]', '', 'g'), 5)) end;
$$;

-- 2. Directory.
create table if not exists public.facilities (
  id uuid primary key default gen_random_uuid(),
  key text not null unique,
  name text not null,
  address_line1 text null,
  city text null,
  state text null,
  zip text null,
  created_at timestamptz not null default now()
);
alter table public.facilities enable row level security;
revoke all on public.facilities from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on public.facilities from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'revoke all on public.facilities from authenticated'; execute 'grant select on public.facilities to authenticated'; end if;
end $$;
drop policy if exists facilities_select on public.facilities;
create policy facilities_select on public.facilities for select to authenticated using (true);

-- 3. Link stops on write (trigger). Pickups and deliveries only; a stop without a usable name + address stays unlinked.
alter table public.stops add column if not exists facility_id uuid null references public.facilities(id) on delete set null;
create index if not exists stops_facility_idx on public.stops (facility_id) where facility_id is not null;

create or replace function public.stops_link_facility()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_key text; v_id uuid;
begin
  if new.stop_type not in ('pickup', 'delivery') then new.facility_id := null; return new; end if;
  v_key := public.facility_key(new.company_name, new.address_line1, new.city, new.state, new.zip);
  if v_key is null then new.facility_id := null; return new; end if;
  insert into public.facilities (key, name, address_line1, city, state, zip)
    values (v_key, btrim(new.company_name), nullif(btrim(new.address_line1), ''), nullif(btrim(new.city), ''), nullif(upper(btrim(new.state)), ''), nullif(left(btrim(coalesce(new.zip, '')), 10), ''))
    on conflict (key) do nothing;
  select f.id into v_id from public.facilities f where f.key = v_key;
  new.facility_id := v_id;
  return new;
exception when others then
  return new; -- never block saving a stop
end $$;
drop trigger if exists stops_link_facility on public.stops;
create trigger stops_link_facility before insert or update of company_name, address_line1, city, state, zip, stop_type on public.stops
  for each row execute function public.stops_link_facility();

-- 4. Reviews. One per stop per user; editable. author_id / company_id are for moderation only.
create table if not exists public.facility_reviews (
  id uuid primary key default gen_random_uuid(),
  facility_id uuid not null references public.facilities(id) on delete cascade,
  stop_id uuid not null references public.stops(id) on delete cascade,
  author_id uuid not null references auth.users(id) on delete cascade,
  company_id uuid null,
  stars smallint not null check (stars between 1 and 4),
  better_note text null check (better_note is null or length(better_note) <= 500),
  need_to_know text null check (need_to_know is null or length(need_to_know) <= 500),
  hidden boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (stop_id, author_id)
);
create index if not exists facility_reviews_facility_idx on public.facility_reviews (facility_id, created_at desc) where not hidden;
alter table public.facility_reviews enable row level security;
revoke all on public.facility_reviews from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on public.facility_reviews from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'revoke all on public.facility_reviews from authenticated'; end if;
end $$;

create table if not exists public.facility_review_reports (
  id uuid primary key default gen_random_uuid(),
  review_id uuid not null references public.facility_reviews(id) on delete cascade,
  reporter_id uuid not null references auth.users(id) on delete cascade,
  reason text null check (reason is null or length(reason) <= 300),
  created_at timestamptz not null default now(),
  unique (review_id, reporter_id)
);
alter table public.facility_review_reports enable row level security;
revoke all on public.facility_review_reports from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on public.facility_review_reports from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'revoke all on public.facility_review_reports from authenticated'; end if;
end $$;

-- 5. Public reads (anonymous): summaries and reviews. Only these columns ever leave the database for other users.
create or replace function public.facility_summaries(p_ids uuid[])
returns table (facility_id uuid, name text, city text, state text, avg_stars numeric, review_count integer)
language sql stable security definer set search_path = public as $$
  select f.id, f.name, f.city, f.state,
    round(avg(r.stars)::numeric, 1), count(r.id)::int
  from public.facilities f left join public.facility_reviews r on r.facility_id = f.id and not r.hidden
  where f.id = any(p_ids) group by f.id;
$$;
create or replace function public.facility_public_reviews(p_facility uuid, p_limit integer default 50)
returns table (id uuid, stars smallint, better_note text, need_to_know text, created_at timestamptz, updated_at timestamptz)
language sql stable security definer set search_path = public as $$
  select r.id, r.stars, r.better_note, r.need_to_know, r.created_at, r.updated_at
  from public.facility_reviews r where r.facility_id = p_facility and not r.hidden
  order by r.created_at desc limit least(greatest(coalesce(p_limit, 50), 1), 200);
$$;
do $$ declare f text; begin
  foreach f in array array['public.facility_summaries(uuid[])', 'public.facility_public_reviews(uuid, integer)'] loop
    execute format('revoke all on function %s from public', f);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', f); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('grant execute on function %s to authenticated', f); end if;
  end loop;
end $$;

commit;
