-- Account deletion for PowerHaul TMS. Not applied from the app. Sam reviews, Dakota applies.
-- Idempotent: create or replace, add column if not exists, drop and recreate constraints.
-- Safe to run again. It does not delete any existing row by itself. It only adds tables,
-- columns, and a function the server calls later.
--
-- What this is for, in plain English:
--   A person who is not the company owner can delete their own sign-in. The company's loads
--   and paperwork stay. Their name comes off. A dispatched load they were driving goes back
--   to booked when the driver is cleared. Files that are only theirs (bug-report screenshots
--   and uploads not tied to company work) are removed. Files tied to company work are moved
--   under the company owner's folder.
--   A company owner schedules deletion 14 days out. Signing in again cancels it, including
--   inside this function when auth.users.last_sign_in_at is later than the request baseline.
--   A demo company (company_profiles.is_demo, set by hand) is deleted right away. The name
--   is not used. A locked company, and the real owner company, cannot be deleted here.
--   When a company is deleted, its business records go away. Facilities and
--   facility reviews stay, detached from the company and the people. Email-send rows stay
--   so the monthly email count does not shrink, with the addresses removed.
--   People who belong only to that company lose their sign-in too. People who also belong
--   to another company, or who own one, keep their sign-in.
--   This function changes rows. It does not delete the sign-in itself. The server deletes
--   the auth user last, after files are cleaned up. Sessions go away with that sign-in.
--   There is no separate device table.
--
-- Rollback: do not drop company data. To remove this feature, stop calling the function
-- and leave the tables in place. Dropping them is a separate decision.

begin;

alter table public.company_profiles
  add column if not exists is_demo boolean not null default false;
alter table public.company_profiles
  add column if not exists deletion_locked boolean not null default false;

create table if not exists public.account_deletion_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  company_profile_id uuid null,
  kind text not null check (kind in ('member', 'company')),
  requested_at timestamptz not null default now(),
  purge_after timestamptz not null,
  baseline_sign_in_at timestamptz null,
  cancelled_at timestamptz null,
  cancel_reason text null check (cancel_reason is null or cancel_reason in ('signed_in', 'cancelled')),
  completed_at timestamptz null,
  applied_at timestamptz null,
  purge_auth_user_ids uuid[] null
);
create unique index if not exists account_deletion_requests_open_user
  on public.account_deletion_requests (user_id)
  where cancelled_at is null and completed_at is null;
create index if not exists account_deletion_requests_due_idx
  on public.account_deletion_requests (purge_after)
  where cancelled_at is null and completed_at is null;

create table if not exists public.account_deletion_storage_jobs (
  id uuid primary key default gen_random_uuid(),
  subject_user_id uuid not null,
  op text not null check (op in ('move', 'delete_path', 'delete_prefix')),
  from_path text not null,
  to_path text not null default '',
  created_at timestamptz not null default now(),
  done_at timestamptz null,
  unique (subject_user_id, op, from_path, to_path)
);
create index if not exists account_deletion_storage_jobs_open_idx
  on public.account_deletion_storage_jobs (subject_user_id)
  where done_at is null;

-- Survives the sign-in being removed. The label is what the app shows for that person.
create table if not exists public.former_members (
  former_user_id uuid primary key,
  company_owner_id uuid null,
  label text not null default 'Former team member',
  created_at timestamptz not null default now()
);

alter table public.account_deletion_requests enable row level security;
alter table public.account_deletion_storage_jobs enable row level security;
alter table public.former_members enable row level security;

revoke all on public.account_deletion_requests from public;
revoke all on public.account_deletion_storage_jobs from public;
revoke all on public.former_members from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on public.account_deletion_requests from anon';
    execute 'revoke all on public.account_deletion_storage_jobs from anon';
    execute 'revoke all on public.former_members from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on public.account_deletion_requests from authenticated';
    execute 'revoke all on public.account_deletion_storage_jobs from authenticated';
    execute 'revoke all on public.former_members from authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant select, insert, update, delete on public.account_deletion_requests to service_role';
    execute 'grant select, insert, update, delete on public.account_deletion_storage_jobs to service_role';
    execute 'grant select, insert, update, delete on public.former_members to service_role';
  end if;
