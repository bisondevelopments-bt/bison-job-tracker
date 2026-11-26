-- Bison hub database: shared core tables + Job Tracker tables, with access by role.
-- Safe to run again: every statement checks before it creates or replaces.
--
-- Shared core (every app reads these):  people, jobs, vendors, buyers, documents, activity_log
-- Job Tracker only (jt_ prefix):         jt_job_details (checklist, permits, notes per job), jt_docs (templates, library, areas, inbox)
--
-- Access roles (people.role):
--   admin             everything; manages people
--   project_manager   jobs, tasks, schedules, files (and job costs once BuildTrack joins)
--   field_supervisor  jobs, tasks, schedules, files; never financial documents or costs
--   accounting        jobs read-only here; owns the books in BuildTrack

create extension if not exists pgcrypto;

-------------------------------------------------------------------------------
-- People
-------------------------------------------------------------------------------
create table if not exists public.people (
  id            uuid primary key default gen_random_uuid(),
  auth_user_id  uuid unique references auth.users (id) on delete set null,
  name          text not null,
  email         text unique,
  phone         text,
  role          text not null default 'project_manager' check (role in ('admin','project_manager','field_supervisor','accounting')),
  work_role     text,            -- Job Tracker screens: Project manager / Field supervisor / Excavation field supervisor / Operations
  active        boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  updated_by    uuid
);
create unique index if not exists people_name_active_idx on public.people (lower(name)) where active;

-- Who is signed in, and what may they do. security definer so the check itself isn't blocked by the rules it enforces.
create or replace function public.hub_me() returns public.people
language sql stable security definer set search_path = public as $$
  select p.* from public.people p where p.auth_user_id = auth.uid() and p.active limit 1
$$;
create or replace function public.my_role() returns text
language sql stable security definer set search_path = public as $$
  select p.role from public.people p where p.auth_user_id = auth.uid() and p.active limit 1
$$;
create or replace function public.hub_person_id() returns uuid
language sql stable security definer set search_path = public as $$
  select p.id from public.people p where p.auth_user_id = auth.uid() and p.active limit 1
$$;
create or replace function public.hub_is(roles text[]) returns boolean
language sql stable as $$ select coalesce(public.my_role() = any(roles), false) $$;
-- The shared checks every Bison app uses (agreed in the hub plan).
create or replace function public.is_admin() returns boolean language sql stable as $$ select coalesce(public.my_role() = 'admin', false) $$;
create or replace function public.can_see_costs() returns boolean language sql stable as $$ select coalesce(public.my_role() in ('admin','project_manager','accounting'), false) $$;
create or replace function public.can_edit_books() returns boolean language sql stable as $$ select coalesce(public.my_role() in ('admin','accounting'), false) $$;

-------------------------------------------------------------------------------
-- Jobs: one row and one ID per lot/home, from under contract through sale
-------------------------------------------------------------------------------
create table if not exists public.jobs (
  id              text primary key default replace(gen_random_uuid()::text, '-', ''),
  stage           text not null default 'active' check (stage in ('lead','under_contract','active','closed','archived')),
  name            text not null,
  subdivision     text,
  street          text,
  city            text,
  state           text,
  zip             text,
  county          text,
  in_city         boolean,
  home_type       text,          -- site / manufactured
  build_days      integer,
  pm_id           uuid references public.people (id) on delete set null,
  supervisor_id   uuid references public.people (id) on delete set null,
  contract_date   date,
  closing_date    date,
  expected_start  date,
  created_at      timestamptz not null default now(),
  created_by      uuid,
  updated_at      timestamptz not null default now(),
  updated_by      uuid
);
create index if not exists jobs_stage_idx on public.jobs (stage);

create table if not exists public.jt_job_details (
  job_id      text primary key references public.jobs (id) on delete cascade,
  data        jsonb not null default '{}'::jsonb,
  updated_at  timestamptz not null default now(),
  updated_by  uuid
);

-------------------------------------------------------------------------------
-- Vendors & subs (also inspectors, utilities, suppliers)
-------------------------------------------------------------------------------
create table if not exists public.vendors (
  id          text primary key default replace(gen_random_uuid()::text, '-', ''),
  company     text,
  contact     text,
  email       text,
  phone       text,
  area        text,
  types       text[] not null default '{}',
  role        text,
  notes       text,
  extra       jsonb not null default '{}'::jsonb,   -- contact people, sort order and other app details
  created_at  timestamptz not null default now(),
  created_by  uuid,
  updated_at  timestamptz not null default now(),
  updated_by  uuid
);

