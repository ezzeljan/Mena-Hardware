-- =============================================================================
-- SQL Test Suite: review flags on hardware lines (migration 024)
--   Import keeps the flag from the payload (default ''), a new sheet, a new
--   revision and a re-import (kept door groups) copy it, the grid clears it,
--   and the 300-character limit holds.
-- =============================================================================

begin;

do $$
declare
  v_supplier uuid;
  v_supplier_b uuid;
  v_pm uuid := '00000000-0000-0000-0000-000000000091';
  v_est uuid := '00000000-0000-0000-0000-000000000092';
  v_project uuid;
  v_version uuid;
  v_version2 uuid;
  v_quote uuid;
  v_line uuid;
  v_flag text;
  v_count integer;
  v_err boolean;
  v_groups jsonb := '[{"position": 1, "group_key": "G1", "room_name": "Entry", "door_qty": 2,
                       "match_status": "manual", "match_reason": "Custom: Entry",
                       "lines": [{"position": 1, "sku": "DS-1", "description": "Door stop", "qty_per_door": 1, "unit_price": 3,
                                  "origin": "set", "review_flag": "No STOP cost in the quotation — check this part"},
                                 {"position": 2, "sku": "C-4", "description": "Closer", "qty_per_door": 1, "unit_price": 110, "origin": "set"}]}]';
begin
  insert into auth.users (id, email, raw_user_meta_data) values
    (v_pm, 'f.pm@mena.local', '{"full_name": "F PM"}'),
    (v_est, 'f.est@mena.local', '{"full_name": "F Estimator"}');
  update public.profiles set role = 'pm' where id = v_pm;
  update public.profiles set role = 'estimator' where id = v_est;
  insert into public.suppliers (name) values ('F SUPPLIER A') returning id into v_supplier;
  insert into public.suppliers (name) values ('F SUPPLIER B') returning id into v_supplier_b;

  execute 'set local role authenticated';
  perform set_config('request.jwt.claims', json_build_object('sub', v_pm, 'role', 'authenticated')::text, true);
  insert into public.projects (reference_no, name, created_by, assigned_pm) values ('F001', 'Flag Tower', v_pm, v_pm)
  returning id into v_project;
  insert into public.project_estimators (project_id, estimator_id, assigned_by) values (v_project, v_est, v_pm);

  perform set_config('request.jwt.claims', json_build_object('sub', v_est, 'role', 'authenticated')::text, true);
  v_version := public.import_quotation(v_project, 'Builder A', v_supplier, v_project::text || '/q.xlsx', 'q.xlsx', '{}', '[]', v_groups);
  select quote_id into v_quote from public.project_versions where id = v_version;

  -- Import keeps the flag; it defaults to ''.
  select l.id, l.review_flag into v_line, v_flag from public.project_lines l join public.door_groups g on g.id = l.group_id
  where g.version_id = v_version and l.sku = 'DS-1';
  if v_flag <> 'No STOP cost in the quotation — check this part' then
    raise exception 'TEST FAILED: Import must keep the review flag (got %)', v_flag;
  end if;
  if (select l.review_flag from public.project_lines l join public.door_groups g on g.id = l.group_id
      where g.version_id = v_version and l.sku = 'C-4') <> '' then
    raise exception 'TEST FAILED: The review flag must default to empty!';
  end if;

  -- A new sheet copies it.
  perform public.add_quote_sheet(v_version, v_supplier_b, null, null);
  select count(*) into v_count from public.project_lines l join public.door_groups g on g.id = l.group_id
  where g.version_id = v_version and l.sku = 'DS-1' and l.review_flag like 'No STOP%';
  if v_count <> 2 then
    raise exception 'TEST FAILED: A new sheet must copy the review flag (% of 2 lines flagged)', v_count;
  end if;

  -- Re-import into the draft: the kept group keeps its flagged lines.
  perform public.reimport_quotation(v_quote, v_project::text || '/q2.xlsx', 'q2.xlsx', '{}', '[]',
    jsonb_build_array(jsonb_build_object('position', 1, 'group_key', 'G1', 'room_name', 'Entry', 'door_qty', 3,
      'match_status', 'manual', 'match_reason', 'Custom: Entry',
      'carried_from_group_id', (select id from public.door_groups where version_id = v_version and group_key = 'G1'),
      'lines', '[]'::jsonb)));
  select count(*) into v_count from public.project_lines l join public.door_groups g on g.id = l.group_id
  where g.version_id = v_version and l.sku = 'DS-1' and l.review_flag like 'No STOP%';
  if v_count <> 2 then
    raise exception 'TEST FAILED: Re-import must keep the review flag of kept lines (% of 2)', v_count;
  end if;

  -- A new revision copies it.
  perform public.transition_version(v_version, 'submit', '');
  perform set_config('request.jwt.claims', json_build_object('sub', v_pm, 'role', 'authenticated')::text, true);
  perform public.transition_version(v_version, 'approve', '');
  perform set_config('request.jwt.claims', json_build_object('sub', v_est, 'role', 'authenticated')::text, true);
  v_version2 := public.create_revision(v_version);
  select l.id into v_line from public.project_lines l join public.door_groups g on g.id = l.group_id
  where g.version_id = v_version2 and l.sku = 'DS-1' and l.review_flag like 'No STOP%' limit 1;
  if v_line is null then
    raise exception 'TEST FAILED: A new revision must copy the review flag!';
  end if;

  -- Editing other fields keeps it; the estimator clears it.
  perform public.save_project_lines(v_version2, jsonb_build_array(jsonb_build_object('id', v_line, 'qty_per_door', 2)));
  if (select review_flag from public.project_lines where id = v_line) = '' then
    raise exception 'TEST FAILED: Saving other fields must keep the review flag!';
  end if;
  perform public.save_project_lines(v_version2, jsonb_build_array(jsonb_build_object('id', v_line, 'review_flag', '')));
  if (select review_flag from public.project_lines where id = v_line) <> '' then
    raise exception 'TEST FAILED: save_project_lines must clear the review flag!';
  end if;

  v_err := false;
  begin
    perform public.save_project_lines(v_version2, jsonb_build_array(jsonb_build_object('id', v_line, 'review_flag', repeat('x', 301))));
  exception when check_violation then
    v_err := true;
  end;
  if not v_err then
    raise exception 'TEST FAILED: Review flags over 300 characters must be rejected!';
  end if;

  execute 'reset role';
  raise notice 'ALL REVIEW FLAG SQL TESTS PASSED.';
end $$;

rollback;
