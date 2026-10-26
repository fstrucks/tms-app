select to_regclass('public.load_packet_sends') is not null as table_exists;
select relrowsecurity as rls_enabled from pg_class where oid = 'public.load_packet_sends'::regclass;
select policyname, cmd, roles, qual, with_check from pg_policies where schemaname = 'public' and tablename = 'load_packet_sends' order by policyname;
select grantee, privilege_type from information_schema.role_table_grants where table_schema = 'public' and table_name = 'load_packet_sends' and grantee in ('anon', 'authenticated', 'public') order by grantee, privilege_type;
select indexname, indexdef from pg_indexes where schemaname = 'public' and tablename = 'load_packet_sends' order by indexname;
select kcu.column_name, ccu.table_name as references_table, rc.delete_rule from information_schema.referential_constraints rc join information_schema.key_column_usage kcu on kcu.constraint_name = rc.constraint_name and kcu.constraint_schema = rc.constraint_schema join information_schema.constraint_column_usage ccu on ccu.constraint_name = rc.constraint_name and ccu.constraint_schema = rc.constraint_schema where kcu.table_schema = 'public' and kcu.table_name = 'load_packet_sends' order by kcu.column_name;