-------------------------------------------------------------------------------
-- Buyers (filled in later by Lead Gen / sales)
-------------------------------------------------------------------------------
create table if not exists public.buyers (
  id          uuid primary key default gen_random_uuid(),
  job_id      text references public.jobs (id) on delete set null,
  name        text not null,
  email       text,
  phone       text,
  notes       text,
  created_at  timestamptz not null default now(),
  created_by  uuid,
  updated_at  timestamptz not null default now(),
  updated_by  uuid
);

-------------------------------------------------------------------------------
-- Documents: one row per file; the file itself is in storage bucket "documents" under asset_id
-------------------------------------------------------------------------------
create table if not exists public.documents (
  id           text primary key,                                  -- <job id>/<doc key> for job files
  job_id       text references public.jobs (id) on delete cascade,
  doc_key      text,                                               -- the app's own key for the file within its job
  asset_id     text not null,
  name         text not null,
  category     text,
  mime_type    text,
  size_bytes   bigint,
  sensitivity  text not null default 'general' check (sensitivity in ('general','financial')),
  added        date,
  sort_order   double precision,
  source       jsonb not null default '{}'::jsonb,   -- email it came from, AI summary, packet it was applied from
  app          text not null default 'job-tracker',
  created_at   timestamptz not null default now(),
  created_by   uuid,
  updated_at   timestamptz not null default now(),
  updated_by   uuid
);
alter table public.documents add column if not exists doc_key text;
create index if not exists documents_job_idx on public.documents (job_id);
create index if not exists documents_asset_idx on public.documents (asset_id);

-------------------------------------------------------------------------------
-- Job Tracker's other records (templates, packet library, areas, inbox, settings)
-------------------------------------------------------------------------------
create table if not exists public.jt_docs (
  coll text not null, id text not null, data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(), updated_by uuid, primary key (coll, id)
);
-- Records that now live in the shared tables. (Only test copies were ever stored here.)
delete from public.jt_docs where coll in ('jobs','pipeline','contacts') or (coll = 'config' and id = 'team');

-------------------------------------------------------------------------------
-- Stamps: when and by whom each row last changed
-------------------------------------------------------------------------------
create or replace function public.hub_stamp() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  new.updated_by := auth.uid();
  return new;
end $$;
create or replace function public.hub_stamp_created() returns trigger
language plpgsql as $$
begin
  new.created_by := coalesce(new.created_by, auth.uid());
  return new;
end $$;

-------------------------------------------------------------------------------
-- Activity log: who changed what, on every shared and Job Tracker table
-------------------------------------------------------------------------------
create table if not exists public.activity_log (
  id          bigint generated always as identity primary key,
  at          timestamptz not null default now(),
  actor       uuid,           -- auth user
  actor_name  text,
  app         text not null default 'job-tracker',
  tbl         text not null,
  row_id      text,
  action      text not null,  -- insert / update / delete
  changed     text[]          -- which fields changed (two levels deep inside data/extra)
);
create index if not exists activity_row_idx on public.activity_log (tbl, row_id, at desc);

create or replace function public.hub_changed_keys(a jsonb, b jsonb) returns text[]
language sql immutable as $$
  with k as (
    select key from jsonb_object_keys(case when jsonb_typeof(a) = 'object' then a else '{}'::jsonb end) key
    union select key from jsonb_object_keys(case when jsonb_typeof(b) = 'object' then b else '{}'::jsonb end) key
  )
  select coalesce(array_agg(r order by r), '{}') from (
    select case
      when jsonb_typeof(a->key) = 'object' and jsonb_typeof(b->key) = 'object' then key || '.' || sub
      else key end as r
    from k
    left join lateral (
      select s as sub from (
        select s from jsonb_object_keys(case when jsonb_typeof(a->key) = 'object' then a->key else '{}'::jsonb end) s
        union select s from jsonb_object_keys(case when jsonb_typeof(b->key) = 'object' then b->key else '{}'::jsonb end) s
      ) x where jsonb_typeof(a->key) = 'object' and jsonb_typeof(b->key) = 'object'
        and (a->key->s) is distinct from (b->key->s)
    ) subs on true
    where (a->key) is distinct from (b->key)
      and not coalesce(jsonb_typeof(a->key) = 'object' and jsonb_typeof(b->key) = 'object' and subs.sub is null, false)  -- coalesce: a field that's new (or removed) counts as changed
      and key not in ('updated_at','updated_by')
  ) t
$$;

