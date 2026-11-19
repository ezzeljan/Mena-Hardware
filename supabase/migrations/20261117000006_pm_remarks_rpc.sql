-- Allow PM/Admin to record per-door-group PM remarks during draft or submitted review
-- without unlocking any other door_groups fields on submitted versions.

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
  if not public.has_role('admin', 'pm') then
    raise exception 'Only PM or Admin can update PM remarks'
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

  if v_status not in ('draft', 'submitted') then
    raise exception 'Cannot edit PM remarks when version status is "%"', v_status
      using errcode = '42501';
  end if;

  update public.door_groups
  set pm_remarks = coalesce(p_remarks, ''),
      updated_at = now()
  where id = p_group_id;
end;
$$;

revoke all on function public.update_door_group_pm_remark(uuid, text) from public;
grant execute on function public.update_door_group_pm_remark(uuid, text) to authenticated;
