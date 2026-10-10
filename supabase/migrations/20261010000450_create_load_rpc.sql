-- PENDING SCHEMA VERIFICATION: uses only the loads/stops columns assumed in 20261010000400_loads.sql.
-- Run after 20261010000400_loads.sql.
--
-- Creates a load + pickup/delivery stops from a document's ai_extracted_data and links the document,
-- atomically (a single function call = a single transaction). SECURITY INVOKER, so RLS applies.
-- Errors (SQLSTATE P0001, message is a stable code): document_not_found, already_linked, no_extracted_data.

create or replace function public.create_load_from_document(p_document uuid)
returns uuid
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_doc record;
  v_x jsonb;
  v_load uuid;
  v_refs text[];
begin
  select id, user_id, load_id, ai_extracted_data
    into v_doc
    from public.documents
   where id = p_document
     for update;

  if not found or v_doc.user_id is distinct from auth.uid() then
    raise exception 'document_not_found' using errcode = 'P0001';
  end if;
  if v_doc.load_id is not null then
    raise exception 'already_linked' using errcode = 'P0001', detail = v_doc.load_id::text;
  end if;
  v_x := v_doc.ai_extracted_data;
  if v_x is null or jsonb_typeof(v_x) <> 'object' then
    raise exception 'no_extracted_data' using errcode = 'P0001';
  end if;

  if jsonb_typeof(v_x->'reference_numbers') = 'array' then
    select array_agg(r) into v_refs from jsonb_array_elements_text(v_x->'reference_numbers') r;
  end if;

  insert into public.loads (user_id, status, broker_name, load_number, reference_numbers, rate, notes)
  values (
    auth.uid(),
    'booked',
    nullif(v_x->>'broker_name', ''),
    nullif(v_x->>'load_number', ''),
    v_refs,
    case when jsonb_typeof(v_x->'rate') = 'number' then (v_x->>'rate')::numeric end,
    nullif(v_x->>'notes', '')
  )
  returning id into v_load;

  -- Pickup (1) and delivery (2). Dates cast only when YYYY-MM-DD; otherwise the raw text goes into scheduled_time.
  insert into public.stops (load_id, sequence, stop_type, name, address, scheduled_date, scheduled_time)
  select
    v_load,
    s.seq,
    s.kind,
    nullif(v_x->s.party->>'name', ''),
    coalesce(nullif(v_x->s.stop->>'address', ''), nullif(v_x->s.party->>'address', '')),
    case when v_x->s.stop->>'date' ~ '^\d{4}-\d{2}-\d{2}$' then (v_x->s.stop->>'date')::date end,
    nullif(concat_ws(' ',
      nullif(v_x->s.stop->>'time', ''),
      case when v_x->s.stop->>'date' !~ '^\d{4}-\d{2}-\d{2}$' then nullif(v_x->s.stop->>'date', '') end
    ), '')
  from (values (1, 'pickup', 'shipper', 'pickup'), (2, 'delivery', 'receiver', 'delivery')) as s(seq, kind, party, stop);

  update public.documents set load_id = v_load where id = p_document;

  return v_load;
end;
$$;

revoke execute on function public.create_load_from_document(uuid) from public, anon;
grant execute on function public.create_load_from_document(uuid) to authenticated;
