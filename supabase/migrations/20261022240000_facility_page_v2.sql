-- Facility page v2 (stacked on #133 / #130). Not applied: review, then apply. Idempotent. No data changes: creates
-- two empty tables and two read functions; no existing row is inserted, updated or deleted.
--
-- 1. Average wait time: public.facility_wait_stats(facility) returns aggregates only (sample count + average
--    minutes on site, overall, by local hour of arrival and by weekday). Never stop / load / company / user ids.
--    Buckets (and the overall average) with fewer than 3 samples are hidden. Time on site = completed_at - arrived_at
--    for done pickup / delivery stops; negatives and anything over 24h are ignored. Local time uses the stop's
--    timezone, else the facility state's zone (us_state_tz), else UTC.
-- 2. Facility notes: lasting per-facility notes (check-in rules, lumper available…), separate from reviews.
--    Same privacy model as facility_reviews: RLS on, no client grants; the server writes after the role + content
--    checks; public reads only through public.facility_public_notes (id, body, date). Reports in
--    facility_note_reports (one per note per user), for moderation later.
begin;

-- #128 added this (live). Guard so this file also applies cleanly on a database without it.
alter table public.stops add column if not exists arrived_at timestamptz null;

-- 1. Wait time stats.
create or replace function public.facility_wait_stats(p_facility uuid)
returns table (kind text, bucket integer, samples integer, avg_minutes numeric)
language sql stable security definer set search_path = public as $$
  with w as (
    select extract(epoch from (s.completed_at - s.arrived_at)) / 60.0 as mins,
      (s.arrived_at at time zone coalesce(nullif(s.timezone, ''), public.us_state_tz(f.state), 'UTC')) as local_at
    from public.stops s join public.facilities f on f.id = s.facility_id
    where s.facility_id = p_facility and s.stop_type in ('pickup', 'delivery') and s.completion = 'done'
      and s.arrived_at is not null and s.completed_at is not null
      and s.completed_at >= s.arrived_at and s.completed_at - s.arrived_at <= interval '24 hours'
  ), b as (
    select 'all'::text as kind, 0 as bucket, mins from w
    union all select 'hour', extract(hour from local_at)::int, mins from w
    union all select 'dow', extract(dow from local_at)::int, mins from w
  )
  select b.kind, b.bucket, count(*)::int,
    case when count(*) >= 3 then round(avg(b.mins)::numeric, 0) else null end
  from b group by b.kind, b.bucket
  having b.kind = 'all' or count(*) >= 3
  order by 1, 2;
$$;

-- 2. Notes.
create table if not exists public.facility_notes (
  id uuid primary key default gen_random_uuid(),
  facility_id uuid not null references public.facilities(id) on delete cascade,
  author_id uuid not null references auth.users(id) on delete cascade, -- moderation only, never shown
  company_id uuid null,                                                -- moderation only, never shown
  body text not null check (length(btrim(body)) between 1 and 300),
  hidden boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists facility_notes_facility_idx on public.facility_notes (facility_id, created_at desc) where not hidden;
alter table public.facility_notes enable row level security;
revoke all on public.facility_notes from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on public.facility_notes from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'revoke all on public.facility_notes from authenticated'; end if;
end $$;

create table if not exists public.facility_note_reports (
  id uuid primary key default gen_random_uuid(),
  note_id uuid not null references public.facility_notes(id) on delete cascade,
  reporter_id uuid not null references auth.users(id) on delete cascade,
  reason text null check (reason is null or length(reason) <= 300),
  created_at timestamptz not null default now(),
  unique (note_id, reporter_id)
);
alter table public.facility_note_reports enable row level security;
revoke all on public.facility_note_reports from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on public.facility_note_reports from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'revoke all on public.facility_note_reports from authenticated'; end if;
end $$;

create or replace function public.facility_public_notes(p_facility uuid, p_limit integer default 50)
returns table (id uuid, body text, created_at timestamptz)
language sql stable security definer set search_path = public as $$
  select n.id, n.body, n.created_at from public.facility_notes n
  where n.facility_id = p_facility and not n.hidden
  order by n.created_at desc limit least(greatest(coalesce(p_limit, 50), 1), 200);
$$;

do $$ declare f text; begin
  foreach f in array array['public.facility_wait_stats(uuid)', 'public.facility_public_notes(uuid, integer)'] loop
    execute format('revoke all on function %s from public', f);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', f); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('grant execute on function %s to authenticated', f); end if;
  end loop;
end $$;

commit;
