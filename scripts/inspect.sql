-- Read-only look at the database layout (no data rows). Results are encrypted before they reach the public log. Check: shared role names
select json_build_object(
 'tables', (select json_agg(json_build_object('schema',n.nspname,'table',c.relname,'rls',c.relrowsecurity,'rows_est',c.reltuples::bigint) order by n.nspname,c.relname)
            from pg_class c join pg_namespace n on n.oid=c.relnamespace where c.relkind in ('r','p','v') and n.nspname in ('public')),
 'columns', (select json_agg(json_build_object('t',table_name,'c',column_name,'type',data_type,'null',is_nullable,'def',column_default) order by table_name,ordinal_position)
            from information_schema.columns where table_schema='public'),
 'fks', (select json_agg(json_build_object('t',tc.table_name,'c',kcu.column_name,'ref',ccu.table_name||'.'||ccu.column_name))
            from information_schema.table_constraints tc join information_schema.key_column_usage kcu on tc.constraint_name=kcu.constraint_name and tc.table_schema=kcu.table_schema
            join information_schema.constraint_column_usage ccu on ccu.constraint_name=tc.constraint_name where tc.constraint_type='FOREIGN KEY' and tc.table_schema='public'),
 'policies', (select json_agg(json_build_object('s',schemaname,'t',tablename,'p',policyname,'cmd',cmd,'roles',roles,'using',qual,'check',with_check)) from pg_policies where schemaname in ('public','storage')),
 'anon_grants', (select json_agg(distinct table_name) from information_schema.role_table_grants where grantee='anon' and table_schema='public' and privilege_type='SELECT'),
 'functions', (select json_agg(p.proname||'('||pg_get_function_identity_arguments(p.oid)||') secdef='||p.prosecdef) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'),
 'buckets', (select json_agg(json_build_object('id',id,'public',public)) from storage.buckets),
 'realtime', (select json_agg(schemaname||'.'||tablename) from pg_publication_tables where pubname='supabase_realtime'),
 'users', (select json_agg(json_build_object('email',email,'last',last_sign_in_at)) from auth.users),
 'people', (select json_agg(json_build_object('name',name,'role',role,'work',work_role,'login',auth_user_id is not null)) from public.people),
 'checks', (select json_agg(proname order by proname) from pg_proc where pronamespace='public'::regnamespace and proname in ('my_role','is_admin','can_see_costs','can_edit_books','hub_role','hub_is')),
 'counts', (select json_build_object('jobs',(select count(*) from public.jobs),'jt_docs',(select count(*) from public.jt_docs),'documents',(select count(*) from public.documents))),
 'extensions', (select json_agg(extname) from pg_extension)
) as report;
-- 2026-11-24T03:06:08Z
