-- Tighten Phase 2 RBAC:
-- 1. Only Admins can update project metadata (Estimators cannot edit project info).
-- 2. Only PMs can write PM remarks, and only after a draft is submitted (status = 'submitted').
-- 3. Lock markup_pct and upload_id on non-draft project_versions.

drop policy if exists "projects_update_estimator_admin" on public.projects;
drop policy if exists "projects_update_admin" on public.projects;
create policy "projects_update_admin"
  on public.projects for update to authenticated
  using (public.is_admin())
  with check (public.is_admin());

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
begin
  if not public.has_role('pm') then
    raise exception 'Only PMs can update PM remarks'
      using errcode = '42501';
  end if;

  select pv.status into v_status
  from public.door_groups dg
  join public.project_versions pv on pv.id = dg.version_id
  where dg.id = p_group_id;

  if not found then
    raise exception 'Door group not found'
      using errcode = 'P0002';
  end if;

  if v_status is distinct from 'submitted' then
    raise exception 'PM remarks can only be edited when version status is "submitted" (current: "%")', v_status
      using errcode = '42501';
  end if;

  update public.door_groups
  set pm_remarks = coalesce(p_remarks, ''),
      updated_at = now()
  where id = p_group_id;
end;
$$;

create or replace function public.enforce_version_status_transition()
returns trigger
language plpgsql
as $$
begin
  if old.status in ('approved', 'superseded') and new.status is distinct from 'superseded' then
    raise exception 'Cannot transition version from "%" to "%"', old.status, new.status
      using errcode = '42501';
  end if;

  if old.status = 'changes_requested' and new.status is distinct from 'superseded' then
    raise exception 'Create a new draft version instead of editing a "%" version', old.status
      using errcode = '42501';
  end if;

  if old.status <> 'draft' and (
    new.markup_pct is distinct from old.markup_pct
    or new.upload_id is distinct from old.upload_id
  ) then
    raise exception 'Cannot modify markup or upload on a "%" version', old.status
      using errcode = '42501';
  end if;

  if old.status = 'draft' and new.status = 'submitted' and new.submitted_at is null then
    new.submitted_at = now();
  end if;

  return new;
end;
$$;
