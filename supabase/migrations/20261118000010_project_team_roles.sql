-- =============================================================================
-- Migration: 20261118000010_project_team_roles.sql
-- Purpose: Project-level roles.
--   * PMs (and admins) create projects. A project created by a PM is
--     automatically assigned to that PM (projects.assigned_pm).
--   * The project's PM (or an admin) assigns one or more estimators
--     (new table public.project_estimators).
--   * Estimators only see projects they are assigned to, and only assigned
--     estimators (or admins) upload quotations, match, edit lines and submit.
--   * PMs and viewers can see all projects (read-only unless it is their own).
--   * Only the project's own PM (or an admin) approves / requests changes and
--     writes PM remarks.
--   * Also lets the project team mark an approved / changes-requested version
--     "superseded" when they start a new revision (previously silently blocked).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Project estimators
-- -----------------------------------------------------------------------------
create table if not exists public.project_estimators (
  project_id uuid not null references public.projects(id) on delete cascade,
  estimator_id uuid not null references public.profiles(id) on delete cascade,
  assigned_by uuid null references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (project_id, estimator_id)
);

create index if not exists idx_project_estimators_estimator
  on public.project_estimators(estimator_id, project_id);

-- Only users whose role is 'estimator' can be assigned.
create or replace function public.enforce_project_estimator_role()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (
    select 1 from public.profiles where id = new.estimator_id and role = 'estimator'
  ) then
    raise exception 'Only users with the estimator role can be assigned to a project'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_project_estimators_role on public.project_estimators;
create trigger trg_project_estimators_role
  before insert or update on public.project_estimators
  for each row execute function public.enforce_project_estimator_role();

-- Backfill: estimators who created a project keep access to it.
insert into public.project_estimators (project_id, estimator_id, assigned_by)
select p.id, p.created_by, p.created_by
from public.projects p
join public.profiles pr on pr.id = p.created_by and pr.role = 'estimator'
on conflict do nothing;

-- -----------------------------------------------------------------------------
-- 2. Helper functions (SECURITY DEFINER so they can be used inside RLS
--    without recursive policy checks). All are STABLE and read auth.uid().
-- -----------------------------------------------------------------------------
create or replace function public.is_project_pm(p_project_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.projects p
    join public.profiles pr on pr.id = (select auth.uid())
    where p.id = p_project_id
      and pr.role = 'pm'
      and p.assigned_pm = pr.id
  );
$$;

create or replace function public.is_project_estimator(p_project_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.project_estimators pe
    join public.profiles pr on pr.id = pe.estimator_id
    where pe.project_id = p_project_id
      and pe.estimator_id = (select auth.uid())
      and pr.role = 'estimator'
  );
$$;

