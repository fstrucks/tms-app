-- One-off backfill. NOT APPLIED.
-- Do not run this from the app, from CI, or against production until PART 1 and PART 2 have been read.
--
-- What it does: an emailed (or uploaded) rate confirmation that still needs attention is linked to an
-- existing load in the same account when the broker load numbers match. Match is trim + case-insensitive
-- (lower(btrim(...))). Example: a draft whose read load number is 6842063156 and a completed load already
-- stored as ' 6842063156 ' for that account.
--
-- Same account: loads.user_id is the document's user_id, or the owner of the document's company
-- (public.email_doc_company: the inbound company, else the company that user owns, else the company
-- they belong to). A load in another account is never chosen.
--
-- Exactly one matching load → the document can be linked. Several matches are listed and left alone.
-- PART 3 updates public.documents.load_id only. It does not insert a load and does not update any loads row.
--
-- Depends on public.email_doc_company (20261022150000 / 20261022180000), public.documents, public.loads,
-- public.company_profiles, and public.scale_tickets. Run each part on its own.

-- =====================================================================
-- PART 1. Every document that still needs attention, per account.
-- This is the Docs tab "Needs attention" list: unreviewed email rate cons, and uploads that are not
-- filed to a load, a truck, maintenance, a company file, a checklist file, or a scale ticket.
-- Read-only. Use it to identify each waiting item.
-- =====================================================================
with account_of as (
  select d.id as document_id,
         public.email_doc_company(d.inbound_email_id, d.user_id) as company_id,
         d.user_id
    from public.documents d
),
accounts as (
  select a.document_id,
         coalesce(a.company_id, a.user_id) as account_id,
         case when a.company_id is null then 'user' else 'company' end as account_kind,
         cp.owner_id as company_owner_id,
         coalesce(cp.legal_name, cp.dba_name) as account_name
    from account_of a
    left join public.company_profiles cp on cp.id = a.company_id
),
unhandled as (
  select d.id, d.user_id, d.original_filename, d.doc_type, d.source, d.file_path,
         d.extraction_status, d.extraction_error, d.created_at, d.ai_extracted_data,
         ac.account_id, ac.account_kind, ac.company_owner_id, ac.account_name
    from public.documents d
    join accounts ac on ac.document_id = d.id
   where d.doc_type is distinct from 'receipt'
     and coalesce(d.doc_type, '') not in ('w9', 'coi', 'mc_authority', 'noa')
     and d.load_id is null
     and d.truck_id is null
     and d.service_record_id is null
     and coalesce(d.file_path, '') not like '%/company/%'
     and coalesce(d.file_path, '') not like '%/checklist/%'
     and not exists (select 1 from public.scale_tickets t where t.document_id = d.id)
     and (
       (d.source = 'email'
         and (d.doc_type is null or d.doc_type = 'rate_confirmation')
         and not (d.ai_extracted_data is null and d.extraction_error = 'not_ratecon'))
       or coalesce(d.source, 'upload') is distinct from 'email'
     )
)
select account_kind,
       account_id,
       account_name,
       company_owner_id,
       id as document_id,
       user_id,
       original_filename,
       doc_type,
       source,
       extraction_status,
       extraction_error,
       created_at,
       nullif(btrim(ai_extracted_data->>'load_number'), '') as extracted_load_number,
       file_path,
       case when source = 'email' then 'email_rate_con' else 'unassigned_upload' end as attention_reason
  from unhandled
 order by account_kind, account_id, created_at nulls last, id;

