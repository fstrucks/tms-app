-- Facility rating prompts (Nov 2, plan: powerhaul-docs/facility-rating-prompt-plan.md, Sam GO with review fixes).
-- NOT APPLIED: review, then apply after QA. ADDITIVE ONLY: 2 new tables, their indexes, RLS and grants.
-- No existing table, column, function, policy or grant changes. No data changes. Idempotent (safe to run twice).
--
-- facility_rating_prompts: one row per (user, stop, kind) when the assigned driver (or the owner on his own load with
--   no assigned driver) marks a pickup / delivery done at a known facility. Drives the one next-day reminder card.
--     status: pending   prompt shown after the mark, not answered
--             skipped   "Skip" on that prompt (reminder still due at remind_at)
--             reminded  the reminder card was shown (it stays for the rest of that day in `timezone`, then never again)
--             rated     a review was saved for the stop
--             dismissed closed for good ("Skip" on the reminder, or "Don't ask about this facility again")
--   remind_at = 9:00 the next day in the stop's timezone (fallback America/Chicago); computed by the server.
--   timezone  = the zone used for remind_at and for "today" when the card was shown.
-- facility_rating_mutes: "Don't ask about this facility again" per user and facility (also hides the first prompt).
--
-- Access: users can READ only their own rows (RLS user_id = auth.uid()). No client insert / update / delete: every
-- write goes through the server with the service role after the stop check-off access check. No functions, so no
-- security definer and no search_path concerns.
begin;

create table if not exists public.facility_rating_prompts (
  id uuid primary key default gen_random_uuid(),
  company_id uuid null,
  user_id uuid not null references auth.users(id) on delete cascade,
  load_id uuid not null references public.loads(id) on delete cascade,
  stop_id uuid not null references public.stops(id) on delete cascade,
  facility_id uuid not null references public.facilities(id) on delete cascade,
  kind text not null,
  status text not null default 'pending',
  timezone text not null default 'America/Chicago',
  remind_at timestamptz not null,
  reminded_at timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint facility_rating_prompts_kind_check check (kind in ('pickup', 'delivery')),
  constraint facility_rating_prompts_status_check check (status in ('pending', 'skipped', 'reminded', 'rated', 'dismissed')),
  constraint facility_rating_prompts_tz_len check (char_length(timezone) between 1 and 64),
  constraint facility_rating_prompts_once unique (user_id, stop_id, kind)
);
-- Due / same-day cards for one user (the only list query).
create index if not exists facility_rating_prompts_due_idx
  on public.facility_rating_prompts (user_id, remind_at) where status in ('pending', 'skipped', 'reminded');
-- Mute a facility: close every open row for it.
create index if not exists facility_rating_prompts_facility_idx on public.facility_rating_prompts (user_id, facility_id);
create index if not exists facility_rating_prompts_load_idx on public.facility_rating_prompts (load_id);

create table if not exists public.facility_rating_mutes (
  id uuid not null default gen_random_uuid() unique, -- stable paging key for the company export
  user_id uuid not null references auth.users(id) on delete cascade,
  facility_id uuid not null references public.facilities(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, facility_id)
);

alter table public.facility_rating_prompts enable row level security;
alter table public.facility_rating_mutes enable row level security;

revoke all on public.facility_rating_prompts from public;
revoke all on public.facility_rating_mutes from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on public.facility_rating_prompts from anon';
    execute 'revoke all on public.facility_rating_mutes from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on public.facility_rating_prompts from authenticated';
    execute 'revoke all on public.facility_rating_mutes from authenticated';
    execute 'grant select on public.facility_rating_prompts to authenticated';
    execute 'grant select on public.facility_rating_mutes to authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant select, insert, update, delete on public.facility_rating_prompts to service_role';
    execute 'grant select, insert, update, delete on public.facility_rating_mutes to service_role';
  end if;
end $$;

drop policy if exists facility_rating_prompts_select_own on public.facility_rating_prompts;
create policy facility_rating_prompts_select_own on public.facility_rating_prompts
  for select to authenticated using (user_id = auth.uid());
drop policy if exists facility_rating_mutes_select_own on public.facility_rating_mutes;
create policy facility_rating_mutes_select_own on public.facility_rating_mutes
  for select to authenticated using (user_id = auth.uid());

commit;