create or replace function public.hub_log() returns trigger
language plpgsql security definer set search_path = public as $$
declare o jsonb := case when tg_op <> 'INSERT' then to_jsonb(old) end;
        n jsonb := case when tg_op <> 'DELETE' then to_jsonb(new) end;
        r jsonb := coalesce(n, o); rid text; ch text[];
begin
  rid := case tg_table_name when 'jt_docs' then (r->>'coll') || '/' || (r->>'id')
                            when 'jt_job_details' then r->>'job_id'
                            else r->>'id' end;
  if tg_op = 'UPDATE' then
    ch := public.hub_changed_keys(o - 'data' - 'extra', n - 'data' - 'extra')
       || public.hub_changed_keys(o->'data', n->'data')
       || public.hub_changed_keys(o->'extra', n->'extra');
    if ch = '{}' then return null; end if;
  end if;
  insert into public.activity_log (actor, actor_name, tbl, row_id, action, changed)
    values (auth.uid(), (select name from public.people where auth_user_id = auth.uid() limit 1),
            tg_table_name, rid, lower(tg_op), ch);
  return null;
end $$;

do $$
declare t text;
begin
  foreach t in array array['people','jobs','jt_job_details','vendors','buyers','documents','jt_docs'] loop
    execute format('drop trigger if exists %I_stamp on public.%I', t, t);
    execute format('create trigger %I_stamp before insert or update on public.%I for each row execute function public.hub_stamp()', t, t);
    execute format('drop trigger if exists %I_created on public.%I', t, t);
    if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = t and column_name = 'created_by') then
      execute format('create trigger %I_created before insert on public.%I for each row execute function public.hub_stamp_created()', t, t);
    end if;
    execute format('drop trigger if exists %I_log on public.%I', t, t);
    execute format('create trigger %I_log after insert or update or delete on public.%I for each row execute function public.hub_log()', t, t);
  end loop;
end $$;

-------------------------------------------------------------------------------
-- Merge helpers (two people editing different parts of one job never overwrite each other)
-------------------------------------------------------------------------------
create or replace function public.jt_deep_merge(a jsonb, b jsonb) returns jsonb
language plpgsql immutable as $$
declare k text; v jsonb; r jsonb;
begin
  if a is null or jsonb_typeof(a) <> 'object' or b is null or jsonb_typeof(b) <> 'object' then return b; end if;
  r := a;
  for k, v in select * from jsonb_each(b) loop
    if jsonb_typeof(v) = 'object' and jsonb_typeof(r -> k) = 'object' then
      r := jsonb_set(r, array[k], public.jt_deep_merge(r -> k, v));
    else
      r := jsonb_set(r, array[k], v, true);
    end if;
  end loop;
  return r;
end $$;

-- Rules still apply to these (security invoker): a role that can't edit gets an error.
create or replace function public.jt_patch(p_coll text, p_id text, p_patch jsonb) returns jsonb
language plpgsql security invoker as $$
declare out jsonb;
begin
  insert into public.jt_docs as d (coll, id, data) values (p_coll, p_id, public.jt_deep_merge('{}'::jsonb, p_patch))
  on conflict (coll, id) do update set data = public.jt_deep_merge(d.data, excluded.data)
  returning data into out;
  return out;
end $$;

create or replace function public.jt_patch_details(p_job text, p_patch jsonb) returns jsonb
language plpgsql security invoker as $$
declare out jsonb;
begin
  insert into public.jt_job_details as d (job_id, data) values (p_job, public.jt_deep_merge('{}'::jsonb, p_patch))
  on conflict (job_id) do update set data = public.jt_deep_merge(d.data, excluded.data)
  returning data into out;
  return out;
end $$;

create or replace function public.vendor_patch_extra(p_id text, p_patch jsonb) returns jsonb
language plpgsql security invoker as $$
declare out jsonb;
begin
  update public.vendors set extra = public.jt_deep_merge(extra, p_patch) where id = p_id returning extra into out;
  return out;
end $$;

-------------------------------------------------------------------------------
-- Access rules
-------------------------------------------------------------------------------
do $$
declare t text; p record;
begin
  foreach t in array array['people','jobs','jt_job_details','vendors','buyers','documents','jt_docs','activity_log'] loop
    execute format('alter table public.%I enable row level security', t);
    for p in select policyname from pg_policies where schemaname = 'public' and tablename = t loop
      execute format('drop policy %I on public.%I', p.policyname, t);
    end loop;
  end loop;
end $$;

