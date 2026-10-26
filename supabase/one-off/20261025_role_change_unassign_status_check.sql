-- Read-only check after applying
-- supabase/migrations/20261025000100_role_change_unassign_reverts_dispatched.sql.
-- Not a migration. Do not run from the app or from CI.
-- Selects only. It does not change any row.
--
-- Expect:
--   1. Two rows, set_member_also_drives(uuid, boolean) and
--      set_member_role(uuid, text, boolean). Both have security_definer = true,
--      config containing search_path=public, reverts_dispatched_to_booked = true,
--      and clears_show_rate = true.
--   2. dispatched_with_no_driver = 0, and the listing returns no rows.
--
-- The migration does not rewrite loads already stored as dispatched with no driver.
-- A count above zero is data that was already in that state. Report those rows.
-- Do not change them from this file.

-- 1. Both live function bodies contain the dispatched → booked assignment.
select p.proname as function_name,
       pg_get_function_identity_arguments(p.oid) as arguments,
       p.prosecdef as security_definer,
       array_to_string(p.proconfig, ', ') as config,
       strpos(pg_get_functiondef(p.oid),
              'status = case when l.status = ''dispatched'' then ''booked'' else l.status end') > 0
         as reverts_dispatched_to_booked,
       strpos(pg_get_functiondef(p.oid), 'show_rate_to_driver = false') > 0
         as clears_show_rate
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public'
   and p.proname in ('set_member_role', 'set_member_also_drives')
 order by p.proname, 2;

-- 2. Dispatched loads with no driver. Expect 0.
select count(*)::integer as dispatched_with_no_driver
  from public.loads
 where status = 'dispatched'
   and assigned_driver_user_id is null;

-- 3. The same rows, so a non-zero count can be identified. Expect no rows.
select l.id,
       l.user_id,
       l.broker_load_number,
       l.status,
       l.assigned_driver_user_id,
       l.show_rate_to_driver
  from public.loads l
 where l.status = 'dispatched'
   and l.assigned_driver_user_id is null
 order by l.broker_load_number nulls last, l.id;
