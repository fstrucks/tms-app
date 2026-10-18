-- Company profile: Owner name, so carrier packets fill the "Owner name" field from the profile (Marc, Oct 18).
-- ADDITIVE ONLY, idempotent. Nullable text, no default, no backfill. Existing RLS policies on company_profiles
-- already cover the new column (row-level policies; no column grants involved).
alter table public.company_profiles add column if not exists owner_name text;
