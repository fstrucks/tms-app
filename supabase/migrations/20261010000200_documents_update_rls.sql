drop policy if exists "documents_update_own" on public.documents;
create policy "documents_update_own" on public.documents
  for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());