-- =====================================================================
-- PART 2. Preview of unhandled rate cons that match an existing load. Read-only.
-- action = will_link only when that account has exactly one load with that broker load number.
-- action = needs_review_not_updated when several loads match; those rows are not in PART 3.
-- =====================================================================
with account_of as (
  select d.id as document_id,
         public.email_doc_company(d.inbound_email_id, d.user_id) as company_id,
         d.user_id
    from public.documents d
),
accounts as (
  select a.document_id,
         coalesce(a.company_id, a.user_id) as account_id,
         case when a.company_id is null then 'user' else 'company' end as account_kind,
         cp.owner_id as company_owner_id,
         coalesce(cp.legal_name, cp.dba_name) as account_name
    from account_of a
    left join public.company_profiles cp on cp.id = a.company_id
),
unhandled as (
  select d.id, d.user_id, d.original_filename, d.doc_type, d.source, d.created_at, d.ai_extracted_data,
         ac.account_id, ac.account_kind, ac.company_owner_id, ac.account_name
    from public.documents d
    join accounts ac on ac.document_id = d.id
   where d.doc_type is distinct from 'receipt'
     and coalesce(d.doc_type, '') not in ('w9', 'coi', 'mc_authority', 'noa')
     and d.load_id is null
     and d.truck_id is null
     and d.service_record_id is null
     and coalesce(d.file_path, '') not like '%/company/%'
     and coalesce(d.file_path, '') not like '%/checklist/%'
     and not exists (select 1 from public.scale_tickets t where t.document_id = d.id)
     and (
       (d.source = 'email'
         and (d.doc_type is null or d.doc_type = 'rate_confirmation')
         and not (d.ai_extracted_data is null and d.extraction_error = 'not_ratecon'))
       or coalesce(d.source, 'upload') is distinct from 'email'
     )
),
ratecons as (
  select u.*
    from unhandled u
   where (u.doc_type is null or u.doc_type = 'rate_confirmation')
     and nullif(btrim(u.ai_extracted_data->>'load_number'), '') is not null
),
hits as (
  select r.id as document_id,
         r.account_id,
         l.id as load_id,
         l.user_id as load_user_id,
         l.broker_load_number,
         l.status as load_status,
         l.created_at as load_created_at
    from ratecons r
    join public.loads l
      on nullif(lower(btrim(l.broker_load_number)), '') = lower(btrim(r.ai_extracted_data->>'load_number'))
     and (l.user_id = r.user_id or (r.company_owner_id is not null and l.user_id = r.company_owner_id))
),
chosen as (
  select document_id,
         count(*) as match_count,
         (array_agg(load_id order by load_created_at nulls last, load_id))[1] as oldest_load_id,
         (array_agg(broker_load_number order by load_created_at nulls last, load_id))[1] as broker_load_number,
         (array_agg(load_status order by load_created_at nulls last, load_id))[1] as load_status,
         (array_agg(load_user_id order by load_created_at nulls last, load_id))[1] as load_user_id
    from hits
   group by document_id
)
select r.account_kind,
       r.account_id,
       r.account_name,
       r.id as document_id,
       r.user_id,
       r.original_filename,
       r.source,
       r.created_at,
       btrim(r.ai_extracted_data->>'load_number') as extracted_load_number,
       c.match_count,
       case when c.match_count = 1 then c.oldest_load_id end as chosen_load_id,
       case when c.match_count = 1 then c.broker_load_number end as chosen_broker_load_number,
       case when c.match_count = 1 then c.load_status end as chosen_load_status,
       case when c.match_count = 1 then c.load_user_id end as chosen_load_user_id,
       case when c.match_count = 1 then 'will_link' else 'needs_review_not_updated' end as action
  from ratecons r
  join chosen c on c.document_id = r.id
 order by r.account_id, r.created_at nulls last, r.id;