-- people: everyone on staff sees the team list; only admins add, change or remove people
create policy people_read  on public.people for select to authenticated using (public.my_role() is not null);
create policy people_write on public.people for all    to authenticated using (public.is_admin()) with check (public.is_admin());

-- jobs and the Job Tracker's per-job details: staff read; admins, PMs and field supervisors edit; only admins and PMs delete
create policy jobs_read   on public.jobs for select to authenticated using (public.my_role() is not null);
create policy jobs_insert on public.jobs for insert to authenticated with check (public.hub_is('{admin,project_manager,field_supervisor}'));
create policy jobs_update on public.jobs for update to authenticated using (public.hub_is('{admin,project_manager,field_supervisor}')) with check (public.hub_is('{admin,project_manager,field_supervisor}'));
create policy jobs_delete on public.jobs for delete to authenticated using (public.hub_is('{admin,project_manager}'));

create policy jtd_read  on public.jt_job_details for select to authenticated using (public.my_role() is not null);
create policy jtd_write on public.jt_job_details for all    to authenticated using (public.hub_is('{admin,project_manager,field_supervisor}')) with check (public.hub_is('{admin,project_manager,field_supervisor}'));

-- vendors: staff read; all staff edit (accounting keeps vendor details for bills)
create policy vendors_read  on public.vendors for select to authenticated using (public.my_role() is not null);
create policy vendors_write on public.vendors for all    to authenticated using (public.hub_is('{admin,project_manager,field_supervisor,accounting}')) with check (public.hub_is('{admin,project_manager,field_supervisor,accounting}'));

-- buyers: staff read; admins, PMs and accounting edit
create policy buyers_read  on public.buyers for select to authenticated using (public.my_role() is not null);
create policy buyers_write on public.buyers for all    to authenticated using (public.can_see_costs()) with check (public.can_see_costs());

-- documents: field supervisors never see financial ones; only admins, PMs and accounting add or change financial ones
create policy docs_read on public.documents for select to authenticated
  using (public.my_role() is not null and (sensitivity = 'general' or public.can_see_costs()));
create policy docs_write on public.documents for all to authenticated
  using      (case when sensitivity = 'financial' then public.can_see_costs() else public.hub_is('{admin,project_manager,field_supervisor}') end)
  with check (case when sensitivity = 'financial' then public.can_see_costs() else public.hub_is('{admin,project_manager,field_supervisor}') end);

-- Job Tracker records: staff read; admins, PMs and field supervisors edit
create policy jtdocs_read  on public.jt_docs for select to authenticated using (public.my_role() is not null);
create policy jtdocs_write on public.jt_docs for all    to authenticated using (public.hub_is('{admin,project_manager,field_supervisor}')) with check (public.hub_is('{admin,project_manager,field_supervisor}'));

-- activity log: admins read; written only by the database itself
create policy activity_read on public.activity_log for select to authenticated using (public.is_admin());

-- The old shared-login check is no longer used.
drop function if exists public.jt_allowed() cascade;

-------------------------------------------------------------------------------
-- Notifications: notices for people, posted by people or by Claude skills.
-- A notice goes to specific people and/or roles ('everyone', 'admin' = operations, 'project_manager',
-- 'field_supervisor', 'accounting'). Cost notices are never visible to field supervisors (only to
-- roles that can see costs), even if someone addresses one to them. Each person clears ("Got it")
-- a notice for themselves only (notification_reads).
-------------------------------------------------------------------------------
create table if not exists public.notifications (
  id             uuid primary key default gen_random_uuid(),
  title          text not null check (length(title) between 1 and 200),
  detail         text,
  job_id         text references public.jobs (id) on delete set null,
  attachment     jsonb,                                  -- {document_id, asset_id, name, type}
  to_people      uuid[] not null default '{}',
  to_roles       text[] not null default '{}' check (to_roles <@ array['everyone','admin','project_manager','field_supervisor','accounting']::text[]),
  urgent         boolean not null default false,
  cost           boolean not null default false,
  source         text,                                   -- the skill that posted it, e.g. 'Under-contract handoff'
  posted_by      uuid references public.people (id) on delete set null default public.hub_person_id(),
  posted_by_name text,
  created_at     timestamptz not null default now(),
  check (cardinality(to_people) > 0 or cardinality(to_roles) > 0)
);
create index if not exists notifications_created_idx on public.notifications (created_at desc);
create table if not exists public.notification_reads (
  notification_id uuid not null references public.notifications (id) on delete cascade,
  person_id       uuid not null references public.people (id) on delete cascade default public.hub_person_id(),
  cleared_at      timestamptz not null default now(),
  primary key (notification_id, person_id)
);
alter table public.notifications enable row level security;
alter table public.notification_reads enable row level security;
grant select, insert, delete on public.notifications to authenticated;
grant select, insert, delete on public.notification_reads to authenticated;

