-- =============================================================================
-- Migration: 20261118000016_project_activity.sql
-- Purpose: Project activity log. Every entry records the project, the version
--   (if any), WHO did it (auth.uid() at the time) and WHEN (server time).
--   Entries are written only by database triggers, so every path (screens,
--   functions, admin edits) is covered and clients cannot add, edit or delete
--   them. Anyone who can view the project can read its activity.
--
--   category  | actions
--   project   | project_created, details_changed
--   team      | pm_assigned, estimator_added, estimator_removed
--   quotation | quotation_imported, quotation_reimported
--   version   | revision_started, version_submitted, version_approved,
--             | version_changes_requested
--   hardware  | lines_edited (grouped per person per version, 30 min),
--             | markup_changed, pm_remarks_updated
--
-- Past history is rebuilt from existing data (project creation, estimator
-- assignments, quotation uploads, revisions and approval events).
-- =============================================================================

create table if not exists public.project_activity (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  version_id uuid null references public.project_versions(id) on delete set null,
  actor_id uuid null references public.profiles(id) on delete set null,
  category text not null check (category in ('project', 'team', 'quotation', 'version', 'hardware')),
  action text not null,
  summary text not null,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  -- Grouped entries (lines_edited) move forward as more edits are added.
  updated_at timestamptz not null default now()
);

create index if not exists idx_project_activity_project_time
  on public.project_activity (project_id, updated_at desc);

alter table public.project_activity enable row level security;
alter table public.project_activity force row level security;

drop policy if exists "project_activity_select_viewers" on public.project_activity;
create policy "project_activity_select_viewers"
  on public.project_activity for select to authenticated
  using (public.can_view_project(project_id));

revoke all on public.project_activity from anon, authenticated;
grant select on public.project_activity to authenticated;

