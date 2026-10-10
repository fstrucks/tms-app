-- Run after: 20261010000050 (table), 20261010000000 (bucket), 20261010000100 (table RLS).

-- Authenticated users may update only safe columns of their own documents.
-- ai_extracted_data / file_path / user_id are written server-side only (service role).
revoke update on public.documents from authenticated;
grant update (load_id, truck_id, doc_type) on public.documents to authenticated;

-- Inserts: only client-safe columns (ai_extracted_data stays server-only).
revoke insert on public.documents from authenticated;
grant insert (user_id, load_id, truck_id, doc_type, file_path, original_filename) on public.documents to authenticated;

drop policy if exists "documents_update_own" on public.documents;
create policy "documents_update_own" on public.documents
  for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- Extraction audit / rate-limit log. Written only by the server (service role).
create table if not exists public.extraction_runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users on delete cascade,
  document_id uuid references public.documents on delete set null,
  created_at timestamptz not null default now(),
  status text not null default 'started'
);
create index if not exists extraction_runs_user_created_idx on public.extraction_runs (user_id, created_at desc);

alter table public.extraction_runs enable row level security;
revoke all on public.extraction_runs from anon, authenticated;

drop policy if exists "extraction_runs_select_own" on public.extraction_runs;
create policy "extraction_runs_select_own" on public.extraction_runs
  for select to authenticated
  using (user_id = auth.uid());
grant select on public.extraction_runs to authenticated;
