-- On-screen compliance calendar: one row per company, rule, and period the user completed or dismissed.
-- Due dates are computed in the app, not stored. Office roles only (owner, dispatcher, management).
-- ADDITIVE ONLY. Do not apply from the app.

create table if not exists public.compliance_reminders_state (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.company_profiles(id) on delete cascade,
  rule_key text not null check (length(btrim(rule_key)) between 1 and 80),
  period text not null check (length(btrim(period)) between 1 and 120),
  truck_id uuid,
  status text not null check (status in ('completed', 'dismissed')),
  acted_by uuid not null default auth.uid() references auth.users(id),
  acted_at timestamptz not null default now()
);
create index if not exists compliance_reminders_company_idx on public.compliance_reminders_state (company_id, rule_key);
create unique index if not exists compliance_reminders_uniq on public.compliance_reminders_state (
  company_id,
  rule_key,
  period,
  coalesce(truck_id, '00000000-0000-0000-0000-000000000000'::uuid)
);

alter table public.compliance_reminders_state enable row level security;

-- acted_by defaults to auth.uid(). Insert and update must record the signed-in user.
-- Select and delete stay office-wide so a teammate can see a reminder someone else completed.
drop policy if exists compliance_reminders_all on public.compliance_reminders_state;
drop policy if exists compliance_reminders_select on public.compliance_reminders_state;
create policy compliance_reminders_select on public.compliance_reminders_state
  for select to authenticated
  using (public.company_can_edit(company_id));

drop policy if exists compliance_reminders_insert on public.compliance_reminders_state;
create policy compliance_reminders_insert on public.compliance_reminders_state
  for insert to authenticated
  with check (public.company_can_edit(company_id) and acted_by = auth.uid());

drop policy if exists compliance_reminders_update on public.compliance_reminders_state;
create policy compliance_reminders_update on public.compliance_reminders_state
  for update to authenticated
  using (public.company_can_edit(company_id))
  with check (public.company_can_edit(company_id) and acted_by = auth.uid());

drop policy if exists compliance_reminders_delete on public.compliance_reminders_state;
create policy compliance_reminders_delete on public.compliance_reminders_state
  for delete to authenticated
  using (public.company_can_edit(company_id));

grant select, insert, update, delete on public.compliance_reminders_state to authenticated;
