-- Bison Job Tracker: database setup.
-- Safe to run again: every statement checks before it creates.
-- Everything is prefixed "jt" so it never touches BuildTrack's tables.

-- 1. One table holds every record the app keeps (homes, contacts, pipeline, team, templates, ...).
--    coll = which list it belongs to ("jobs", "contacts", "config", ...), id = the record's id,
--    data = the record itself.
create table if not exists public.jt_docs (
  coll        text        not null,
  id          text        not null,
  data        jsonb       not null default '{}'::jsonb,
  updated_at  timestamptz not null default now(),
  updated_by  uuid        default auth.uid(),
  primary key (coll, id)
);
create index if not exists jt_docs_coll_idx on public.jt_docs (coll);

-- 2. Only signed-in users flagged for the Job Tracker can see or change its data.
--    (A BuildTrack login without the flag sees nothing here.)
create or replace function public.jt_allowed() returns boolean
language sql stable as $$
  select coalesce((auth.jwt() -> 'app_metadata' ->> 'jt')::boolean, false)
$$;

alter table public.jt_docs enable row level security;
drop policy if exists jt_docs_all on public.jt_docs;
create policy jt_docs_all on public.jt_docs
  for all to authenticated
  using (public.jt_allowed())
  with check (public.jt_allowed());

-- 3. Deep merge, so two people editing different parts of one home never overwrite each other.
create or replace function public.jt_deep_merge(a jsonb, b jsonb) returns jsonb
language plpgsql immutable as $$
declare k text; v jsonb; r jsonb;
begin
  if a is null or jsonb_typeof(a) <> 'object' or b is null or jsonb_typeof(b) <> 'object' then
    return b;
  end if;
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

create or replace function public.jt_patch(p_coll text, p_id text, p_patch jsonb) returns jsonb
language plpgsql security invoker as $$
declare out jsonb;
begin
  if not public.jt_allowed() then raise exception 'not allowed' using errcode = '42501'; end if;
  insert into public.jt_docs as d (coll, id, data, updated_at, updated_by)
    values (p_coll, p_id, public.jt_deep_merge('{}'::jsonb, p_patch), now(), auth.uid())
  on conflict (coll, id) do update
    set data = public.jt_deep_merge(d.data, excluded.data), updated_at = now(), updated_by = auth.uid()
  returning data into out;
  return out;
end $$;

-- 4. Live updates: every open copy of the app hears changes as they happen.
alter table public.jt_docs replica identity full;
do $$ begin
  if not exists (select 1 from pg_publication_tables
                 where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'jt_docs') then
    alter publication supabase_realtime add table public.jt_docs;
  end if;
end $$;

-- 5. Private file storage for permits, plans, photos.
insert into storage.buckets (id, name, public, file_size_limit)
  values ('jt-files', 'jt-files', false, 26214400)
  on conflict (id) do nothing;

drop policy if exists jt_files_read   on storage.objects;
drop policy if exists jt_files_insert on storage.objects;
drop policy if exists jt_files_update on storage.objects;
drop policy if exists jt_files_delete on storage.objects;
create policy jt_files_read   on storage.objects for select to authenticated using      (bucket_id = 'jt-files' and public.jt_allowed());
create policy jt_files_insert on storage.objects for insert to authenticated with check (bucket_id = 'jt-files' and public.jt_allowed());
create policy jt_files_update on storage.objects for update to authenticated using      (bucket_id = 'jt-files' and public.jt_allowed());
create policy jt_files_delete on storage.objects for delete to authenticated using      (bucket_id = 'jt-files' and public.jt_allowed());
