-- Recreate documents_insert_own (from 20261010000100) keeping its conditions
-- (own user_id, file_path under {auth.uid()}/) and also requiring load_id to be null or one of the user's own loads.
drop policy if exists "documents_insert_own" on public.documents;
create policy "documents_insert_own" on public.documents
  for insert to authenticated
  with check (
    user_id = auth.uid()
    and split_part(file_path, '/', 1) = auth.uid()::text
    and (load_id is null or exists (select 1 from public.loads l where l.id = documents.load_id and l.user_id = auth.uid()))
  );
