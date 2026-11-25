-- Read-only: connector links (no keys), to see whether a link was made and used. Results are encrypted before they reach the public log.
select json_build_object(
 'links', (select json_agg(json_build_object('who',p.name,'made',k.created_at,'used',k.last_used_at,'off',k.revoked_at) order by k.created_at) from public.connector_keys k join public.people p on p.id=k.person_id),
 'people', (select json_agg(json_build_object('name',name,'role',role,'login',auth_user_id is not null,'active',active)) from public.people)
) as report;
-- 2026-11-25T20:10Z
