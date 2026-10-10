create table if not exists public.documents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users,
  load_id uuid,
  truck_id uuid,
  doc_type text,
  file_path text,
  original_filename text,
  ai_extracted_data jsonb,
  created_at timestamptz default now()
);
