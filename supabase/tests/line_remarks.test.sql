-- =============================================================================
-- SQL Test Suite: MHQT remarks on hardware lines (migration 019)
--   Import keeps remarks passed in the payload (default ''), grid saves update
--   them, a new revision copies them, and the 500-character limit holds.
-- =============================================================================

begin;

do $$
declare
  v_pm uuid := '00000000-0000-0000-0000-000000000072';
  v_est uuid := '00000000-0000-0000-0000-000000000074';
  v_project uuid;
  v_version uuid;
  v_version2 uuid;
  v_line uuid;
  v_remarks text;
  v_err boolean;
  v_groups jsonb := '[{"position": 1, "group_key": "G1", "room_name": "ENTRY", "door_qty": 2,
                       "match_status": "manual", "match_reason": "Custom: Entry",
                       "lines": [{"position": 1, "sku": "H-1", "description": "Hinge", "qty_per_door": 3, "unit_price": 10, "mhqt_remarks": "Kept from v0"},
                                 {"position": 2, "sku": "L-1", "description": "Lock", "qty_per_door": 1, "unit_price": 50}]}]';
begin
  insert into auth.users (id, email, raw_user_meta_data) values
    (v_pm, 'r.pm@mena.local', '{"full_name": "R PM"}'),
    (v_est, 'r.est@mena.local', '{"full_name": "R Estimator"}');
  update public.profiles set role = 'pm' where id = v_pm;
  update public.profiles set role = 'estimator' where id = v_est;

  execute 'set local role authenticated';
  perform set_config('request.jwt.claims', json_build_object('sub', v_pm, 'role', 'authenticated')::text, true);
  insert into public.projects (reference_no, name, created_by, assigned_pm) values ('R001', 'Remark Tower', v_pm, v_pm)
  returning id into v_project;
  insert into public.project_estimators (project_id, estimator_id, assigned_by) values (v_project, v_est, v_pm);

  perform set_config('request.jwt.claims', json_build_object('sub', v_est, 'role', 'authenticated')::text, true);
  v_version := public.import_quotation(v_project, v_project::text || '/q.xlsx', 'q.xlsx', '{}', '[]', v_groups);

  select l.mhqt_remarks into v_remarks from public.project_lines l join public.door_groups g on g.id = l.group_id
  where g.version_id = v_version and l.sku = 'H-1';
  if v_remarks <> 'Kept from v0' then
    raise exception 'TEST FAILED: Import must keep remarks from the payload (got %)', v_remarks;
  end if;
  select l.id, l.mhqt_remarks into v_line, v_remarks from public.project_lines l join public.door_groups g on g.id = l.group_id
  where g.version_id = v_version and l.sku = 'L-1';
  if v_remarks <> '' then
    raise exception 'TEST FAILED: Remarks must default to empty (got %)', v_remarks;
  end if;

  -- Grid save.
  perform public.save_project_lines(v_version, jsonb_build_array(jsonb_build_object('id', v_line, 'mhqt_remarks', 'Supply only')));
  select mhqt_remarks into v_remarks from public.project_lines where id = v_line;
  if v_remarks <> 'Supply only' then
    raise exception 'TEST FAILED: save_project_lines must update remarks (got %)', v_remarks;
  end if;
  -- Other fields leave remarks alone.
  perform public.save_project_lines(v_version, jsonb_build_array(jsonb_build_object('id', v_line, 'qty_per_door', 2)));
  select mhqt_remarks into v_remarks from public.project_lines where id = v_line;
  if v_remarks <> 'Supply only' then
    raise exception 'TEST FAILED: Saving other fields must keep remarks (got %)', v_remarks;
  end if;

  v_err := false;
  begin
    perform public.save_project_lines(v_version, jsonb_build_array(jsonb_build_object('id', v_line, 'mhqt_remarks', repeat('x', 501))));
  exception when check_violation then
    v_err := true;
  end;
  if not v_err then
    raise exception 'TEST FAILED: Remarks over 500 characters must be rejected!';
  end if;

  -- New revision copies remarks.
  perform public.transition_version(v_version, 'submit', '');
  perform set_config('request.jwt.claims', json_build_object('sub', v_pm, 'role', 'authenticated')::text, true);
  perform public.transition_version(v_version, 'approve', '');
  perform set_config('request.jwt.claims', json_build_object('sub', v_est, 'role', 'authenticated')::text, true);
  v_version2 := public.create_revision(v_version);
  select l.mhqt_remarks into v_remarks from public.project_lines l join public.door_groups g on g.id = l.group_id
  where g.version_id = v_version2 and l.sku = 'L-1';
  if v_remarks <> 'Supply only' then
    raise exception 'TEST FAILED: A new revision must copy remarks (got %)', v_remarks;
  end if;

  execute 'reset role';
  raise notice 'ALL MHQT REMARKS SQL TESTS PASSED.';
end $$;

rollback;
