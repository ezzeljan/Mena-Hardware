-- =============================================================================
-- SQL Test Suite: project stage (migrations 017, 021)
--   New projects start at Tender. The assigned PM (and admins) award a project
--   by choosing the winning quote (latest version approved) and one of its
--   supplier sheets; estimators and other PMs cannot change the stage. Back to
--   Tender clears the winner. Only Tender / Awarded are allowed, and every
--   change is logged in the project activity.
-- =============================================================================

begin;

do $$
declare
  v_admin uuid := '00000000-0000-0000-0000-000000000051';
  v_pm uuid := '00000000-0000-0000-0000-000000000052';
  v_other_pm uuid := '00000000-0000-0000-0000-000000000053';
  v_est uuid := '00000000-0000-0000-0000-000000000054';
  v_supplier uuid;
  v_other_supplier uuid;
  v_project uuid;
  v_version uuid;
  v_quote uuid;
  v_stage text;
  v_err boolean;
  v_groups jsonb := '[{"position": 1, "group_key": "G1", "room_name": "ENTRY", "door_qty": 2,
                       "match_status": "manual", "match_reason": "Custom: Entry",
                       "lines": [{"position": 1, "sku": "S-1", "description": "Closer", "qty_per_door": 1,
                                  "unit_price": 10, "origin": "set", "part_id": null}]}]';
begin
  insert into auth.users (id, email, raw_user_meta_data) values
    (v_admin, 's.admin@mena.local', '{"full_name": "S Admin"}'),
    (v_pm, 's.pm@mena.local', '{"full_name": "S PM"}'),
    (v_other_pm, 's.pm2@mena.local', '{"full_name": "S Other PM"}'),
    (v_est, 's.est@mena.local', '{"full_name": "S Estimator"}');
  update public.profiles set role = 'admin' where id = v_admin;
  update public.profiles set role = 'pm' where id in (v_pm, v_other_pm);
  update public.profiles set role = 'estimator' where id = v_est;
  insert into public.suppliers (name) values ('S SUPPLIER') returning id into v_supplier;
  insert into public.suppliers (name) values ('S OTHER SUPPLIER') returning id into v_other_supplier;

  execute 'set local role authenticated';

  perform set_config('request.jwt.claims', json_build_object('sub', v_pm, 'role', 'authenticated')::text, true);
  insert into public.projects (reference_no, name, created_by) values ('S001', 'Stage Tower', v_pm)
  returning id, stage into v_project, v_stage;
  if v_stage <> 'tender' then
    raise exception 'TEST FAILED: New projects must start at Tender (got %)', v_stage;
  end if;
  insert into public.project_estimators (project_id, estimator_id, assigned_by) values (v_project, v_est, v_pm);

  -- Awarding needs a winning quote and supplier.
  v_err := false;
  begin
    update public.projects set stage = 'awarded' where id = v_project;
  exception when invalid_parameter_value then
    v_err := true;
  end;
  if not v_err then
    raise exception 'TEST FAILED: Awarding without a winning quote must be refused!';
  end if;

  -- A quote that is not approved cannot win.
  perform set_config('request.jwt.claims', json_build_object('sub', v_est, 'role', 'authenticated')::text, true);
  v_version := public.import_quotation(v_project, 'Builder A', v_supplier, v_project::text || '/q.xlsx', 'q.xlsx', '{}', '[]', v_groups);
  select quote_id into v_quote from public.project_versions where id = v_version;
  perform public.transition_version(v_version, 'submit', '');

  perform set_config('request.jwt.claims', json_build_object('sub', v_pm, 'role', 'authenticated')::text, true);
  v_err := false;
  begin
    update public.projects
    set stage = 'awarded', awarded_quote_id = v_quote, awarded_supplier_id = v_supplier
    where id = v_project;
  exception when invalid_parameter_value then
    v_err := true;
  end;
  if not v_err then
    raise exception 'TEST FAILED: A quote waiting for review must not win!';
  end if;

  perform public.transition_version(v_version, 'approve', '');

  -- The supplier must have a sheet in the approved version.
  v_err := false;
  begin
    update public.projects
    set stage = 'awarded', awarded_quote_id = v_quote, awarded_supplier_id = v_other_supplier
    where id = v_project;
  exception when invalid_parameter_value then
    v_err := true;
  end;
  if not v_err then
    raise exception 'TEST FAILED: A supplier without a sheet must not win!';
  end if;

  -- The assigned PM awards it.
  update public.projects
  set stage = 'awarded', awarded_quote_id = v_quote, awarded_supplier_id = v_supplier
  where id = v_project;
  select stage into v_stage from public.projects where id = v_project;
  if v_stage <> 'awarded' then
    raise exception 'TEST FAILED: The assigned PM must be able to award the project!';
  end if;
  if not exists (select 1 from public.project_activity where project_id = v_project and action = 'stage_changed'
                 and actor_id = v_pm and details->>'from' = 'tender' and details->>'to' = 'awarded'
                 and summary = 'awarded the project to Builder A (S SUPPLIER)') then
    raise exception 'TEST FAILED: The award was not logged with the winner!';
  end if;

  -- Only Tender / Awarded.
  v_err := false;
  begin
    update public.projects set stage = 'lost' where id = v_project;
  exception when check_violation then
    v_err := true;
  end;
  if not v_err then
    raise exception 'TEST FAILED: Stages other than Tender / Awarded must be rejected!';
  end if;

  -- The estimator and another PM cannot change it (no rows updated).
  perform set_config('request.jwt.claims', json_build_object('sub', v_est, 'role', 'authenticated')::text, true);
  update public.projects set stage = 'tender' where id = v_project;
  perform set_config('request.jwt.claims', json_build_object('sub', v_other_pm, 'role', 'authenticated')::text, true);
  update public.projects set stage = 'tender' where id = v_project;
  perform set_config('request.jwt.claims', json_build_object('sub', v_pm, 'role', 'authenticated')::text, true);
  select stage into v_stage from public.projects where id = v_project;
  if v_stage <> 'awarded' then
    raise exception 'TEST FAILED: Only the assigned PM or an admin may change the stage!';
  end if;

  -- An admin moves it back to Tender, which clears the winner.
  perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  update public.projects set stage = 'tender' where id = v_project;
  if (select stage from public.projects where id = v_project) <> 'tender'
     or (select awarded_quote_id from public.projects where id = v_project) is not null
     or (select awarded_supplier_id from public.projects where id = v_project) is not null then
    raise exception 'TEST FAILED: Back to Tender must clear the winning quote and supplier!';
  end if;
  if not exists (select 1 from public.project_activity where project_id = v_project and action = 'stage_changed'
                 and actor_id = v_admin and summary = 'moved the project to Tender') then
    raise exception 'TEST FAILED: The move back to Tender was not logged!';
  end if;

  execute 'reset role';
  raise notice 'ALL PROJECT STAGE SQL TESTS PASSED.';
end $$;

rollback;
