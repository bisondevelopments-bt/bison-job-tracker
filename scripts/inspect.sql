-- Read-only: connector request log (no links) and links. Results are encrypted before they reach the public log.
select json_build_object(
 'requests', (select json_agg(r order by r.id) from (select id, to_char(at at time zone 'America/Chicago','HH24:MI:SS') t, method, path, status, rpc, ua, accept, auth_header from public.connector_requests order by id desc limit 60) r),
 'links', (select json_agg(json_build_object('who',p.name,'made',k.created_at,'used',k.last_used_at,'off',k.revoked_at)) from public.connector_keys k join public.people p on p.id=k.person_id)
) as report;
-- 201944
