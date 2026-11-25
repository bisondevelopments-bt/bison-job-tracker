-- Read-only: homes that have anything recorded on a vapor-barrier task. Results are encrypted before they reach the public log.
select json_build_object(
 'homes', (select json_agg(json_build_object('home', j.name, 'stage', j.stage, 'opts', d.data->'opts', 'vb', (select json_object_agg(k, v) from jsonb_each(d.data->'state') as e(k, v) where k like '%vapor%')))
   from public.jobs j join public.jt_job_details d on d.job_id = j.id where (d.data->'state')::text like '%vapor%'),
 'templates', (select json_agg(data) from public.jt_docs where coll = 'config' and id = 'templates')
) as report;
-- vapor check
