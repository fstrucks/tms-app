-- expenses already exists (schema from Marc). NO column changes: RLS, grants and NOT VALID check constraints only.
alter table public.expenses enable row level security;

-- Drop every existing expenses policy that isn't one of ours, so nothing more permissive survives.
do $$
declare p record;
begin
  for p in
    select policyname from pg_policies
     where schemaname = 'public' and tablename = 'expenses'
       and policyname not in ('expenses_select_own', 'expenses_insert_own', 'expenses_update_own', 'expenses_delete_own')
  loop
    execute format('drop policy %I on public.expenses', p.policyname);
  end loop;
end $$;

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

-- Check constraints: added NOT VALID so existing rows are not checked (new and updated rows are).
-- Run "alter table public.expenses validate constraint <name>" after cleaning legacy data.
do $$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.expenses'::regclass and conname = 'expenses_amount_nonneg') then
    alter table public.expenses add constraint expenses_amount_nonneg check (amount >= 0) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.expenses'::regclass and conname = 'expenses_category_allowed') then
    alter table public.expenses add constraint expenses_category_allowed
      check (category in ('fuel', 'tolls', 'maintenance', 'food', 'lodging', 'other')) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.expenses'::regclass and conname = 'expenses_date_present') then
    alter table public.expenses add constraint expenses_date_present check (expense_date is not null) not valid;
  end if;
end $$;
