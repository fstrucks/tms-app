-- 20261024000400: Truck maintenance vault, PR 3 (PROPOSED, NOT APPLIED). Sam reviews, Dakota applies.
-- Shop invoices and work orders (photo or PDF) filed per truck and searchable. Stored as public.documents rows with
-- doc_type 'maintenance_doc' and truck_id set; the file stays in the private 'documents' bucket, in the uploader's
-- own folder (same as receipts). Details (vendor, date, total, miles, notes, scanned text) live in new nullable
-- documents.maint_* columns and are written only through the security definer functions below.
-- Access follows 20261023000100 / 0200 (maint_role, maint_can_see, maint_drives_truck):
--   owner / management : add, edit, link, delete vault documents of their company's trucks
--   dispatcher         : read only
--   driver             : read only, for the truck he drives (maint_drives_truck)
--   other companies    : nothing
-- When a scan is confirmed and the visit is saved, documents.service_record_id points at that visit. Deleting the
-- visit keeps the vault document (FK on delete set null; only 'maintenance_receipt' rows are deleted with a visit).
-- Casey's Docs tile: public.maintenance_vault_count() returns int.
-- ASCII only. Idempotent: add column if not exists / create or replace / drop ... if exists / guarded grants.
begin;

do $$ begin
  if to_regprocedure('public.maint_can_see(uuid,uuid)') is null or to_regprocedure('public.documents_service_record_check()') is null then
    raise exception 'maintenance_vault: apply 20261023000100 / 0200 (maintenance log) first';
  end if;
end $$;

-- 1. Columns (all nullable; existing rows untouched).
alter table public.documents add column if not exists maint_vendor text;
alter table public.documents add column if not exists maint_doc_date date;
alter table public.documents add column if not exists maint_total numeric(10,2);
alter table public.documents add column if not exists maint_odometer integer;
alter table public.documents add column if not exists maint_notes text;
alter table public.documents add column if not exists maint_text text;          -- scanned text, for search
alter table public.documents add column if not exists maint_scanned_at timestamptz;
do $$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.documents'::regclass and conname = 'documents_maint_fields_check') then
    alter table public.documents add constraint documents_maint_fields_check check (
      (maint_vendor is null or length(maint_vendor) <= 120)
      and (maint_total is null or maint_total >= 0)
      and (maint_odometer is null or maint_odometer between 0 and 9999999)
      and (maint_notes is null or length(maint_notes) <= 1000)
      and (maint_text is null or length(maint_text) <= 20000));
  end if;
end $$;
do $$ declare c record; begin  -- extend a doc_type check only if prod has one (same rule as 0100)
  for c in select conname, pg_get_constraintdef(oid) def from pg_constraint
            where conrelid = 'public.documents'::regclass and contype = 'c' and pg_get_constraintdef(oid) ilike '%doc_type%' loop
    if c.def not ilike '%maintenance_doc%' then
      raise exception 'maintenance_vault: documents has a doc_type check (%) without maintenance_doc. Extend it by hand after review: %', c.conname, c.def;
    end if;
  end loop;
end $$;
create index if not exists documents_maint_file_path_idx on public.documents (file_path) where doc_type = 'maintenance_doc';
create index if not exists documents_maint_vault_idx on public.documents (truck_id, created_at desc) where doc_type = 'maintenance_doc';

