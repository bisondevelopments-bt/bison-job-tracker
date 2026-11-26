-- Read-only: newest pipeline deals and who can sign in. Results are encrypted before they reach the public log.
select json_build_object(
 'pipeline', (select json_agg(x) from (select j.id, j.name, j.stage, j.street, j.city, j.home_type, j.closing_date, j.expected_start, j.contract_date, j.created_at, (select name from people where id=j.supervisor_id) sup, (select name from people where id=j.pm_id) pm, d.data->'opts' opts, (select count(*) from documents where job_id=j.id) docs
     from jobs j left join jt_job_details d on d.job_id=j.id where j.stage in ('under_contract','lead') order by j.created_at desc limit 5) x),
 'people', (select json_agg(json_build_object('name',name,'role',role,'login',auth_user_id is not null,'active',active)) from people),
 'notices', (select count(*) from notifications)
) as report;
-- pipeline check