-- Read access: admins, PMs and viewers see every project; estimators only theirs.
create or replace function public.can_view_project(p_project_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.has_role('admin', 'pm', 'viewer')
      or public.is_project_estimator(p_project_id);
$$;

-- Quotation / matching / line editing / submit: admins and assigned estimators.
create or replace function public.can_edit_project_content(p_project_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_admin() or public.is_project_estimator(p_project_id);
$$;

-- Approve / request changes / PM remarks: admins and the project's own PM.
create or replace function public.can_review_project(p_project_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_admin() or public.is_project_pm(p_project_id);
$$;

-- Resolve the project of child rows.
create or replace function public.project_of_version(p_version_id uuid)
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select project_id from public.project_versions where id = p_version_id;
$$;

create or replace function public.project_of_group(p_group_id uuid)
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select pv.project_id
  from public.door_groups dg
  join public.project_versions pv on pv.id = dg.version_id
  where dg.id = p_group_id;
$$;

create or replace function public.project_of_upload(p_upload_id uuid)
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select project_id from public.quotation_uploads where id = p_upload_id;
$$;

-- Storage paths are "<project_id>/<file>". Returns null for anything else.
create or replace function public.project_of_storage_path(p_name text)
returns uuid
language plpgsql
immutable
as $$
begin
  return split_part(p_name, '/', 1)::uuid;
exception when others then
  return null;
end;
$$;

-- -----------------------------------------------------------------------------
-- 3. Projects: PM auto-assignment on create
-- -----------------------------------------------------------------------------
create or replace function public.assign_creating_pm()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if exists (select 1 from public.profiles where id = new.created_by and role = 'pm') then
    new.assigned_pm := new.created_by;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_projects_assign_creating_pm on public.projects;
create trigger trg_projects_assign_creating_pm
  before insert on public.projects
  for each row execute function public.assign_creating_pm();

-- -----------------------------------------------------------------------------
-- 4. Replace Phase 2 policies
-- -----------------------------------------------------------------------------
-- Projects
drop policy if exists "projects_select_authenticated" on public.projects;
drop policy if exists "projects_insert_estimator_admin" on public.projects;
drop policy if exists "projects_update_estimator_admin" on public.projects;
drop policy if exists "projects_update_admin" on public.projects;
drop policy if exists "projects_delete_admin" on public.projects;

create policy "projects_select_team"
  on public.projects for select to authenticated
  using (public.can_view_project(id));

create policy "projects_insert_pm_admin"
  on public.projects for insert to authenticated
  with check (public.has_role('admin', 'pm') and created_by = (select auth.uid()));

-- Admin edits anything; a PM edits their own project but cannot hand it to someone else.
create policy "projects_update_admin"
  on public.projects for update to authenticated
  using (public.is_admin())
  with check (public.is_admin());

create policy "projects_update_own_pm"
  on public.projects for update to authenticated
  using (public.is_project_pm(id))
  with check (assigned_pm = (select auth.uid()));

create policy "projects_delete_admin"
  on public.projects for delete to authenticated
  using (public.is_admin());

-- Project estimators
alter table public.project_estimators enable row level security;
alter table public.project_estimators force row level security;

drop policy if exists "project_estimators_select_team" on public.project_estimators;
create policy "project_estimators_select_team"
  on public.project_estimators for select to authenticated
  using (public.can_view_project(project_id));

drop policy if exists "project_estimators_insert_pm_admin" on public.project_estimators;
create policy "project_estimators_insert_pm_admin"
  on public.project_estimators for insert to authenticated
  with check (public.can_review_project(project_id) and assigned_by = (select auth.uid()));

drop policy if exists "project_estimators_delete_pm_admin" on public.project_estimators;
create policy "project_estimators_delete_pm_admin"
  on public.project_estimators for delete to authenticated
  using (public.can_review_project(project_id));

-- Quotation uploads
drop policy if exists "quotation_uploads_select_authenticated" on public.quotation_uploads;
drop policy if exists "quotation_uploads_insert_estimator_admin" on public.quotation_uploads;
drop policy if exists "quotation_uploads_delete_admin" on public.quotation_uploads;

create policy "quotation_uploads_select_team"
  on public.quotation_uploads for select to authenticated
  using (public.can_view_project(project_id));

create policy "quotation_uploads_insert_team"
  on public.quotation_uploads for insert to authenticated
  with check (public.can_edit_project_content(project_id) and uploaded_by = (select auth.uid()));

create policy "quotation_uploads_delete_admin"
  on public.quotation_uploads for delete to authenticated
  using (public.is_admin());

-- Quotation doors
drop policy if exists "quotation_doors_select_authenticated" on public.quotation_doors;
drop policy if exists "quotation_doors_insert_estimator_admin" on public.quotation_doors;
drop policy if exists "quotation_doors_delete_admin" on public.quotation_doors;

create policy "quotation_doors_select_team"
  on public.quotation_doors for select to authenticated
  using (public.can_view_project(public.project_of_upload(upload_id)));

create policy "quotation_doors_insert_team"
  on public.quotation_doors for insert to authenticated
  with check (public.can_edit_project_content(public.project_of_upload(upload_id)));

create policy "quotation_doors_delete_admin"
  on public.quotation_doors for delete to authenticated
  using (public.is_admin());

-- Project versions
drop policy if exists "project_versions_select_authenticated" on public.project_versions;
drop policy if exists "project_versions_insert_estimator_admin" on public.project_versions;
drop policy if exists "project_versions_update_estimator_admin_draft" on public.project_versions;
drop policy if exists "project_versions_update_pm_admin_review" on public.project_versions;
drop policy if exists "project_versions_delete_admin" on public.project_versions;

create policy "project_versions_select_team"
  on public.project_versions for select to authenticated
  using (public.can_view_project(project_id));

create policy "project_versions_insert_team"
  on public.project_versions for insert to authenticated
  with check (
    public.can_edit_project_content(project_id)
    and created_by = (select auth.uid())
    and status = 'draft'
  );

-- Edit draft (markup, upload link) and submit it.
create policy "project_versions_update_team_draft"
  on public.project_versions for update to authenticated
  using (public.can_edit_project_content(project_id) and status = 'draft')
  with check (public.can_edit_project_content(project_id) and status in ('draft', 'submitted'));

-- Starting a new revision supersedes the previous approved / changes-requested version.
create policy "project_versions_update_team_supersede"
  on public.project_versions for update to authenticated
  using (public.can_edit_project_content(project_id) and status in ('approved', 'changes_requested'))
  with check (public.can_edit_project_content(project_id) and status = 'superseded');

-- Review: only the project's PM (or admin).
create policy "project_versions_update_pm_review"
  on public.project_versions for update to authenticated
  using (public.can_review_project(project_id) and status = 'submitted')
  with check (public.can_review_project(project_id) and status in ('approved', 'changes_requested', 'superseded'));

create policy "project_versions_delete_admin"
  on public.project_versions for delete to authenticated
  using (public.is_admin());

-- Door groups (draft-lock trigger still applies)
drop policy if exists "door_groups_select_authenticated" on public.door_groups;
drop policy if exists "door_groups_write_estimator_admin" on public.door_groups;

create policy "door_groups_select_team"
  on public.door_groups for select to authenticated
  using (public.can_view_project(public.project_of_version(version_id)));

create policy "door_groups_write_team"
  on public.door_groups for all to authenticated
  using (public.can_edit_project_content(public.project_of_version(version_id)))
  with check (public.can_edit_project_content(public.project_of_version(version_id)));

-- Project lines (draft-lock trigger still applies)
drop policy if exists "project_lines_select_authenticated" on public.project_lines;
drop policy if exists "project_lines_write_estimator_admin" on public.project_lines;

create policy "project_lines_select_team"
  on public.project_lines for select to authenticated
  using (public.can_view_project(public.project_of_group(group_id)));

create policy "project_lines_write_team"
  on public.project_lines for all to authenticated
  using (public.can_edit_project_content(public.project_of_group(group_id)))
  with check (public.can_edit_project_content(public.project_of_group(group_id)));

-- Approval events (append-only)
drop policy if exists "approval_events_select_authenticated" on public.approval_events;
drop policy if exists "approval_events_insert_submit" on public.approval_events;

create policy "approval_events_select_team"
  on public.approval_events for select to authenticated
  using (public.can_view_project(public.project_of_version(version_id)));

create policy "approval_events_insert_team"
  on public.approval_events for insert to authenticated
  with check (
    actor = (select auth.uid())
    and (
      (action = 'submit' and public.can_edit_project_content(public.project_of_version(version_id)))
      or (action in ('approve', 'reject') and public.can_review_project(public.project_of_version(version_id)))
    )
  );

-- Storage: quotation files live under "<project_id>/..."
drop policy if exists "quotations_bucket_select_authenticated" on storage.objects;
drop policy if exists "quotations_bucket_insert_estimator_admin" on storage.objects;
drop policy if exists "quotations_bucket_select_team" on storage.objects;
drop policy if exists "quotations_bucket_insert_team" on storage.objects;

create policy "quotations_bucket_select_team"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'quotations'
    and public.can_view_project(public.project_of_storage_path(name))
  );

create policy "quotations_bucket_insert_team"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'quotations'
    and public.can_edit_project_content(public.project_of_storage_path(name))
  );
-- (quotations_bucket_delete_admin from migration 003 is unchanged.)

-- -----------------------------------------------------------------------------
-- 5. PM remarks: only the project's own PM
-- -----------------------------------------------------------------------------
create or replace function public.update_door_group_pm_remark(
  p_group_id uuid,
  p_remarks text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status public.version_status;
  v_project_id uuid;
begin
  select pv.status, pv.project_id into v_status, v_project_id
  from public.door_groups dg
  join public.project_versions pv on pv.id = dg.version_id
  where dg.id = p_group_id;

  if not found then
    raise exception 'Door group not found'
      using errcode = 'P0002';
  end if;

  if not public.is_project_pm(v_project_id) then
    raise exception 'Only the project''s PM can update PM remarks'
      using errcode = '42501';
  end if;

  if v_status is distinct from 'submitted' then
    raise exception 'PM remarks can only be edited when version status is "submitted" (current: "%")', v_status
      using errcode = '42501';
  end if;

  perform set_config('app.pm_remark_update', 'on', true);

  update public.door_groups
  set pm_remarks = coalesce(p_remarks, ''),
      updated_at = now()
  where id = p_group_id;

  perform set_config('app.pm_remark_update', 'off', true);
end;
$$;

revoke all on function public.update_door_group_pm_remark(uuid, text) from public;
grant execute on function public.update_door_group_pm_remark(uuid, text) to authenticated;