-- 2. Helpers (security definer, read only). trucks is own-row RLS, so members need these to see the owner's trucks.
create or replace function public.maint_truck_visible(p_truck uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select p_truck is not null and exists (select 1 from public.trucks t where t.id = p_truck and public.maint_can_see(t.user_id, t.id));
$$;
create or replace function public.maint_truck_office(p_truck uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select p_truck is not null and exists (select 1 from public.trucks t where t.id = p_truck
    and coalesce(public.maint_role(t.user_id) in ('owner', 'management'), false));
$$;
create or replace function public.maint_vault_can_manage(p_doc uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.documents d where d.id = p_doc and d.doc_type = 'maintenance_doc' and public.maint_truck_office(d.truck_id));
$$;

-- 3. Guard: a vault row can be created, retyped, moved or deleted only by owner / management of that truck's company
-- (direct client writes included; documents_insert_own / update_own / delete_own allow any own row otherwise).
create or replace function public.documents_maint_vault_guard()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null and coalesce(auth.role(), '') <> 'anon' then return coalesce(new, old); end if;  -- server / cascade (never anon)
  if tg_op in ('UPDATE', 'DELETE') and old.doc_type = 'maintenance_doc' and not public.maint_truck_office(old.truck_id)
     and (tg_op = 'DELETE' or new.doc_type is distinct from old.doc_type or new.truck_id is distinct from old.truck_id) then
    raise exception 'vault_not_allowed' using errcode = '42501';
  end if;
  if tg_op in ('INSERT', 'UPDATE') and new.doc_type = 'maintenance_doc'
     and (tg_op = 'INSERT' or old.doc_type is distinct from new.doc_type or old.truck_id is distinct from new.truck_id)
     and not public.maint_truck_office(new.truck_id) then
    raise exception 'vault_not_allowed' using errcode = '42501';
  end if;
  return coalesce(new, old);
end $$;
drop trigger if exists documents_maint_vault_guard on public.documents;
create trigger documents_maint_vault_guard before insert or update of doc_type, truck_id or delete on public.documents
  for each row execute function public.documents_maint_vault_guard();

-- 4. Linking to a visit: 0100's check relabelled every linked document as a receipt. A vault document keeps its type.
-- Otherwise identical to 0100 (caller must be allowed to change the visit; max 10 receipts per visit, under a lock).
create or replace function public.documents_service_record_check()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.service_record_id is not null and (tg_op = 'INSERT' or new.service_record_id is distinct from old.service_record_id) then
    if auth.uid() is not null and not public.maint_record_changeable(new.service_record_id) then
      raise exception 'service_record_not_allowed' using errcode = '42501';
    end if;
    if new.doc_type is not null and new.doc_type not in ('maintenance_receipt', 'maintenance_doc') then
      raise exception 'not_a_receipt' using errcode = '23514';
    end if;
    -- The 10-per-visit cap counts receipts only; a linked vault document neither counts nor is capped.
    if new.doc_type is distinct from 'maintenance_doc' then
      perform pg_advisory_xact_lock(hashtextextended('maint_receipts:' || new.service_record_id::text, 0));
      if (select count(*) from public.documents d where d.service_record_id = new.service_record_id and d.id <> new.id
            and d.doc_type = 'maintenance_receipt') >= 10 then
        raise exception 'too_many_receipts' using errcode = '23514';
      end if;
    end if;
    if new.doc_type is distinct from 'maintenance_doc' then new.doc_type := 'maintenance_receipt'; end if;
  end if;
  return new;
end $$;

-- 5. Read access: everyone who can see the truck's maintenance sees its vault documents and files.
drop policy if exists documents_select_maint_vault on public.documents;
create policy documents_select_maint_vault on public.documents for select to authenticated
  using (doc_type = 'maintenance_doc' and public.maint_truck_visible(truck_id));
do $$ begin
  if to_regclass('storage.objects') is not null then
    execute 'drop policy if exists documents_select_maint_vault on storage.objects';
    execute $p$create policy documents_select_maint_vault on storage.objects for select to authenticated
      using (bucket_id = 'documents' and exists (select 1 from public.documents d where d.file_path = storage.objects.name
        and d.doc_type = 'maintenance_doc' and public.maint_truck_visible(d.truck_id)))$p$;
  end if;
end $$;

-- 6. Writes (security definer; owner / management of the truck's company only).
create or replace function public.maint_vault_add(p_truck uuid, p_file_path text, p_filename text, p_notes text default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  if auth.uid() is null or not public.maint_truck_office(p_truck) then raise exception 'vault_not_allowed' using errcode = '42501'; end if;
  if p_file_path is null or split_part(p_file_path, '/', 1) <> auth.uid()::text or length(p_file_path) > 300 then
    raise exception 'bad_file_path' using errcode = '22023';
  end if;
  insert into public.documents (user_id, truck_id, doc_type, file_path, original_filename, maint_notes)
  values (auth.uid(), p_truck, 'maintenance_doc', p_file_path, left(p_filename, 200), nullif(left(btrim(coalesce(p_notes, '')), 1000), ''))
  returning id into v_id;
  return v_id;
end $$;

-- Saves the confirmed details. p_text null keeps the stored scanned text; p_scanned marks it as scanned now.
create or replace function public.maint_vault_save(p_doc uuid, p_vendor text, p_date date, p_total numeric, p_odometer integer,
  p_notes text, p_text text default null, p_scanned boolean default false)
returns void language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null or not public.maint_vault_can_manage(p_doc) then raise exception 'vault_not_allowed' using errcode = '42501'; end if;
  update public.documents set
    maint_vendor = nullif(left(btrim(coalesce(p_vendor, '')), 120), ''), maint_doc_date = p_date, maint_total = p_total,
    maint_odometer = p_odometer, maint_notes = nullif(left(btrim(coalesce(p_notes, '')), 1000), ''),
    maint_text = coalesce(left(p_text, 20000), maint_text),
    maint_scanned_at = case when p_scanned then now() else maint_scanned_at end
  where id = p_doc;
end $$;

-- Links a vault document to a visit of the same truck (after the user confirmed the pre-filled Log service form).
create or replace function public.maint_vault_link(p_doc uuid, p_record uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_truck uuid;
begin
  if auth.uid() is null or not public.maint_vault_can_manage(p_doc) then raise exception 'vault_not_allowed' using errcode = '42501'; end if;
  select truck_id into v_truck from public.documents where id = p_doc;
  if not exists (select 1 from public.service_records r where r.id = p_record and r.truck_id = v_truck) then
    raise exception 'record_other_truck' using errcode = '22023';
  end if;
  update public.documents set service_record_id = p_record where id = p_doc;  -- documents_service_record_check runs
end $$;

-- Deletes the row and returns its storage path (the app removes the file).
create or replace function public.maint_vault_delete(p_doc uuid)
returns text language plpgsql security definer set search_path = public as $$
declare v_path text;
begin
  if auth.uid() is null or not public.maint_vault_can_manage(p_doc) then raise exception 'vault_not_allowed' using errcode = '42501'; end if;
  delete from public.documents where id = p_doc and doc_type = 'maintenance_doc' returning file_path into v_path;
  return v_path;
end $$;

-- 7. Reads.
-- Trucks the caller can see maintenance for, with their vault document counts.
create or replace function public.maint_vault_trucks()
returns table (id uuid, unit_number text, doc_count integer, can_manage boolean)
language sql stable security definer set search_path = public as $$
  select t.id, t.unit_number,
    (select count(*)::int from public.documents d where d.truck_id = t.id and d.doc_type = 'maintenance_doc'),
    coalesce(public.maint_role(t.user_id) in ('owner', 'management'), false)
  from public.trucks t
  where auth.uid() is not null and public.maint_can_see(t.user_id, t.id)
  order by t.unit_number nulls last, t.id;
$$;

-- Vault list. p_truck null = all visible trucks. p_q: every word must match vendor, date (YYYY-MM-DD, MM/DD/YYYY,
-- M/D/YYYY), notes, scanned text, file name or unit number (case-insensitive).
create or replace function public.maint_vault_list(p_truck uuid default null, p_q text default null, p_limit integer default 200)
returns table (id uuid, truck_id uuid, unit_number text, file_path text, original_filename text, created_at timestamptz,
  uploaded_by uuid, vendor text, doc_date date, total numeric, odometer integer, notes text, scanned boolean,
  service_record_id uuid, service_date date, can_manage boolean)
language sql stable security definer set search_path = public as $$
  with w as (
    select array_agg('%' || replace(replace(replace(x, '\', '\\'), '%', '\%'), '_', '\_') || '%') pats
      from regexp_split_to_table(lower(btrim(left(coalesce(p_q, ''), 200))), '\s+') x where x <> ''
  )
  select d.id, d.truck_id, t.unit_number, d.file_path, d.original_filename, d.created_at, d.user_id,
         d.maint_vendor, d.maint_doc_date, d.maint_total, d.maint_odometer, d.maint_notes, d.maint_scanned_at is not null,
         d.service_record_id, r.service_date, coalesce(public.maint_role(t.user_id) in ('owner', 'management'), false)
    from public.documents d
    join public.trucks t on t.id = d.truck_id
    left join public.service_records r on r.id = d.service_record_id
    cross join w
   where auth.uid() is not null and d.doc_type = 'maintenance_doc'
     and (p_truck is null or d.truck_id = p_truck)
     and t.user_id in (select auth.uid() union select cp.owner_id from public.company_members m join public.company_profiles cp on cp.id = m.profile_id where m.user_id = auth.uid())
     and public.maint_can_see(t.user_id, t.id)
     and (w.pats is null or lower(concat_ws(' ', d.maint_vendor, d.maint_notes, d.maint_text, d.original_filename, t.unit_number,
            to_char(d.maint_doc_date, 'YYYY-MM-DD'), to_char(d.maint_doc_date, 'MM/DD/YYYY'), to_char(d.maint_doc_date, 'FMMM/FMDD/YYYY'),
            to_char(d.maint_doc_date, 'FMMonth YYYY'))) like all (w.pats))
   order by coalesce(d.maint_doc_date, d.created_at::date) desc, d.created_at desc
   limit greatest(1, least(coalesce(p_limit, 200), 500));
$$;

-- Casey's Docs-tab Maintenance tile: vault documents the caller can see.
create or replace function public.maintenance_vault_count()
returns integer language sql stable security definer set search_path = public as $$
  select count(*)::int from public.documents d join public.trucks t on t.id = d.truck_id
   where auth.uid() is not null and d.doc_type = 'maintenance_doc'
     and t.user_id in (select auth.uid() union select cp.owner_id from public.company_members m join public.company_profiles cp on cp.id = m.profile_id where m.user_id = auth.uid())
     and public.maint_can_see(t.user_id, t.id);
$$;

-- 8. Grants: functions to authenticated only; maint_* columns are not client-writable (no column grants added).
do $$ declare f text; begin
  foreach f in array array['maint_truck_visible(uuid)', 'maint_truck_office(uuid)', 'maint_vault_can_manage(uuid)',
      'maint_vault_add(uuid,text,text,text)', 'maint_vault_save(uuid,text,date,numeric,integer,text,text,boolean)',
      'maint_vault_link(uuid,uuid)', 'maint_vault_delete(uuid)', 'maint_vault_trucks()', 'maint_vault_list(uuid,text,integer)',
      'maintenance_vault_count()'] loop
    execute format('revoke all on function public.%s from public', f);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function public.%s from anon', f); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('grant execute on function public.%s to authenticated', f); end if;
  end loop;
  execute 'revoke all on function public.documents_maint_vault_guard() from public';
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on function public.documents_maint_vault_guard() from anon'; end if;
end $$;

commit;
