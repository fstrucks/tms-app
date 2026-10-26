select column_name, data_type, is_nullable, column_default from information_schema.columns where table_schema = 'public' and table_name = 'company_profiles' and column_name = 'reply_to_email';
select conname, pg_get_constraintdef(oid) as definition from pg_constraint where conrelid = 'public.company_profiles'::regclass and conname = 'company_profiles_reply_to_email_shape';
select policyname, cmd, qual, with_check from pg_policies where schemaname = 'public' and tablename = 'company_profiles' order by policyname;
select count(*) filter (where reply_to_email is not null) as companies_with_reply_to, count(*) as companies from public.company_profiles;
