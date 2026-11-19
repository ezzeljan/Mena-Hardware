-- Allow ON DELETE CASCADE from project_versions / projects when deleting a project.
-- When a direct DELETE targets door_groups or project_lines while the parent version
-- still exists, v_status is non-null and non-'draft' versions remain strictly locked.

create or replace function public.enforce_draft_version_for_groups()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_version_id uuid;
  v_status public.version_status;
begin
  v_version_id := case when tg_op = 'DELETE' then old.version_id else new.version_id end;

  select status into v_status
  from public.project_versions
  where id = v_version_id;

  -- During ON DELETE CASCADE from project_versions/projects, the parent row is already gone.
  if tg_op = 'DELETE' and not found then
    return old;
  end if;

  if v_status is distinct from 'draft' then
    raise exception 'Cannot modify door groups: version status is "%" (must be draft)', v_status
      using errcode = '42501';
  end if;

  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

create or replace function public.enforce_draft_version_for_lines()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_group_id uuid;
  v_status public.version_status;
begin
  v_group_id := case when tg_op = 'DELETE' then old.group_id else new.group_id end;

  select pv.status into v_status
  from public.door_groups dg
  join public.project_versions pv on pv.id = dg.version_id
  where dg.id = v_group_id;

  -- During ON DELETE CASCADE from door_groups/project_versions/projects, the parent row is already gone.
  if tg_op = 'DELETE' and not found then
    return old;
  end if;

  if v_status is distinct from 'draft' then
    raise exception 'Cannot modify project lines: version status is "%" (must be draft)', v_status
      using errcode = '42501';
  end if;

  return case when tg_op = 'DELETE' then old else new end;
end;
$$;
