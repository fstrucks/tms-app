-- Company profile: Reply-to email for emailed paperwork (Marc, Oct 26). Each company picks where broker replies go.
-- ADDITIVE ONLY, idempotent. One nullable text column, no default, no backfill, plus a shape check.
-- Existing RLS policies on company_profiles (select: members; update: company_can_edit) already cover it.
alter table public.company_profiles add column if not exists reply_to_email text;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'company_profiles_reply_to_email_shape' and conrelid = 'public.company_profiles'::regclass) then
    alter table public.company_profiles add constraint company_profiles_reply_to_email_shape
      check (reply_to_email is null or (length(reply_to_email) <= 254 and reply_to_email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'));
  end if;
end $$;
