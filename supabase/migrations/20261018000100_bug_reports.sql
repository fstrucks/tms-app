-- Report a bug: tester submissions. NOT APPLIED YET (needs Marc's OK; apply via the usual reviewed path).
-- Who can see what:
--   * A signed-in user can INSERT only their own row (user_id = auth.uid()) and SELECT only their own rows.
--   * No UPDATE/DELETE for users. The team reads/triages everything in the Supabase dashboard
--     (service role bypasses RLS), e.g. Table Editor -> bug_reports, newest first.
-- Screenshots: no storage change. They go in the existing private "documents" bucket under
-- <uid>/bug-reports/..., which the existing documents_*_own policies already allow (own folder only).

create table if not exists public.bug_reports (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  user_email text check (char_length(user_email) <= 320),
  what_happened text not null check (char_length(btrim(what_happened)) between 1 and 4000),
  expected text check (char_length(expected) <= 4000),
  page_url text check (char_length(page_url) <= 2000),
  user_agent text check (char_length(user_agent) <= 1000),
  viewport text check (char_length(viewport) <= 40),
  screenshot_path text check (screenshot_path is null or screenshot_path like (user_id::text || '/bug-reports/%')),
  status text not null default 'new' check (status in ('new', 'seen', 'fixed', 'wont_fix')),
  created_at timestamptz not null default now()
);

create index if not exists bug_reports_created_at_idx on public.bug_reports (created_at desc);
create index if not exists bug_reports_user_id_idx on public.bug_reports (user_id);

alter table public.bug_reports enable row level security;

drop policy if exists "bug_reports_insert_own" on public.bug_reports;
create policy "bug_reports_insert_own" on public.bug_reports
  for insert to authenticated
  with check (auth.uid() = user_id);

drop policy if exists "bug_reports_select_own" on public.bug_reports;
create policy "bug_reports_select_own" on public.bug_reports
  for select to authenticated
  using (auth.uid() = user_id);

revoke all on public.bug_reports from anon;
revoke all on public.bug_reports from authenticated;
grant select, insert on public.bug_reports to authenticated;
