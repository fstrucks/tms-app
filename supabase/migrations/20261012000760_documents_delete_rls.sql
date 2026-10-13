-- Allow users to delete their own documents rows (storage.objects already has documents_delete_own).
-- Without this, RLS silently deletes 0 rows from public.documents.
drop policy if exists "documents_delete_own" on public.documents;
create policy "documents_delete_own" on public.documents
  for delete to authenticated
  using (user_id = auth.uid());
