-- PR #110: scale tickets and BOLs show under their load.
-- No policy or data changes. documents RLS stays own-rows (uploader only); the new server endpoints
-- (/api/loads/:id/documents, /api/documents/:id/load, /api/documents/:id/suggest-load) check the caller's company
-- role with packet_role() and then read/link with the service role, always filtered to the caller's company.
-- This migration only adds the indexes those endpoints use and documents the doc_type keys. Safe to re-run.

-- Load page: documents linked to a load.
create index if not exists documents_load_id_idx on public.documents (load_id) where load_id is not null;

-- Load page: scale-ticket photos linked through scale_tickets.load_id (Truck tab scans).
create index if not exists scale_tickets_load_doc_idx on public.scale_tickets (load_id) where load_id is not null and document_id is not null;

comment on column public.documents.doc_type is
  'Plain text. Load paperwork: bol, pod, lumper_receipt, scale_ticket, other:<name>; rate_confirmation; receipt (expenses); company: w9, coi, mc_authority, noa.';