end $$;

-- Point a foreign key at "on delete set null" and allow null, so removing a sign-in
-- does not remove the row we mean to keep. Used for reviews and for email-count rows.
create or replace function public.account_deletion_retarget_fk(
  p_table text, p_column text, p_ref text, p_on_delete text, p_nullable boolean
) returns void
language plpgsql
as $fk$
declare c name;
begin
  if to_regclass('public.' || p_table) is null then return; end if;
  if p_nullable then
    execute format('alter table public.%I alter column %I drop not null', p_table, p_column);
  end if;
  for c in
    select con.conname
      from pg_constraint con
      join pg_attribute a on a.attrelid = con.conrelid and a.attnum = any (con.conkey)
     where con.conrelid = format('public.%I', p_table)::regclass
       and con.contype = 'f'
       and a.attname = p_column
  loop
    execute format('alter table public.%I drop constraint %I', p_table, c);
  end loop;
  execute format(
    'alter table public.%I add constraint %I foreign key (%I) references %s on delete %s',
    p_table, p_table || '_' || p_column || '_fkey', p_column, p_ref, p_on_delete
  );
end
$fk$;

select public.account_deletion_retarget_fk('facility_reviews', 'author_id', 'auth.users(id)', 'set null', true);
select public.account_deletion_retarget_fk('facility_notes', 'author_id', 'auth.users(id)', 'set null', true);
select public.account_deletion_retarget_fk('facility_review_reports', 'reporter_id', 'auth.users(id)', 'set null', true);
select public.account_deletion_retarget_fk('facility_note_reports', 'reporter_id', 'auth.users(id)', 'set null', true);
select public.account_deletion_retarget_fk('load_packet_sends', 'owner_id', 'auth.users(id)', 'set null', true);
select public.account_deletion_retarget_fk('packet_sends', 'owner_id', 'auth.users(id)', 'set null', true);
select public.account_deletion_retarget_fk('packet_sends', 'packet_id', 'public.packets(id)', 'set null', true);
select public.account_deletion_retarget_fk('coi_requests', 'owner_id', 'auth.users(id)', 'set null', true);
select public.account_deletion_retarget_fk('coi_requests', 'packet_id', 'public.packets(id)', 'set null', true);
select public.account_deletion_retarget_fk('company_checklist_status', 'checked_by', 'auth.users(id)', 'set null', true);
select public.account_deletion_retarget_fk('compliance_reminders_state', 'acted_by', 'auth.users(id)', 'set null', true);
-- signed_by had no on-delete action, so removing a person who signed a profile blocked the auth delete.
select public.account_deletion_retarget_fk('company_profiles', 'signed_by', 'auth.users(id)', 'set null', true);

drop function if exists public.account_deletion_retarget_fk(text, text, text, text, boolean);

-- After the retargets above, no public foreign key to auth.users may still be NO ACTION or RESTRICT.
-- Those are the ones that make deleting a sign-in fail. Cascade and set null are left as they are.
-- Checked in this migration (repo): company_profiles.signed_by had no action (fixed above).
-- company_checklist_status.checked_by and compliance_reminders_state.acted_by had no action
-- (fixed above). Every other auth.users reference in supabase/migrations already cascades or sets null.
do $$
declare
  r record;
  v_list text := '';
begin
  for r in
    select n.nspname || '.' || c.relname || '.' || a.attname as col, con.conname as conname
      from pg_constraint con
      join pg_class c on c.oid = con.conrelid
      join pg_namespace n on n.oid = c.relnamespace
      join pg_attribute a on a.attrelid = con.conrelid and a.attnum = any (con.conkey)
      join pg_class cf on cf.oid = con.confrelid
      join pg_namespace nf on nf.oid = cf.relnamespace
     where con.contype = 'f'
       and n.nspname = 'public'
       and nf.nspname = 'auth'
       and cf.relname = 'users'
       and con.confdeltype in ('a', 'r')
  loop
    v_list := v_list || r.col || ' (' || r.conname || '); ';
  end loop;
  if v_list <> '' then
    raise exception 'account_deletion_blocking_fk: %', v_list;
  end if;
