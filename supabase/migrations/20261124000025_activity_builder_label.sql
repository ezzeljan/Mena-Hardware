-- The project field "Client" is called "Builder" in the app (optional during
-- tender; the awarded quote's builder once awarded). Project activity now logs
-- edits to it as "Builder". Earlier entries keep the label they were logged with.

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
    v_changes := v_changes || jsonb_build_object('label', 'Builder', 'from', old.client, 'to', new.client);
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
