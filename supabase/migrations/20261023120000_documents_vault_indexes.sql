-- Docs tab vaults. Indexes only, so the inbox and the load-docs vault can filter by
-- uploader, type, date, and load without walking every document row.
-- No policy changes. No grants. Do not apply from the app. Review, then run by hand.

create index if not exists documents_user_created_idx
  on public.documents (user_id, created_at desc);

create index if not exists documents_type_created_idx
  on public.documents (doc_type, created_at desc)
  where doc_type is not null;

create index if not exists documents_load_created_idx
  on public.documents (load_id, created_at desc)
  where load_id is not null;

create index if not exists loads_owner_load_number_idx
  on public.loads (user_id, broker_load_number);

create index if not exists loads_owner_broker_name_idx
  on public.loads (user_id, broker_name);
