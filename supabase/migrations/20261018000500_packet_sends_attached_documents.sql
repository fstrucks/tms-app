-- Company Documents vault (PR #84), pick 5B: send history records which company documents went to each broker.
-- NOT APPLIED by this PR. Dakota runs it only after Marc OKs it (relayed by Sam).
-- Depends on 20261016001700_packet_sends.sql. ADDITIVE ONLY. Idempotent: safe to re-run.
--
-- One optional column on public.packet_sends:
--   attached_document_ids uuid[] NULL: the documents.id of each vault file (W-9, COI, MC Authority, NOA version)
--   attached to that send, besides the filled packet PDF. NULL = no vault files, or a send made before this column.
--   No default, no backfill, no foreign key (a deleted vault version must not erase or block the history row).
-- Rows are still written only by the server send route (service role). The existing packet_sends_select policy
-- already covers the new column, so no grant or policy change is needed.
-- Undo: alter table public.packet_sends drop column if exists attached_document_ids;

alter table public.packet_sends add column if not exists attached_document_ids uuid[] null;

comment on column public.packet_sends.attached_document_ids is
  'Vault documents (documents.id) attached to this broker send besides the filled packet. NULL = none or sent before PR #84.';