-- Every candidate load for those documents, so a row with several matches can be identified.
-- Read-only. Not used by the UPDATE.
with account_of as (
  select d.id as document_id,
         public.email_doc_company(d.inbound_email_id, d.user_id) as company_id,
         d.user_id
    from public.documents d
),
accounts as (
  select a.document_id,
         coalesce(a.company_id, a.user_id) as account_id,
         cp.owner_id as company_owner_id
    from account_of a
    left join public.company_profiles cp on cp.id = a.company_id
),
unhandled as (
  select d.id, d.user_id, d.original_filename, d.doc_type, d.ai_extracted_data,
         ac.account_id, ac.company_owner_id
    from public.documents d
    join accounts ac on ac.document_id = d.id
   where d.doc_type is distinct from 'receipt'
     and coalesce(d.doc_type, '') not in ('w9', 'coi', 'mc_authority', 'noa')
     and d.load_id is null
     and d.truck_id is null
     and d.service_record_id is null
     and coalesce(d.file_path, '') not like '%/company/%'
     and coalesce(d.file_path, '') not like '%/checklist/%'
     and not exists (select 1 from public.scale_tickets t where t.document_id = d.id)
     and (d.doc_type is null or d.doc_type = 'rate_confirmation')
     and nullif(btrim(d.ai_extracted_data->>'load_number'), '') is not null
     and (
       (d.source = 'email' and not (d.ai_extracted_data is null and d.extraction_error = 'not_ratecon'))
       or coalesce(d.source, 'upload') is distinct from 'email'
     )
)
select u.account_id,
       u.id as document_id,
       u.original_filename,
       btrim(u.ai_extracted_data->>'load_number') as extracted_load_number,
       l.id as load_id,
       l.user_id as load_user_id,
       l.broker_load_number,
       l.status as load_status,
       l.created_at as load_created_at
  from unhandled u
  join public.loads l
    on nullif(lower(btrim(l.broker_load_number)), '') = lower(btrim(u.ai_extracted_data->>'load_number'))
   and (l.user_id = u.user_id or (u.company_owner_id is not null and l.user_id = u.company_owner_id))
 order by u.account_id, u.id, l.created_at nulls last, l.id;

-- =====================================================================
-- PART 3. UPDATE. Run only after PART 1 and PART 2 look right.
-- Sets public.documents.load_id. No other column. No other table.
-- =====================================================================
begin;

with account_of as (
  select d.id as document_id,
         public.email_doc_company(d.inbound_email_id, d.user_id) as company_id,
         d.user_id
    from public.documents d
),
accounts as (
  select a.document_id,
         cp.owner_id as company_owner_id
    from account_of a
    left join public.company_profiles cp on cp.id = a.company_id
),
unhandled as (
  select d.id, d.user_id, d.ai_extracted_data, ac.company_owner_id
    from public.documents d
    join accounts ac on ac.document_id = d.id
   where d.doc_type is distinct from 'receipt'
     and coalesce(d.doc_type, '') not in ('w9', 'coi', 'mc_authority', 'noa')
     and d.load_id is null
     and d.truck_id is null
     and d.service_record_id is null
     and coalesce(d.file_path, '') not like '%/company/%'
     and coalesce(d.file_path, '') not like '%/checklist/%'
     and not exists (select 1 from public.scale_tickets t where t.document_id = d.id)
     and (d.doc_type is null or d.doc_type = 'rate_confirmation')
     and nullif(btrim(d.ai_extracted_data->>'load_number'), '') is not null
     and (
       (d.source = 'email'
         and not (d.ai_extracted_data is null and d.extraction_error = 'not_ratecon'))
       or coalesce(d.source, 'upload') is distinct from 'email'
     )
),
hits as (
  select u.id as document_id, l.id as load_id
    from unhandled u
    join public.loads l
      on nullif(lower(btrim(l.broker_load_number)), '') = lower(btrim(u.ai_extracted_data->>'load_number'))
     and (l.user_id = u.user_id or (u.company_owner_id is not null and l.user_id = u.company_owner_id))
),
chosen as (
  select document_id, min(load_id::text)::uuid as load_id
    from hits
   group by document_id
  having count(*) = 1
)
update public.documents d
   set load_id = c.load_id
  from chosen c
 where d.id = c.document_id
   and d.load_id is null;

-- The row count should match PART 2 rows whose action is will_link. Then commit.
commit;
