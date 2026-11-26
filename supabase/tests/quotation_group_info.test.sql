-- =============================================================================
-- SQL Test Suite: quotation details per door group (migration 028)
--   Import saves each group's quote_info with the upload; a group without it
--   saves nothing; a re-import saves the new upload's; the project team reads
--   it, others don't; only the team writes it.
-- =============================================================================

begin;

do $$
declare
  v_supplier uuid;
  v_pm uuid := '00000000-0000-0000-0000-000000000a01';
  v_est uuid := '00000000-0000-0000-0000-000000000a02';
  v_other uuid := '00000000-0000-0000-0000-000000000a03';
  v_project uuid;
  v_version uuid;
  v_quote uuid;
  v_upload uuid;
  v_upload2 uuid;
  v_count integer;
  v_err boolean;
  v_groups jsonb := '[{"position": 1, "group_key": "G1", "room_name": "Entry", "door_qty": 2,
                       "match_status": "manual", "match_reason": "Custom: Entry",
                       "quote_info": {"doors": ["D-01"], "hardware": "Hinge: LO · Lock prep: 25",
                                      "notes": ["LOCK PREP 25: added L2 (vestibule lock)"]},
                       "lines": []},
                      {"position": 2, "group_key": "G2", "room_name": "Store", "door_qty": 1,
                       "match_status": "unmatched", "lines": []}]';
begin
  insert into auth.users (id, email, raw_user_meta_data) values
    (v_pm, 'qi.pm@mena.local', '{"full_name": "QI PM"}'),
    (v_est, 'qi.est@mena.local', '{"full_name": "QI Estimator"}'),
    (v_other, 'qi.other@mena.local', '{"full_name": "QI Other"}');
  update public.profiles set role = 'pm' where id = v_pm;
  update public.profiles set role = 'estimator' where id in (v_est, v_other);
  insert into public.suppliers (name) values ('QI SUPPLIER') returning id into v_supplier;

  execute 'set local role authenticated';
  perform set_config('request.jwt.claims', json_build_object('sub', v_pm, 'role', 'authenticated')::text, true);
  insert into public.projects (reference_no, name, created_by, assigned_pm) values ('QI01', 'Info Tower', v_pm, v_pm)
  returning id into v_project;
  insert into public.project_estimators (project_id, estimator_id, assigned_by) values (v_project, v_est, v_pm);

  perform set_config('request.jwt.claims', json_build_object('sub', v_est, 'role', 'authenticated')::text, true);
  v_version := public.import_quotation(v_project, 'Builder A', v_supplier, v_project::text || '/q.xlsx', 'q.xlsx', '{}', '[]', v_groups);
  select quote_id, upload_id into v_quote, v_upload from public.project_versions where id = v_version;

  -- Import saves the group's quote_info; a group without it saves nothing.
  if (select info->>'hardware' from public.quotation_group_info where upload_id = v_upload and group_key = 'G1')
     is distinct from 'Hinge: LO · Lock prep: 25' then
    raise exception 'TEST FAILED: Import must save the group''s quote_info!';
  end if;
  if exists (select 1 from public.quotation_group_info where upload_id = v_upload and group_key = 'G2') then
    raise exception 'TEST FAILED: A group without quote_info must save nothing!';
  end if;

  -- Re-import: the new upload gets its own row (the kept group too).
  perform public.reimport_quotation(v_quote, v_project::text || '/q2.xlsx', 'q2.xlsx', '{}', '[]',
    jsonb_build_array(jsonb_build_object('position', 1, 'group_key', 'G1', 'room_name', 'Entry', 'door_qty', 3,
      'match_status', 'manual', 'match_reason', 'Custom: Entry',
      'carried_from_group_id', (select id from public.door_groups where version_id = v_version and group_key = 'G1'),
      'quote_info', jsonb_build_object('hardware', 'Hinge: BH'),
      'lines', '[]'::jsonb)));
  select upload_id into v_upload2 from public.project_versions where id = v_version;
  if v_upload2 = v_upload then
    raise exception 'TEST FAILED: Re-import must make a new upload!';
  end if;
  if (select info->>'hardware' from public.quotation_group_info where upload_id = v_upload2 and group_key = 'G1')
     is distinct from 'Hinge: BH' then
    raise exception 'TEST FAILED: Re-import must save the new upload''s quote_info!';
  end if;

  -- The PM (project team) reads it.
  perform set_config('request.jwt.claims', json_build_object('sub', v_pm, 'role', 'authenticated')::text, true);
  select count(*) into v_count from public.quotation_group_info where upload_id in (v_upload, v_upload2);
  if v_count <> 2 then
    raise exception 'TEST FAILED: The project team must read the quotation details (% of 2)', v_count;
  end if;

  -- An estimator not on the project neither reads nor writes it.
  perform set_config('request.jwt.claims', json_build_object('sub', v_other, 'role', 'authenticated')::text, true);
  select count(*) into v_count from public.quotation_group_info where upload_id in (v_upload, v_upload2);
  if v_count <> 0 then
    raise exception 'TEST FAILED: Others must not read the quotation details (% rows)', v_count;
  end if;
  v_err := false;
  begin
    insert into public.quotation_group_info (upload_id, group_key, info) values (v_upload, 'G9', '{}');
  exception when insufficient_privilege then
    v_err := true;
  end;
  if not v_err then
    raise exception 'TEST FAILED: Others must not write the quotation details!';
  end if;

  execute 'reset role';
  raise notice 'ALL QUOTATION GROUP INFO SQL TESTS PASSED.';
end $$;

rollback;