-- -----------------------------------------------------------------------------
-- Helpers (internal)
-- -----------------------------------------------------------------------------
create or replace function public.profile_name(p_user_id uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(nullif(btrim(full_name), ''), 'Unknown user')
  from public.profiles where id = p_user_id;
$$;

create or replace function public.log_project_activity(
  p_project_id uuid,
  p_version_id uuid,
  p_category text,
  p_action text,
  p_summary text,
  p_details jsonb default '{}'::jsonb,
  p_actor uuid default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Skip while the project itself is being deleted (cascades fire triggers).
  if not exists (select 1 from public.projects where id = p_project_id) then
    return;
  end if;
  insert into public.project_activity (project_id, version_id, actor_id, category, action, summary, details)
  values (
    p_project_id,
    case when exists (select 1 from public.project_versions where id = p_version_id) then p_version_id end,
    coalesce(p_actor, auth.uid()),
    p_category, p_action, p_summary, coalesce(p_details, '{}'::jsonb)
  );
end;
$$;

revoke all on function public.profile_name(uuid) from public, anon, authenticated;
revoke all on function public.log_project_activity(uuid, uuid, text, text, text, jsonb, uuid) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- Project: created, details changed, PM assigned
-- -----------------------------------------------------------------------------
create or replace function public.activity_projects()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_changes jsonb := '[]'::jsonb;
begin
  if tg_op = 'INSERT' then
    perform public.log_project_activity(new.id, null, 'project', 'project_created',
      'created the project',
      jsonb_build_object('reference_no', new.reference_no, 'name', new.name,
                         'client', new.client, 'site', new.site),
      new.created_by);
    if new.assigned_pm is not null and new.assigned_pm is distinct from new.created_by then
      perform public.log_project_activity(new.id, null, 'team', 'pm_assigned',
        'made ' || public.profile_name(new.assigned_pm) || ' the PM',
        jsonb_build_object('to', public.profile_name(new.assigned_pm), 'to_id', new.assigned_pm),
        new.created_by);
    end if;
    return new;
  end if;

  if new.reference_no is distinct from old.reference_no then
    v_changes := v_changes || jsonb_build_object('label', 'Reference No.', 'from', old.reference_no, 'to', new.reference_no);
  end if;
  if new.name is distinct from old.name then
    v_changes := v_changes || jsonb_build_object('label', 'Project Name', 'from', old.name, 'to', new.name);
  end if;
  if new.client is distinct from old.client then
    v_changes := v_changes || jsonb_build_object('label', 'Client', 'from', old.client, 'to', new.client);
  end if;
  if new.site is distinct from old.site then
    v_changes := v_changes || jsonb_build_object('label', 'Site', 'from', old.site, 'to', new.site);
  end if;
  if new.status is distinct from old.status then
    v_changes := v_changes || jsonb_build_object('label', 'Status', 'from', old.status, 'to', new.status);
  end if;

  if jsonb_array_length(v_changes) > 0 then
    perform public.log_project_activity(new.id, null, 'project', 'details_changed',
      'edited the project details', jsonb_build_object('changes', v_changes));
  end if;

  if new.assigned_pm is distinct from old.assigned_pm then
    perform public.log_project_activity(new.id, null, 'team', 'pm_assigned',
      case when new.assigned_pm is null then 'removed the PM'
           else 'made ' || public.profile_name(new.assigned_pm) || ' the PM' end,
      jsonb_build_object(
        'from', case when old.assigned_pm is not null then public.profile_name(old.assigned_pm) end,
        'to', case when new.assigned_pm is not null then public.profile_name(new.assigned_pm) end,
        'to_id', new.assigned_pm));
  end if;
  return new;
end;
$$;

drop trigger if exists trg_activity_projects on public.projects;
create trigger trg_activity_projects
  after insert or update on public.projects
  for each row execute function public.activity_projects();

-- -----------------------------------------------------------------------------
-- Team: estimator added / removed
-- -----------------------------------------------------------------------------
create or replace function public.activity_project_estimators()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    perform public.log_project_activity(new.project_id, null, 'team', 'estimator_added',
      'added ' || public.profile_name(new.estimator_id) || ' as an estimator',
      jsonb_build_object('user', public.profile_name(new.estimator_id), 'user_id', new.estimator_id),
      coalesce(auth.uid(), new.assigned_by));
    return new;
  end if;
  perform public.log_project_activity(old.project_id, null, 'team', 'estimator_removed',
    'removed ' || public.profile_name(old.estimator_id) || ' as an estimator',
    jsonb_build_object('user', public.profile_name(old.estimator_id), 'user_id', old.estimator_id));
  return old;
end;
$$;

drop trigger if exists trg_activity_project_estimators on public.project_estimators;
create trigger trg_activity_project_estimators
  after insert or delete on public.project_estimators
  for each row execute function public.activity_project_estimators();

-- -----------------------------------------------------------------------------
-- Versions: revision started, quotation (re)imported, superseded, markup
-- -----------------------------------------------------------------------------
create or replace function public.activity_project_versions()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_file text;
  v_groups integer;
  v_previous integer;
begin
  if tg_op = 'INSERT' then
    if new.version_no > 1 then
      select max(version_no) into v_previous
      from public.project_versions
      where project_id = new.project_id and version_no < new.version_no;
      perform public.log_project_activity(new.project_id, new.id, 'version', 'revision_started',
        'started v' || new.version_no || coalesce(' from v' || v_previous, ''),
        jsonb_build_object('version_no', new.version_no, 'from_version_no', v_previous),
        coalesce(auth.uid(), new.created_by));
    end if;
    return new;
  end if;

  -- Quotation linked: first import, or a re-import.
  if new.upload_id is distinct from old.upload_id and new.upload_id is not null then
    select original_filename into v_file from public.quotation_uploads where id = new.upload_id;
    select count(*) into v_groups from public.door_groups where version_id = new.id;
    if old.upload_id is null and new.version_no = 1 then
      perform public.log_project_activity(new.project_id, new.id, 'quotation', 'quotation_imported',
        'imported the quotation (v1)',
        jsonb_build_object('file', v_file, 'door_groups', v_groups, 'version_no', 1));
    else
      perform public.log_project_activity(new.project_id, new.id, 'quotation', 'quotation_reimported',
        're-imported the quotation into v' || new.version_no,
        jsonb_build_object('file', v_file, 'door_groups', v_groups, 'version_no', new.version_no));
    end if;
  end if;

  if new.markup_pct is distinct from old.markup_pct then
    perform public.log_project_activity(new.project_id, new.id, 'hardware', 'markup_changed',
      'changed the markup on v' || new.version_no,
      jsonb_build_object('from', old.markup_pct, 'to', new.markup_pct, 'version_no', new.version_no));
  end if;
  return new;
end;
$$;

drop trigger if exists trg_activity_project_versions on public.project_versions;
create trigger trg_activity_project_versions
  after insert or update on public.project_versions
  for each row execute function public.activity_project_versions();

-- -----------------------------------------------------------------------------
-- Approval events: submitted / approved / changes requested
-- -----------------------------------------------------------------------------
create or replace function public.activity_approval_events()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_version public.project_versions;
begin
  select * into v_version from public.project_versions where id = new.version_id;
  if v_version.id is null then
    return new;
  end if;
  perform public.log_project_activity(v_version.project_id, v_version.id, 'version',
    case new.action when 'submit' then 'version_submitted'
                    when 'approve' then 'version_approved'
                    else 'version_changes_requested' end,
    case new.action when 'submit' then 'submitted v' || v_version.version_no || ' for review'
                    when 'approve' then 'approved v' || v_version.version_no
                    else 'requested changes on v' || v_version.version_no end,
    jsonb_build_object(
      'version_no', v_version.version_no,
      'comment', nullif(new.comment, ''),
      'from', case new.action when 'submit' then 'draft' else 'submitted' end,
      'to', case new.action when 'submit' then 'submitted'
                            when 'approve' then 'approved'
                            else 'changes_requested' end),
    new.actor);
  return new;
end;
$$;

drop trigger if exists trg_activity_approval_events on public.approval_events;
create trigger trg_activity_approval_events
  after insert on public.approval_events
  for each row execute function public.activity_approval_events();

-- -----------------------------------------------------------------------------
-- Hardware lines: grouped per person per version (30 minutes)
--   Lines written together with their door group in the same transaction
--   (quotation import, re-import, new revision) are part of those events and
--   are not logged as edits. A group created in this transaction has
--   created_at = now() (the transaction's start time).
-- -----------------------------------------------------------------------------
create or replace function public.activity_project_lines()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_group_id uuid := coalesce(new.group_id, old.group_id);
  v_version public.project_versions;
  v_group_created timestamptz;
  v_key text := case tg_op when 'INSERT' then 'added' when 'DELETE' then 'removed' else 'edited' end;
  v_existing uuid;
begin
  select dg.created_at into v_group_created from public.door_groups dg where dg.id = v_group_id;
  -- Group gone (being deleted) or created in this same transaction: not an edit.
  if v_group_created is null or v_group_created = now() then
    return coalesce(new, old);
  end if;

  select pv.* into v_version
  from public.project_versions pv
  join public.door_groups dg on dg.version_id = pv.id
  where dg.id = v_group_id;

  select id into v_existing
  from public.project_activity
  where project_id = v_version.project_id
    and version_id = v_version.id
    and action = 'lines_edited'
    and actor_id is not distinct from auth.uid()
    and updated_at > now() - interval '30 minutes'
  order by updated_at desc
  limit 1;

  if v_existing is null then
    perform public.log_project_activity(v_version.project_id, v_version.id, 'hardware', 'lines_edited',
      'updated hardware lines in v' || v_version.version_no,
      jsonb_build_object('version_no', v_version.version_no, 'edited', 0, 'added', 0, 'removed', 0)
        || jsonb_build_object(v_key, 1));
  else
    update public.project_activity
    set details = jsonb_set(details, array[v_key], to_jsonb(coalesce((details->>v_key)::integer, 0) + 1)),
        updated_at = now()
    where id = v_existing;
  end if;
  return coalesce(new, old);
end;
$$;

drop trigger if exists trg_activity_project_lines on public.project_lines;
create trigger trg_activity_project_lines
  after insert or update or delete on public.project_lines
  for each row execute function public.activity_project_lines();

-- -----------------------------------------------------------------------------
-- PM remarks
-- -----------------------------------------------------------------------------
create or replace function public.activity_pm_remarks()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_version public.project_versions;
begin
  if new.pm_remarks is not distinct from old.pm_remarks then
    return new;
  end if;
  select * into v_version from public.project_versions where id = new.version_id;
  perform public.log_project_activity(v_version.project_id, v_version.id, 'hardware', 'pm_remarks_updated',
    'updated PM remarks on ' || coalesce(nullif(new.room_name, ''), 'a door group') || ' (v' || v_version.version_no || ')',
    jsonb_build_object('version_no', v_version.version_no, 'room', new.room_name,
                       'from', nullif(old.pm_remarks, ''), 'to', nullif(new.pm_remarks, '')));
  return new;
end;
$$;

drop trigger if exists trg_activity_pm_remarks on public.door_groups;
create trigger trg_activity_pm_remarks
  after update of pm_remarks on public.door_groups
  for each row execute function public.activity_pm_remarks();

-- -----------------------------------------------------------------------------
-- Backfill past history from existing data (only if nothing is logged yet)
-- -----------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from public.project_activity) then
    return;
  end if;

  insert into public.project_activity (project_id, actor_id, category, action, summary, details, created_at, updated_at)
  select p.id, p.created_by, 'project', 'project_created', 'created the project',
         jsonb_build_object('reference_no', p.reference_no, 'name', p.name, 'client', p.client, 'site', p.site),
         p.created_at, p.created_at
  from public.projects p;

  insert into public.project_activity (project_id, actor_id, category, action, summary, details, created_at, updated_at)
  select pe.project_id, pe.assigned_by, 'team', 'estimator_added',
         'added ' || coalesce(nullif(btrim(pr.full_name), ''), 'Unknown user') || ' as an estimator',
         jsonb_build_object('user', pr.full_name, 'user_id', pe.estimator_id),
         pe.created_at, pe.created_at
  from public.project_estimators pe
  join public.profiles pr on pr.id = pe.estimator_id;

  -- Each quotation upload: the first per project is the import, later ones re-imports.
  insert into public.project_activity (project_id, version_id, actor_id, category, action, summary, details, created_at, updated_at)
  select u.project_id, v.id, u.uploaded_by, 'quotation',
         case when u.rn = 1 then 'quotation_imported' else 'quotation_reimported' end,
         case when u.rn = 1 then 'imported the quotation (v' || coalesce(v.version_no, 1) || ')'
              else 're-imported the quotation into v' || coalesce(v.version_no, 1) end,
         jsonb_build_object('file', u.original_filename, 'version_no', v.version_no),
         u.created_at, u.created_at
  from (
    select qu.*, row_number() over (partition by qu.project_id order by qu.created_at) as rn
    from public.quotation_uploads qu
  ) u
  left join lateral (
    select pv.id, pv.version_no from public.project_versions pv
    where pv.upload_id = u.id order by pv.version_no limit 1
  ) v on true;

  insert into public.project_activity (project_id, version_id, actor_id, category, action, summary, details, created_at, updated_at)
  select pv.project_id, pv.id, pv.created_by, 'version', 'revision_started',
         'started v' || pv.version_no,
         jsonb_build_object('version_no', pv.version_no),
         pv.created_at, pv.created_at
  from public.project_versions pv
  where pv.version_no > 1;

  insert into public.project_activity (project_id, version_id, actor_id, category, action, summary, details, created_at, updated_at)
  select pv.project_id, pv.id, ae.actor, 'version',
         case ae.action when 'submit' then 'version_submitted'
                        when 'approve' then 'version_approved'
                        else 'version_changes_requested' end,
         case ae.action when 'submit' then 'submitted v' || pv.version_no || ' for review'
                        when 'approve' then 'approved v' || pv.version_no
                        else 'requested changes on v' || pv.version_no end,
         jsonb_build_object('version_no', pv.version_no, 'comment', nullif(ae.comment, ''),
           'from', case ae.action when 'submit' then 'draft' else 'submitted' end,
           'to', case ae.action when 'submit' then 'submitted'
                                when 'approve' then 'approved'
                                else 'changes_requested' end),
         ae.created_at, ae.created_at
  from public.approval_events ae
  join public.project_versions pv on pv.id = ae.version_id;
end $$;
