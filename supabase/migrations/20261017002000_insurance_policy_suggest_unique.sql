-- OPTIONAL hardening for COI Suggest (PR #66). ADDITIVE ONLY. Needs Marc's OK before Dakota runs it on prod.
-- The app already dedupes suggestions without this (plan + converge pass in /api/company/insurance/suggest);
-- this index just makes simultaneous Suggest calls for the same document impossible to duplicate at the DB level.
-- If existing duplicate AI rows are present, remove them first (the app's next Suggest run also cleans them up),
-- otherwise creating the index fails. Confirmed and manual rows are not affected.
create unique index if not exists insurance_policies_ai_suggest_unique
  on public.insurance_policies (
    owner_id, document_id, coverage,
    (case when coalesce(policy_number, '') <> '' then 'n:' || lower(regexp_replace(policy_number, '[^a-zA-Z0-9]', '', 'g'))
          else 'i:' || lower(regexp_replace(coalesce(insurer, ''), '[^a-zA-Z0-9]', '', 'g')) end)
  )
  where source = 'ai' and confirmed = false and document_id is not null;
