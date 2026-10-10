-- Legacy documents with no doc_type were rate confirmations (the only upload type before receipts).
-- /api/extract now requires doc_type = 'rate_confirmation', so backfill them.
-- Pre-merge: review the affected count first: select count(*) from public.documents where doc_type is null;
update public.documents set doc_type = 'rate_confirmation' where doc_type is null;