end $$;

create or replace function public.account_deletion_apply(p_user uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_profile public.company_profiles%rowtype;
  v_has_profile boolean := false;
  v_demo boolean := false;
  v_request public.account_deletion_requests%rowtype;
  v_primary uuid;
  v_ids uuid[] := array[]::uuid[];
  v_keep uuid[] := array[]::uuid[];
  v_member uuid;
  v_memberships integer := 0;
  v_signed timestamptz;
  v_to text;
  r record;
begin
  if p_user is null then raise exception 'missing_user'; end if;

  select * into v_request
    from public.account_deletion_requests
   where user_id = p_user and cancelled_at is null and completed_at is null
   order by requested_at desc
   limit 1;

  if v_request.id is not null and v_request.applied_at is not null then
    return jsonb_build_object(
      'already_applied', true,
      'auth_user_ids', coalesce(v_request.purge_auth_user_ids, array[p_user]),
      'jobs', coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', j.id, 'op', j.op, 'from_path', j.from_path, 'to_path', j.to_path, 'done_at', j.done_at
        ) order by j.created_at)
          from public.account_deletion_storage_jobs j
         where j.subject_user_id = p_user and j.done_at is null
      ), '[]'::jsonb)
    );
  end if;

  select * into v_profile from public.company_profiles where owner_id = p_user;
  v_has_profile := found;
  if v_has_profile then
    -- Hard stop for the real owner company, and for any company flagged deletion_locked.
    if v_profile.id = '155fd2a0-11a9-4a3c-8f58-7efab00a188b' or coalesce(v_profile.deletion_locked, false) then
      raise exception 'protected_company';
    end if;
    v_demo := coalesce(v_profile.is_demo, false);
    -- Grace cancel does not depend on the app. A later sign-in than the one that scheduled
    -- this request cancels it here, before any company row is removed.
    if not v_demo and v_request.id is not null and v_request.baseline_sign_in_at is not null then
      select u.last_sign_in_at into v_signed from auth.users u where u.id = p_user;
      if v_signed is not null and v_signed > v_request.baseline_sign_in_at then
        update public.account_deletion_requests
           set cancelled_at = now(), cancel_reason = 'signed_in'
         where id = v_request.id and cancelled_at is null and completed_at is null;
        return jsonb_build_object('cancelled', true, 'reason', 'signed_in');
      end if;
    end if;
    if not v_demo then
      if v_request.id is null then raise exception 'grace_required'; end if;
      if v_request.purge_after > now() then raise exception 'grace_period'; end if;
    end if;

    -- Who loses their sign-in: the owner, plus teammates who have no other company.
    v_ids := array[p_user];
    for v_member in
      select m.user_id from public.company_members m
       where m.profile_id = v_profile.id and m.user_id <> p_user
    loop
      if exists (select 1 from public.company_members m2 where m2.user_id = v_member and m2.profile_id <> v_profile.id)
         or exists (select 1 from public.company_profiles p2 where p2.owner_id = v_member and p2.id <> v_profile.id) then
        v_keep := v_keep || v_member;
      else
        v_ids := v_ids || v_member;
      end if;
    end loop;

    -- Email counts stay. Addresses and the link to the company come off.
    if to_regclass('public.load_packet_sends') is not null then
      update public.load_packet_sends
         set to_emails = array['redacted']::text[], note = null, postmark_message_id = null,
             sent_by = null, load_id = null, invoice_id = null, owner_id = null
       where owner_id = p_user;
    end if;
    if to_regclass('public.packet_sends') is not null then
      update public.packet_sends
         set to_emails = array['redacted']::text[], cc_emails = '{}', from_email = 'redacted',
             reply_to = null, subject = 'redacted', filled_path = 'redacted', postmark_message_id = null,
             sent_by = null, packet_id = null, owner_id = null
       where owner_id = p_user;
    end if;
    if to_regclass('public.coi_requests') is not null then
      update public.coi_requests
         set to_emails = array['redacted']::text[], cc_emails = '{}', from_email = 'redacted',
             reply_to = null, subject = 'redacted', cert_holder_name = null, cert_holder_address = null,
             postmark_message_id = null, sent_by = null, packet_id = null, owner_id = null
       where owner_id = p_user;
    end if;

    -- Facilities and reviews stay. They are no longer tied to this company or these people.
    if to_regclass('public.facility_reviews') is not null then
      update public.facility_reviews
         set author_id = null, company_id = null
       where author_id = any(v_ids) or company_id = v_profile.id;
    end if;
    if to_regclass('public.facility_notes') is not null then
      update public.facility_notes
         set author_id = null, company_id = null
       where author_id = any(v_ids) or company_id = v_profile.id;
    end if;
    if to_regclass('public.facility_review_reports') is not null then
      update public.facility_review_reports set reporter_id = null where reporter_id = any(v_ids);
    end if;
    if to_regclass('public.facility_note_reports') is not null then
      update public.facility_note_reports set reporter_id = null where reporter_id = any(v_ids);
    end if;

    -- Same limit as driver cards: a person who keeps their sign-in is cleared only on this
    -- company's loads (user_id = p_user). A person whose sign-in is removed is cleared everywhere.
    if to_regclass('public.loads') is not null then
      update public.loads l
         set assigned_driver_user_id = null,
             show_rate_to_driver = false,
             status = case when l.status = 'dispatched' then 'booked' else l.status end
       where l.assigned_driver_user_id = any(v_ids || v_keep)
         and (l.assigned_driver_user_id = any(v_ids) or l.user_id = p_user);
    end if;
    -- People who keep their sign-in are unlinked only on this company's driver cards.
    -- People whose sign-in is removed are unlinked everywhere, because that login is going away.
    if to_regclass('public.drivers') is not null then
      update public.drivers
         set auth_user_id = null
       where auth_user_id = any(v_ids)
          or (auth_user_id = any(v_keep) and user_id = p_user);
    end if;
    -- A person whose sign-in is removed may have signed another company's profile.
    update public.company_profiles set signed_by = null where signed_by = any(v_ids);
    -- checked_by / acted_by only for people whose sign-in is removed. People who keep a sign-in
    -- stay on the rows they completed, including at other companies.
    if to_regclass('public.company_checklist_status') is not null then
      update public.company_checklist_status set checked_by = null where checked_by = any(v_ids);
    end if;
    if to_regclass('public.compliance_reminders_state') is not null then
      update public.compliance_reminders_state set acted_by = null where acted_by = any(v_ids);
    end if;

    -- Company files that do not live in the owner's folder (a teammate who is keeping their sign-in,
    -- or a signature / logo stored under someone else's id). The owner's whole folder is removed below.
    -- to_jsonb so a column added in an earlier migration is used when it is present.
    if coalesce(to_jsonb(v_profile)->>'signature_path', '') <> ''
       and split_part(to_jsonb(v_profile)->>'signature_path', '/', 1) <> p_user::text then
      insert into public.account_deletion_storage_jobs (subject_user_id, op, from_path, to_path)
      values (p_user, 'delete_path', to_jsonb(v_profile)->>'signature_path', '')
      on conflict (subject_user_id, op, from_path, to_path) do nothing;
    end if;
    if coalesce(to_jsonb(v_profile)->>'logo_path', '') <> ''
       and split_part(to_jsonb(v_profile)->>'logo_path', '/', 1) <> p_user::text then
      insert into public.account_deletion_storage_jobs (subject_user_id, op, from_path, to_path)
      values (p_user, 'delete_path', to_jsonb(v_profile)->>'logo_path', '')
      on conflict (subject_user_id, op, from_path, to_path) do nothing;
    end if;
    if to_regclass('public.packets') is not null then
      for r in
        select file_path from public.packets where owner_id = p_user and file_path is not null
        union
        select filled_path from public.packets where owner_id = p_user and filled_path is not null
      loop
        if split_part(r.file_path, '/', 1) = any(select x::text from unnest(v_keep) as x) then
          insert into public.account_deletion_storage_jobs (subject_user_id, op, from_path, to_path)
          values (p_user, 'delete_path', r.file_path, '')
          on conflict (subject_user_id, op, from_path, to_path) do nothing;
        end if;
      end loop;
    end if;

    -- Files of people who are staying: remove only this company's copies, not their whole folder.
    if to_regclass('public.documents') is not null and to_regclass('public.loads') is not null then
      for r in
        select d.id, d.file_path
          from public.documents d
          join public.loads l on l.id = d.load_id
         where l.user_id = p_user and d.user_id = any(v_keep) and d.file_path is not null
      loop
        insert into public.account_deletion_storage_jobs (subject_user_id, op, from_path, to_path)
        values (p_user, 'delete_path', r.file_path, '')
        on conflict (subject_user_id, op, from_path, to_path) do nothing;
        delete from public.documents where id = r.id;
      end loop;
    end if;

    insert into public.former_members (former_user_id, company_owner_id, label)
    select x, p_user, 'Former team member' from unnest(v_ids) as x
    on conflict (former_user_id) do update set label = excluded.label;

    insert into public.account_deletion_storage_jobs (subject_user_id, op, from_path, to_path)
    select p_user, 'delete_prefix', x::text, '' from unnest(v_ids) as x
    on conflict (subject_user_id, op, from_path, to_path) do nothing;

    -- Owner profile removal cascades company rows that point at it or at the owner's id.
    if to_regclass('public.profiles') is not null then
      delete from public.profiles where id = any(v_ids);
    end if;
    delete from public.company_profiles where id = v_profile.id;
  else
    -- Member (or a sign-in with no company). Company records stay. Personal sign-in goes.
    -- More than one membership is refused: there is no safe single company to keep the rows with.
    select count(*) into v_memberships from public.company_members m where m.user_id = p_user;
    if v_memberships > 1 then raise exception 'multi_company_member'; end if;

    select p.owner_id into v_primary
      from public.company_members m
      join public.company_profiles p on p.id = m.profile_id
     where m.user_id = p_user and m.role <> 'owner' and p.owner_id <> p_user
     order by m.created_at
     limit 1;

    if to_regclass('public.loads') is not null then
      update public.loads l
         set assigned_driver_user_id = null,
             show_rate_to_driver = false,
             status = case when l.status = 'dispatched' then 'booked' else l.status end
       where l.assigned_driver_user_id = p_user;
      if v_primary is not null then
        update public.loads set user_id = v_primary where user_id = p_user;
      end if;
    end if;
    if to_regclass('public.drivers') is not null then
      update public.drivers set auth_user_id = null where auth_user_id = p_user;
      if v_primary is not null then
        update public.drivers set user_id = v_primary where user_id = p_user;
      end if;
    end if;
    update public.company_profiles set signed_by = null where signed_by = p_user;

    if v_primary is not null and to_regclass('public.expenses') is not null then
      update public.expenses e
         set user_id = coalesce((select l.user_id from public.loads l where l.id = e.load_id and l.user_id <> p_user), v_primary)
       where e.user_id = p_user;
    end if;
    if v_primary is not null and to_regclass('public.mileage_entries') is not null then
      update public.mileage_entries m
         set user_id = coalesce((select l.user_id from public.loads l where l.id = m.load_id and l.user_id <> p_user), v_primary)
       where m.user_id = p_user and coalesce(m.miles, 0) > 0;
    end if;
    if v_primary is not null and to_regclass('public.scale_tickets') is not null then
      update public.scale_tickets s
         set user_id = coalesce((select l.user_id from public.loads l where l.id = s.load_id and l.user_id <> p_user), v_primary)
       where s.user_id = p_user;
    end if;

    if to_regclass('public.documents') is not null then
      for r in
        select d.id, d.file_path,
               coalesce(
                 (select l.user_id from public.loads l where l.id = d.load_id and l.user_id <> p_user),
                 (select t.user_id from public.trucks t where t.id = d.truck_id and t.user_id <> p_user),
                 (select sr.owner_id from public.service_records sr where sr.id = d.service_record_id and sr.owner_id <> p_user),
                 (select e.user_id from public.expenses e where e.document_id = d.id and e.user_id <> p_user limit 1),
                 (select st.user_id from public.scale_tickets st where st.document_id = d.id and st.user_id <> p_user limit 1)
               ) as new_owner
          from public.documents d
         where d.user_id = p_user
      loop
        if r.new_owner is null then continue; end if;
        update public.documents set user_id = r.new_owner where id = r.id;
        if r.file_path like p_user::text || '/%' then
          v_to := r.new_owner::text || '/retained/' || p_user::text || '/' || substr(r.file_path, length(p_user::text) + 2);
          insert into public.account_deletion_storage_jobs (subject_user_id, op, from_path, to_path)
          values (p_user, 'move', r.file_path, v_to)
          on conflict (subject_user_id, op, from_path, to_path) do nothing;
          update public.documents set file_path = v_to where id = r.id;
        end if;
      end loop;
    end if;

    if to_regclass('public.packets') is not null then
      for r in
        select id, file_path, owner_id from public.packets
         where uploaded_by = p_user and file_path like p_user::text || '/%'
      loop
        v_to := r.owner_id::text || '/retained/' || p_user::text || '/' || substr(r.file_path, length(p_user::text) + 2);
        insert into public.account_deletion_storage_jobs (subject_user_id, op, from_path, to_path)
        values (p_user, 'move', r.file_path, v_to)
        on conflict (subject_user_id, op, from_path, to_path) do nothing;
        update public.packets set file_path = v_to, uploaded_by = null where id = r.id;
      end loop;
    end if;

    if to_regclass('public.facility_reviews') is not null then
      update public.facility_reviews set author_id = null, company_id = null where author_id = p_user;
    end if;
    if to_regclass('public.facility_notes') is not null then
      update public.facility_notes set author_id = null, company_id = null where author_id = p_user;
    end if;
    if to_regclass('public.facility_review_reports') is not null then
      update public.facility_review_reports set reporter_id = null where reporter_id = p_user;
    end if;
    if to_regclass('public.facility_note_reports') is not null then
      update public.facility_note_reports set reporter_id = null where reporter_id = p_user;
    end if;
    if to_regclass('public.company_checklist_status') is not null then
      update public.company_checklist_status set checked_by = null where checked_by = p_user;
    end if;
    if to_regclass('public.compliance_reminders_state') is not null then
      update public.compliance_reminders_state set acted_by = null where acted_by = p_user;
    end if;

    insert into public.former_members (former_user_id, company_owner_id, label)
    values (p_user, v_primary, 'Former team member')
    on conflict (former_user_id) do update set label = excluded.label;

    insert into public.account_deletion_storage_jobs (subject_user_id, op, from_path, to_path)
    values (p_user, 'delete_prefix', p_user::text, '')
    on conflict (subject_user_id, op, from_path, to_path) do nothing;

    delete from public.company_members where user_id = p_user;
    if to_regclass('public.bug_reports') is not null then
      delete from public.bug_reports where user_id = p_user;
    end if;
    if to_regclass('public.eld_import_mappings') is not null then
      delete from public.eld_import_mappings where user_id = p_user;
    end if;
    if to_regclass('public.profiles') is not null then
      delete from public.profiles where id = p_user;
    end if;
    v_ids := array[p_user];
  end if;

  if v_request.id is not null then
    update public.account_deletion_requests
       set applied_at = now(), purge_auth_user_ids = v_ids
     where id = v_request.id;
  end if;

  return jsonb_build_object(
    'already_applied', false,
    'demo', v_demo,
    'mode', case when v_has_profile then 'company' else 'member' end,
    'auth_user_ids', v_ids,
    'jobs', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', j.id, 'op', j.op, 'from_path', j.from_path, 'to_path', j.to_path, 'done_at', j.done_at
      ) order by j.created_at)
        from public.account_deletion_storage_jobs j
       where j.subject_user_id = p_user and j.done_at is null
    ), '[]'::jsonb)
  );
end
$fn$;

revoke all on function public.account_deletion_apply(uuid) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function public.account_deletion_apply(uuid) from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on function public.account_deletion_apply(uuid) from authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.account_deletion_apply(uuid) to service_role';
  end if;
end $$;

commit;
