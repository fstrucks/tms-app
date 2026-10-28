-- Read-only check after applying
-- supabase/migrations/20261028000100_account_deletion.sql.
-- Not a migration. Do not run from the app or from CI.
-- Selects only. It does not change any row.
--
-- Expect:
--   1. account_deletion_apply(uuid) exists, security definer, search_path=public.
--      The body sends a dispatched load with no driver back to booked, labels a
--      removed person Former team member, and does not remove facilities or reviews.
--   2. anon and authenticated cannot execute that function.
--   3. company_profiles.is_demo exists.
--   4. facility review authors and load_packet_sends.owner_id can be empty
--      (so a removed sign-in does not remove those rows).

-- 1. Function shape.
select p.proname as function_name,
       pg_get_function_identity_arguments(p.oid) as arguments,
       p.prosecdef as security_definer,
       array_to_string(p.proconfig, ', ') as config,
       strpos(pg_get_functiondef(p.oid),
              'status = case when l.status = ''dispatched'' then ''booked'' else l.status end') > 0
         as reverts_dispatched_to_booked,
       strpos(pg_get_functiondef(p.oid), 'Former team member') > 0 as former_label,
       strpos(pg_get_functiondef(p.oid), 'delete from public.facilities') > 0 as deletes_facilities,
       strpos(pg_get_functiondef(p.oid), 'delete from public.facility_reviews') > 0 as deletes_reviews,
       strpos(pg_get_functiondef(p.oid), 'grace_period') > 0 as guards_grace_period
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public'
   and p.proname = 'account_deletion_apply';

-- 2. Execute rights. Expect no row for anon or authenticated.
select grantee, privilege_type
  from information_schema.routine_privileges
 where specific_schema = 'public'
   and routine_name = 'account_deletion_apply'
   and grantee in ('anon', 'authenticated', 'public')
 order by grantee;

-- 3. Demo flag.
select column_name, data_type, column_default, is_nullable
  from information_schema.columns
 where table_schema = 'public'
   and table_name = 'company_profiles'
   and column_name = 'is_demo';

-- 4. Kept rows can outlive the sign-in.
select table_name, column_name, is_nullable
  from information_schema.columns
 where table_schema = 'public'
   and (
     (table_name = 'facility_reviews' and column_name = 'author_id')
     or (table_name = 'facility_notes' and column_name = 'author_id')
     or (table_name = 'load_packet_sends' and column_name = 'owner_id')
     or (table_name = 'packet_sends' and column_name = 'owner_id')
     or (table_name = 'coi_requests' and column_name = 'owner_id')
   )
 order by table_name, column_name;
