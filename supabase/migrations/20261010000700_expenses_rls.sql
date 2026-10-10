-- expenses already exists (schema from Marc). NO column changes: RLS + grants only.
alter table public.expenses enable row level security;

drop policy if exists "expenses_select_own" on public.expenses;
create policy "expenses_select_own" on public.expenses for select to authenticated using (user_id = auth.uid());

-- load_id / document_id may only point at the user's own rows.
drop policy if exists "expenses_insert_own" on public.expenses;
create policy "expenses_insert_own" on public.expenses for insert to authenticated
  with check (
    user_id = auth.uid()
    and (load_id is null or exists (select 1 from public.loads l where l.id = expenses.load_id and l.user_id = auth.uid()))
    and (document_id is null or exists (select 1 from public.documents d where d.id = expenses.document_id and d.user_id = auth.uid()))
  );

drop policy if exists "expenses_update_own" on public.expenses;
create policy "expenses_update_own" on public.expenses for update to authenticated
  using (user_id = auth.uid())
  with check (
    user_id = auth.uid()
    and (load_id is null or exists (select 1 from public.loads l where l.id = expenses.load_id and l.user_id = auth.uid()))
    and (document_id is null or exists (select 1 from public.documents d where d.id = expenses.document_id and d.user_id = auth.uid()))
  );

drop policy if exists "expenses_delete_own" on public.expenses;
create policy "expenses_delete_own" on public.expenses for delete to authenticated using (user_id = auth.uid());

grant select, insert, update, delete on public.expenses to authenticated;
