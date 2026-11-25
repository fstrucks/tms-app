-- Follow-up to 20261117000100_location_shares.sql (#179). Reviewed by Sam before apply.
-- Supabase default privileges gave anon full grants on the new tables; RLS already blocks anon,
-- this just removes the grants (defense in depth). No data changes.
revoke all on table public.location_shares from anon;
revoke all on table public.location_pings from anon;
revoke all on table public.location_share_latest from anon;
-- Verify (read-only):
-- select table_name, privilege_type from information_schema.role_table_grants
--  where grantee = 'anon' and table_name in ('location_shares','location_pings','location_share_latest');