-- is this notice addressed to me? (used by the rules below and by the app)
create or replace function public.notif_for_me(n public.notifications) returns boolean
language sql stable as $$
  select (not n.cost or public.can_see_costs())
     and ('everyone' = any(n.to_roles) or public.my_role() = any(n.to_roles) or public.hub_person_id() = any(n.to_people))
$$;

drop policy if exists notif_read on public.notifications;
create policy notif_read on public.notifications for select to authenticated
  using ((not cost or public.can_see_costs()) and (public.notif_for_me(notifications) or posted_by = public.hub_person_id() or public.is_admin()));
drop policy if exists notif_post on public.notifications;
create policy notif_post on public.notifications for insert to authenticated
  with check (public.my_role() is not null and posted_by = public.hub_person_id() and (not cost or public.can_see_costs()));
drop policy if exists notif_remove on public.notifications;
create policy notif_remove on public.notifications for delete to authenticated
  using (public.is_admin() or posted_by = public.hub_person_id());

drop policy if exists notif_reads_own on public.notification_reads;
create policy notif_reads_own on public.notification_reads for all to authenticated
  using (person_id = public.hub_person_id()) with check (person_id = public.hub_person_id());

-- the poster's name is filled in by the database, not trusted from the caller
create or replace function public.notif_stamp() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  new.posted_by := public.hub_person_id();
  new.posted_by_name := coalesce((select name from public.people where id = new.posted_by), new.posted_by_name);
  new.created_at := now();
  return new;
end $$;
drop trigger if exists notifications_stamp on public.notifications;
create trigger notifications_stamp before insert on public.notifications for each row execute function public.notif_stamp();

-- Automatic notice: a new lot under contract tells the field supervisors (address, closing, home type,
-- expected start, PM). Fires when a pipeline deal is added (in the app, by a skill or an import) or a lead
-- moves to under contract; at most one per deal. Plans added to the deal later are attached to it.
create or replace function public.notif_new_deal(p_job text) returns void
language plpgsql security definer set search_path = public as $$
declare j public.jobs; d text; plans record; lines text[] := '{}';
begin
  select * into j from public.jobs where id = p_job;
  if j.id is null or j.stage <> 'under_contract' then return; end if;
  if exists (select 1 from public.notifications where job_id = j.id and source = 'New deal') then return; end if;
  if j.street is not null and j.street <> j.name then lines := lines || ('Address: ' || j.street || coalesce(', ' || j.city, '')); end if;
  lines := lines || concat_ws(' · ',
    'Closing ' || coalesce(to_char(j.closing_date, 'Mon FMDD'), 'not set'),
    case j.home_type when 'mfg' then 'Doublewide' when 'site' then 'Site-built' else 'Home type not set' end);
  lines := lines || concat_ws(' · ',
    'Expected start ' || coalesce(to_char(j.expected_start, 'Mon FMDD'), 'not set'),
    'PM ' || (select name from public.people where id = j.pm_id),
    'Supervisor ' || (select name from public.people where id = j.supervisor_id));
  select id, asset_id, name, mime_type into plans from public.documents
    where job_id = j.id and category = 'Plans' and sensitivity = 'general' order by added nulls last limit 1;
  insert into public.notifications (title, detail, job_id, attachment, to_roles, source, posted_by_name)
  values ('New lot under contract: ' || j.name, array_to_string(lines, E'\n'), j.id,
    case when plans.id is null then null else jsonb_build_object('document_id', plans.id, 'asset_id', plans.asset_id, 'name', plans.name, 'type', plans.mime_type) end,
    array['field_supervisor'], 'New deal', 'Job Tracker');
end $$;
create or replace function public.notif_deal_trg() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.stage = 'under_contract' and (tg_op = 'INSERT' or old.stage is distinct from new.stage) then perform public.notif_new_deal(new.id); end if;
  return new;
end $$;
drop trigger if exists jobs_new_deal_notice on public.jobs;
create trigger jobs_new_deal_notice after insert or update of stage on public.jobs for each row execute function public.notif_deal_trg();
create or replace function public.notif_plans_trg() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.category = 'Plans' and new.sensitivity = 'general' then
    update public.notifications set attachment = jsonb_build_object('document_id', new.id, 'asset_id', new.asset_id, 'name', new.name, 'type', new.mime_type)
     where job_id = new.job_id and source = 'New deal' and attachment is null;
  end if;
  return new;
