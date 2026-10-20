-- Rate con email-in dedupe (PR follow-up to #102). ADDITIVE ONLY: one nullable column + one partial index. NOT APPLIED.
-- Depends on 20261019000200_ratecon_email_in.sql (documents.source).
-- The webhook stores sha256(PDF bytes) on each emailed rate con and skips a PDF the same owner already has
-- ("already received" in the Documents skipped notice). Old rows stay null, so they never block a new email.
-- Until this runs, the app logs the lookup error and skips dedupe (no other change).
alter table public.documents add column if not exists content_sha256 text null;
do $$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.documents'::regclass and conname = 'documents_content_sha256_check') then
    alter table public.documents add constraint documents_content_sha256_check check (content_sha256 is null or content_sha256 ~ '^[a-f0-9]{64}$');
  end if;
end $$;
create index if not exists documents_email_sha256_idx on public.documents (user_id, content_sha256)
  where source = 'email' and content_sha256 is not null;
