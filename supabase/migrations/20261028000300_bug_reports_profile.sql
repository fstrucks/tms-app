-- Bug reports: record which company a report was filed under. NOT APPLIED; for review.
-- Runs after 20261018000100_bug_reports.sql and does not change that file. Safe to run more than once.
--
-- profile_id: the reporter's current company when the report was saved. The /api/bug-reports route sets it
--   on the server, the same way the app picks the active company. The request body can't set it.
--   The owner list (app/lib/bugReportsAdmin.js) reads only rows with profile_id = the owner's company. So:
--     * a user in two companies: each report shows only to the owner of the company it was filed under;
--     * someone who joins later doesn't make their older reports (other company or none) visible;
--     * rows saved before this column existed (profile_id null) show to no owner. Only the reporter
--       (own-rows policy) and the team (dashboard, service role) see them.
--   on delete set null: deleting a company keeps the report but takes it out of every owner's list.
-- Insert policy: own row only, status must be 'new', and profile_id (if any) must be a company the caller
--   belongs to (company_role() is the existing security-definer helper). Users still can't UPDATE or DELETE.
-- Select policy (own rows only) is unchanged. Owners read through the server (service role), filtered as above.
-- Screenshots: no storage change. The owner view signs short-lived URLs on the server with the service role,
--   only for listed rows whose path is in the reporter's own <uid>/bug-reports/ folder.

alter table public.bug_reports
  add column if not exists profile_id uuid null references public.company_profiles(id) on delete set null;

create index if not exists bug_reports_profile_id_idx on public.bug_reports (profile_id, created_at desc);

drop policy if exists "bug_reports_insert_own" on public.bug_reports;
create policy "bug_reports_insert_own" on public.bug_reports
  for insert to authenticated
  with check (
    auth.uid() = user_id
    and status = 'new'
    and (profile_id is null or public.company_role(profile_id) is not null)
  );