end $$;
drop trigger if exists documents_plans_notice on public.documents;
create trigger documents_plans_notice after insert on public.documents for each row execute function public.notif_plans_trg();

-- keep it tidy: notices go away after 120 days
delete from public.notifications where created_at < now() - interval '120 days';

-------------------------------------------------------------------------------
-- Live updates
-------------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['people','jobs','jt_job_details','vendors','documents','jt_docs','notifications','notification_reads'] loop
    execute format('alter table public.%I replica identity full', t);
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;

-------------------------------------------------------------------------------
-- File storage: bucket "documents" (shared). Financial files are hidden from field supervisors.
-------------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit) values ('documents', 'documents', false, 26214400)
  on conflict (id) do nothing;

do $$
declare p record;
begin
  for p in select policyname from pg_policies where schemaname = 'storage' and tablename = 'objects' and (policyname like 'jt_files_%' or policyname like 'hub_files_%') loop
    execute format('drop policy %I on storage.objects', p.policyname);
  end loop;
end $$;
-- Looks past the reader's own rules on purpose: a field supervisor can't see financial rows,
-- so without this they'd look like "not financial" and the file would open.
create or replace function public.hub_asset_financial(p_asset text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.documents d where d.asset_id = p_asset and d.sensitivity = 'financial')
$$;
create policy hub_files_read on storage.objects for select to authenticated using (
  bucket_id = 'documents' and public.my_role() is not null
  and (public.can_see_costs() or not public.hub_asset_financial(storage.objects.name)));
create policy hub_files_insert on storage.objects for insert to authenticated with check (bucket_id = 'documents' and public.hub_is('{admin,project_manager,field_supervisor,accounting}'));
create policy hub_files_update on storage.objects for update to authenticated using (bucket_id = 'documents' and public.hub_is('{admin,project_manager,field_supervisor,accounting}'));
create policy hub_files_delete on storage.objects for delete to authenticated using (bucket_id = 'documents' and public.hub_is('{admin,project_manager}'));

-------------------------------------------------------------------------------
-- First admin: the existing shared office login becomes an admin until real admins are set up.
-------------------------------------------------------------------------------
create or replace function public.hub_bootstrap(p_email text) returns text
language plpgsql security definer set search_path = public as $$
declare u uuid;
begin
  if exists (select 1 from public.people where role = 'admin' and active and auth_user_id is not null) then return 'admins exist'; end if;
  select id into u from auth.users where lower(email) = lower(p_email);
  if u is null then return 'no such login'; end if;
  insert into public.people (auth_user_id, name, email, role, work_role)
    values (u, 'Bison Office (shared)', lower(p_email), 'admin', 'Operations')
    on conflict (email) do update set auth_user_id = excluded.auth_user_id, role = 'admin', active = true;
  return 'bootstrap admin set';
end $$;
revoke execute on function public.hub_bootstrap(text) from public, anon, authenticated;

-------------------------------------------------------------------------------
-- Connector links (Claude / Grok). One private link per person; only a scrambled copy (SHA-256) is stored.
-- Nobody reads this table directly: the connector server checks links with full access, then works as that person.
create table if not exists public.connector_keys (
  id           uuid primary key default gen_random_uuid(),
  person_id    uuid not null references public.people (id) on delete cascade,
  token_hash   text not null unique,
  created_at   timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at   timestamptz
);
create index if not exists connector_keys_person_idx on public.connector_keys (person_id) where revoked_at is null;
alter table public.connector_keys enable row level security;
revoke all on public.connector_keys from anon, authenticated;

-- Connector request log for troubleshooting (no links, no content). Kept 14 days.
create table if not exists public.connector_requests (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  method text, path text, status int, rpc text, ua text, accept text, auth_header boolean
);
alter table public.connector_requests enable row level security;
revoke all on public.connector_requests from anon, authenticated;
delete from public.connector_requests where at < now() - interval '14 days';

-- Upgrade from the first version, which called project managers 'pm'.
alter table public.people drop constraint if exists people_role_check;
update public.people set role = 'project_manager' where role = 'pm';
alter table public.people alter column role set default 'project_manager';
alter table public.people add constraint people_role_check check (role in ('admin','project_manager','field_supervisor','accounting'));

-- Renamed to my_role(); nothing uses the old name any more.
drop function if exists public.hub_role();
