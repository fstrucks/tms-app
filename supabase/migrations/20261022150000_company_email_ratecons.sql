-- Emailed rate cons are company-wide for the office team (Marc, Oct 22): owner, management and dispatcher of the
-- company that received the email see the documents, their inbound_emails rows and the "From email" drafts, and can
-- tap Create load, no matter whose ratecon+token address got the email. Drivers never see them.
-- The company is inbound_emails.company_id (company_profiles.id, set since #114); older untagged rows fall back to the
-- company owned by the document's user. Not applied: review, then apply. Idempotent.
begin;

-- 1. Which company an emailed document belongs to (security definer: reads inbound_emails / company_profiles
--    without going through their RLS).
create or replace function public.email_doc_company(p_inbound uuid, p_user uuid)
returns uuid language sql stable security definer set search_path = public as $$
  select coalesce(
    (select e.company_id from public.inbound_emails e where e.id = p_inbound and e.company_id is not null),
    (select p.id from public.company_profiles p where p.owner_id = p_user order by p.created_at limit 1));
$$;
revoke all on function public.email_doc_company(uuid, uuid) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on function public.email_doc_company(uuid, uuid) from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'grant execute on function public.email_doc_company(uuid, uuid) to authenticated'; end if;
end $$;

create or replace function public.can_see_email_doc(p_source text, p_inbound uuid, p_user uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select p_source = 'email' and coalesce(public.company_role(public.email_doc_company(p_inbound, p_user)) in ('owner', 'management', 'dispatcher'), false);
$$;
revoke all on function public.can_see_email_doc(text, uuid, uuid) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on function public.can_see_email_doc(text, uuid, uuid) from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'grant execute on function public.can_see_email_doc(text, uuid, uuid) to authenticated'; end if;
end $$;

-- 2. documents: an extra SELECT policy (the own-rows policy stays). Read only; writes stay own-rows.
drop policy if exists documents_select_company_email on public.documents;
create policy documents_select_company_email on public.documents for select to authenticated
  using (public.can_see_email_doc(source, inbound_email_id, user_id));

-- 3. Storage: the office team can open (View) those PDFs. Read only.
drop policy if exists documents_select_company_email on storage.objects;
create policy documents_select_company_email on storage.objects for select to authenticated
  using (bucket_id = 'documents' and exists (
    select 1 from public.documents d where d.file_path = storage.objects.name and public.can_see_email_doc(d.source, d.inbound_email_id, d.user_id)));

-- 4. inbound_emails ("Skipped from email" notices): also by the tagged company, not just the receiving user.
drop policy if exists inbound_emails_select on public.inbound_emails;
create policy inbound_emails_select on public.inbound_emails for select to authenticated
  using ((owner_id is not null and public.packet_role(owner_id) in ('owner', 'management', 'dispatcher'))
      or (company_id is not null and public.company_role(company_id) in ('owner', 'management', 'dispatcher')));

-- 5. Create load from an emailed rate con, for any office member of its company. The load belongs to the company
--    owner (like other office-created loads). Same parsing as create_load_from_document (20261010000680).
--    Two people tapping at once: the row lock serializes them and the second gets the SAME load id back (no duplicate).
create or replace function public.create_load_from_email_document(p_document uuid, p_tz text default 'America/Chicago')
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tz text;
  v_stop_tz text;
  v_doc record;
  v_company uuid;
  v_owner uuid;
  v_x jsonb;
  v_load uuid;
  v_notes text;
  v_s record;
  v_party jsonb;
  v_when jsonb;
  v_addr text;
  v_line1 text;
  v_city text;
  v_state text;
  v_zip text;
  v_date text;
  v_time text;
  v_appt timestamptz;
  v_stop_notes text;
begin
  if auth.uid() is null then raise exception 'document_not_found' using errcode = 'P0001'; end if;
  v_tz := case when p_tz is not null and exists (select 1 from pg_timezone_names where name = p_tz)
               then p_tz else 'America/Chicago' end;

  select id, user_id, load_id, ai_extracted_data, source, inbound_email_id
    into v_doc
    from public.documents
   where id = p_document
     for update;

  if not found or v_doc.source is distinct from 'email' then
    raise exception 'document_not_found' using errcode = 'P0001';
  end if;
  v_company := public.email_doc_company(v_doc.inbound_email_id, v_doc.user_id);
  if v_company is null or coalesce(public.company_role(v_company) in ('owner', 'management', 'dispatcher'), false) is not true then
    raise exception 'document_not_found' using errcode = 'P0001';
  end if;
  -- Already turned into a load (e.g. a teammate tapped first): return that load instead of making a second one.
  if v_doc.load_id is not null then
    return v_doc.load_id;
  end if;
  select p.owner_id into v_owner from public.company_profiles p where p.id = v_company;
  if v_owner is null then raise exception 'document_not_found' using errcode = 'P0001'; end if;
  v_x := v_doc.ai_extracted_data;
  if v_x is null or jsonb_typeof(v_x) <> 'object' then
    raise exception 'no_extracted_data' using errcode = 'P0001';
  end if;

  -- No reference column on loads: fold reference numbers into notes.
  v_notes := nullif(concat_ws(E'\n',
    nullif(v_x->>'notes', ''),
    case when jsonb_typeof(v_x->'reference_numbers') = 'array'
              and jsonb_array_length(v_x->'reference_numbers') > 0
         then 'Refs: ' || (select string_agg(r, ', ') from jsonb_array_elements_text(v_x->'reference_numbers') r)
    end
  ), '');

  insert into public.loads (user_id, status, broker_name, broker_load_number, rate, notes)
  values (
    v_owner,
    'booked',
    nullif(v_x->>'broker_name', ''),
    nullif(v_x->>'load_number', ''),
    case when jsonb_typeof(v_x->'rate') = 'number' then (v_x->>'rate')::numeric end,
    v_notes
  )
  returning id into v_load;

  for v_s in
    select * from (values (1, 'pickup', 'shipper', 'pickup'), (2, 'delivery', 'receiver', 'delivery')) as t(seq, kind, party, stop)
  loop
    v_party := case when jsonb_typeof(v_x->v_s.party) = 'object' then v_x->v_s.party else '{}'::jsonb end;
    v_when  := case when jsonb_typeof(v_x->v_s.stop)  = 'object' then v_x->v_s.stop  else '{}'::jsonb end;
    v_addr  := coalesce(nullif(trim(v_when->>'address'), ''), nullif(trim(v_party->>'address'), ''));
    -- Hardened parsing (see public.parse_us_address).
    select p.line1, p.city, p.state, p.zip into v_line1, v_city, v_state, v_zip
      from public.parse_us_address(v_addr) p;

    -- Each stop uses its state's time zone when known, else the caller's p_tz.
    v_stop_tz := coalesce(public.us_state_tz(v_state), v_tz);

    -- Appointment: date + time when both parse; else date only; else null. Raw values kept in notes.
    v_date := nullif(trim(v_when->>'date'), '');
    v_time := nullif(trim(v_when->>'time'), '');
    v_appt := null;
    v_stop_notes := null;
    if v_date is not null then
      begin
        v_appt := (v_date || ' ' || coalesce(v_time, '00:00'))::timestamp at time zone v_stop_tz;
      exception when others then
        begin
          v_appt := v_date::date::timestamp at time zone v_stop_tz;
          if v_time is not null then v_stop_notes := 'Time: ' || v_time; end if;
        exception when others then
          v_appt := null;
          v_stop_notes := concat_ws(' ', 'Appointment:', v_date, v_time);
        end;
      end;
    elsif v_time is not null then
      v_stop_notes := 'Time: ' || v_time;
    end if;
    -- No tz column on stops: record the zone used in notes.
    if v_appt is not null then
      v_stop_notes := concat_ws(E'\n', 'TZ: ' || v_stop_tz, v_stop_notes);
    end if;

    insert into public.stops (load_id, stop_type, sequence, company_name, address_line1, city, state, zip, appointment_start, notes, timezone)
    values (v_load, v_s.kind, v_s.seq, nullif(v_party->>'name', ''), v_line1, v_city, v_state, v_zip, v_appt, v_stop_notes, v_stop_tz);
  end loop;

  -- Equipment, weight and trip miles (the Documents page fills these from the browser for its own loads; a
  -- teammate can't update the owner's load directly, so they're set here). Only plain numbers / non-empty text.
  update public.loads set
    equipment_type = coalesce(equipment_type, nullif(trim(v_x->>'equipment_type'), '')),
    weight = coalesce(weight, case when jsonb_typeof(v_x->'weight_lb') = 'number' and (v_x->>'weight_lb')::numeric > 0 then (v_x->>'weight_lb')::numeric end),
    total_miles = coalesce(total_miles, case when jsonb_typeof(v_x->'total_miles') = 'number' and (v_x->>'total_miles')::numeric > 0 then (v_x->>'total_miles')::numeric end),
    miles_source = case when total_miles is null and jsonb_typeof(v_x->'total_miles') = 'number' and (v_x->>'total_miles')::numeric > 0 then 'rate_con' else miles_source end
  where id = v_load;

  update public.documents set load_id = v_load where id = p_document;

  return v_load;
end;
$$;
revoke all on function public.create_load_from_email_document(uuid, text) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on function public.create_load_from_email_document(uuid, text) from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'grant execute on function public.create_load_from_email_document(uuid, text) to authenticated'; end if;
end $$;

commit;
