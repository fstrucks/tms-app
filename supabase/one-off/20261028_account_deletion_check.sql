-- Read-only check after applying
-- supabase/migrations/20261028000100_account_deletion.sql.
-- Not a migration. Do not run from the app or from CI.
-- Selects only. It does not change any row.
--
-- Expect:
--   1. account_deletion_apply(uuid) exists, security definer, search_path includes
--      public and pg_temp. The body sends a dispatched load with no driver back to
--      booked, labels a removed person Former team member, and does not remove
--      facilities or reviews. It refuses a locked company and a person on more than
--      one company, and it cancels when a later sign-in is newer than the baseline.
--   2. anon, authenticated, and PUBLIC cannot execute that function. Expect false, false, false.
--   3. company_profiles.is_demo and deletion_locked exist.
--   4. facility review authors, load_packet_sends.owner_id, and company_profiles.signed_by
--      can be empty (so a removed sign-in does not remove those rows).

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
       strpos(pg_get_functiondef(p.oid), 'grace_period') > 0 as guards_grace_period,
       strpos(pg_get_functiondef(p.oid), 'last_sign_in_at') > 0 as cancels_on_later_sign_in,
       strpos(pg_get_functiondef(p.oid), 'protected_company') > 0 as protects_company,
       strpos(pg_get_functiondef(p.oid), 'multi_company_member') > 0 as refuses_multi_company,
       strpos(pg_get_functiondef(p.oid), 'deletion_locked') > 0 as honors_deletion_lock,
       strpos(array_to_string(p.proconfig, ', '), 'pg_temp') > 0 as search_path_includes_pg_temp
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public'
   and p.proname = 'account_deletion_apply';

-- 2. Execute rights. Expect false, false, false.
--    grantee 0 on the function acl is PUBLIC. A null proacl means the default acl.
select has_function_privilege('anon', 'public.account_deletion_apply(uuid)', 'execute') as anon_execute,
       has_function_privilege('authenticated', 'public.account_deletion_apply(uuid)', 'execute') as authenticated_execute,
       exists (
         select 1
           from pg_proc p
           join pg_namespace n on n.oid = p.pronamespace
           cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) as acl
          where n.nspname = 'public'
            and p.proname = 'account_deletion_apply'
            and pg_get_function_identity_arguments(p.oid) = 'p_user uuid'
            and acl.privilege_type = 'EXECUTE'
            and acl.grantee = 0
       ) as public_execute;

-- 3. Demo flag and the lock.
select column_name, data_type, column_default, is_nullable
  from information_schema.columns
 where table_schema = 'public'
   and table_name = 'company_profiles'
   and column_name in ('is_demo', 'deletion_locked')
 order by column_name;

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
     or (table_name = 'company_profiles' and column_name = 'signed_by')
   )
 order by table_name, column_name;
