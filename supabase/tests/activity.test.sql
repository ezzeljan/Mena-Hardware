-- =============================================================================
-- SQL Test Suite: project activity log (migration 016)
--   1. Creating a project, assigning the team and editing details are logged
--      with the user who did it.
--   2. Importing a quotation logs one "imported" entry, not one per line.
--   3. Line edits by the same person on the same version within 30 minutes
--      are grouped into one entry with counts; a later edit starts a new one.
--   4. Submit / request changes / approve / new revision are logged with the
--      comment and status change.
--   5. Anyone who can view the project can read its activity; others cannot,
--      and no client can write or change entries.
--
-- The whole suite runs in one transaction, so "earlier" door groups and
-- activity entries are simulated by moving their timestamps back.
-- =============================================================================

begin;

do $$
declare
  v_supplier uuid;
  v_admin uuid := '00000000-0000-0000-0000-000000000041';
  v_pm uuid := '00000000-0000-0000-0000-000000000042';
  v_est uuid := '00000000-0000-0000-0000-000000000043';
  v_other uuid := '00000000-0000-0000-0000-000000000044';
  v_project uuid;
  v_version uuid;
  v_version2 uuid;
  v_line uuid;
  v_line2 uuid;
  v_row public.project_activity;
  v_count integer;
  v_err boolean;
  v_groups jsonb := '[{"position": 1, "group_key": "G1", "room_name": "ENTRY", "door_qty": 2,
                       "match_status": "manual", "match_reason": "Custom: Entry",
                       "lines": [{"position": 1, "sku": "H-1", "description": "Hinge", "qty_per_door": 3, "unit_price": 10},
                                 {"position": 2, "sku": "L-1", "description": "Lock", "qty_per_door": 1, "unit_price": 50}]}]';
begin
  insert into auth.users (id, email, raw_user_meta_data) values
    (v_admin, 'a.admin@mena.local', '{"full_name": "A Admin"}'),
    (v_pm, 'a.pm@mena.local', '{"full_name": "A PM"}'),
    (v_est, 'a.est@mena.local', '{"full_name": "A Estimator"}'),
    (v_other, 'a.other@mena.local', '{"full_name": "A Other"}');
  update public.profiles set role = 'admin' where id = v_admin;
  update public.profiles set role = 'pm' where id = v_pm;
  update public.profiles set role = 'estimator' where id in (v_est, v_other);

  insert into public.suppliers (name) values ('T SUPPLIER activity') returning id into v_supplier;

  execute 'set local role authenticated';

  -- 1. Project created, PM and estimator assigned, details edited.
  perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  insert into public.projects (reference_no, name, client, created_by, assigned_pm)
  values ('A001', 'Activity Tower', 'Acme', v_admin, v_pm)
  returning id into v_project;

  perform set_config('request.jwt.claims', json_build_object('sub', v_pm, 'role', 'authenticated')::text, true);
  insert into public.project_estimators (project_id, estimator_id, assigned_by) values (v_project, v_est, v_pm);
  update public.projects set client = 'Acme Holdings', site = 'Dubai' where id = v_project;

  if not exists (select 1 from public.project_activity
                 where project_id = v_project and action = 'project_created' and actor_id = v_admin) then
    raise exception 'TEST FAILED: Project creation was not logged with its creator!';
  end if;
  if not exists (select 1 from public.project_activity
                 where project_id = v_project and action = 'pm_assigned' and actor_id = v_admin
                   and summary = 'made A PM the PM') then
    raise exception 'TEST FAILED: Assigning the PM at creation was not logged!';
  end if;
  if not exists (select 1 from public.project_activity
                 where project_id = v_project and action = 'estimator_added' and actor_id = v_pm
                   and summary = 'added A Estimator as an estimator') then
    raise exception 'TEST FAILED: Adding an estimator was not logged with the PM as actor!';
  end if;
  select * into v_row from public.project_activity where project_id = v_project and action = 'details_changed';
  if v_row.actor_id <> v_pm or jsonb_array_length(v_row.details->'changes') <> 2
     or v_row.details->'changes'->0->>'label' <> 'Builder'
     or v_row.details->'changes'->0->>'from' <> 'Acme'
     or v_row.details->'changes'->0->>'to' <> 'Acme Holdings' then
    raise exception 'TEST FAILED: Detail edits were not logged with from/to values (got %)', v_row.details;
  end if;

  -- 2. Import: one entry, no line entries.
  perform set_config('request.jwt.claims', json_build_object('sub', v_est, 'role', 'authenticated')::text, true);
  v_version := public.import_quotation(v_project, 'Builder A', v_supplier, v_project::text || '/q.xlsx', 'q.xlsx', '{}', '[]', v_groups);

  select * into v_row from public.project_activity where project_id = v_project and action = 'quotation_imported';
  if v_row.id is null or v_row.actor_id <> v_est or v_row.version_id <> v_version
     or v_row.details->>'file' <> 'q.xlsx' or (v_row.details->>'door_groups')::int <> 1 then
    raise exception 'TEST FAILED: Quotation import was not logged correctly (got %)', v_row.details;
  end if;
  if exists (select 1 from public.project_activity where project_id = v_project and action = 'lines_edited') then
    raise exception 'TEST FAILED: Lines written by the import must not be logged as edits!';
  end if;

  -- 3. Line edits, grouped. Pretend the import happened an hour ago.
  execute 'reset role';
  update public.door_groups set created_at = now() - interval '1 hour' where version_id = v_version;
  update public.quote_sheets set created_at = now() - interval '1 hour' where version_id = v_version;
  execute 'set local role authenticated';

  select l.id into v_line from public.project_lines l join public.door_groups g on g.id = l.group_id
  where g.version_id = v_version and l.sku = 'H-1';
  select l.id into v_line2 from public.project_lines l join public.door_groups g on g.id = l.group_id
  where g.version_id = v_version and l.sku = 'L-1';

  perform public.save_project_lines(v_version, jsonb_build_array(
    jsonb_build_object('id', v_line, 'qty_per_door', 4),
    jsonb_build_object('id', v_line2, 'unit_price', 55)));
  perform public.save_project_lines(v_version, jsonb_build_array(jsonb_build_object('id', v_line, 'unit_price', 12)));

  select count(*) into v_count from public.project_activity where project_id = v_project and action = 'lines_edited';
  select * into v_row from public.project_activity where project_id = v_project and action = 'lines_edited';
  if v_count <> 1 or (v_row.details->>'edited')::int <> 3 or v_row.actor_id <> v_est then
    raise exception 'TEST FAILED: Line edits within 30 minutes must be grouped (count %, details %)', v_count, v_row.details;
  end if;

  -- An edit more than 30 minutes after the last one starts a new entry.
  execute 'reset role';
  update public.project_activity set created_at = now() - interval '45 minutes', updated_at = now() - interval '45 minutes'
  where id = v_row.id;
  execute 'set local role authenticated';
  perform public.save_project_lines(v_version, jsonb_build_array(jsonb_build_object('id', v_line2, 'qty_per_door', 2)));
  select count(*) into v_count from public.project_activity where project_id = v_project and action = 'lines_edited';
  if v_count <> 2 then
    raise exception 'TEST FAILED: An edit after 30 minutes must start a new entry (got % entries)', v_count;
  end if;

  -- Markup change.
  update public.project_versions set markup_pct = 20 where id = v_version;
  if not exists (select 1 from public.project_activity where project_id = v_project and action = 'markup_changed'
                 and (details->>'to')::numeric = 20 and actor_id = v_est) then
    raise exception 'TEST FAILED: Markup change was not logged!';
  end if;

  -- 4. Submit, request changes, new revision, approve.
  perform public.transition_version(v_version, 'submit', 'Ready for review');
  perform set_config('request.jwt.claims', json_build_object('sub', v_pm, 'role', 'authenticated')::text, true);
  perform public.transition_version(v_version, 'reject', 'Check closers');

  select * into v_row from public.project_activity where project_id = v_project and action = 'version_changes_requested';
  if v_row.actor_id <> v_pm or v_row.details->>'comment' <> 'Check closers'
     or v_row.details->>'to' <> 'changes_requested' then
    raise exception 'TEST FAILED: Changes request was not logged with comment and status (got %)', v_row.details;
  end if;
  if not exists (select 1 from public.project_activity where project_id = v_project and action = 'version_submitted'
                 and actor_id = v_est and details->>'comment' = 'Ready for review') then
    raise exception 'TEST FAILED: Submit was not logged!';
  end if;

  perform set_config('request.jwt.claims', json_build_object('sub', v_est, 'role', 'authenticated')::text, true);
  v_version2 := public.create_revision(v_version);
  if not exists (select 1 from public.project_activity where project_id = v_project and action = 'revision_started'
                 and version_id = v_version2 and summary = 'started Builder A v2 from v1' and actor_id = v_est) then
    raise exception 'TEST FAILED: Starting a revision was not logged!';
  end if;
  if exists (select 1 from public.project_activity where version_id = v_version2 and action = 'lines_edited') then
    raise exception 'TEST FAILED: Lines copied into a revision must not be logged as edits!';
  end if;

  perform public.transition_version(v_version2, 'submit', '');
  perform set_config('request.jwt.claims', json_build_object('sub', v_pm, 'role', 'authenticated')::text, true);
  perform public.transition_version(v_version2, 'approve', 'Looks good');
  if not exists (select 1 from public.project_activity where project_id = v_project and action = 'version_approved'
                 and version_id = v_version2 and actor_id = v_pm and summary = 'approved Builder A v2') then
    raise exception 'TEST FAILED: Approval was not logged!';
  end if;

  -- 5. Read access follows project visibility; nobody writes directly.
  perform set_config('request.jwt.claims', json_build_object('sub', v_other, 'role', 'authenticated')::text, true);
  if exists (select 1 from public.project_activity where project_id = v_project) then
    raise exception 'TEST FAILED: An estimator not on the project must not see its activity!';
  end if;

  perform set_config('request.jwt.claims', json_build_object('sub', v_est, 'role', 'authenticated')::text, true);
  select count(*) into v_count from public.project_activity where project_id = v_project;
  if v_count < 10 then
    raise exception 'TEST FAILED: The assigned estimator should see the project activity (saw %)', v_count;
  end if;

  v_err := false;
  begin
    insert into public.project_activity (project_id, category, action, summary)
    values (v_project, 'project', 'fake', 'did something');
  exception when insufficient_privilege then
    v_err := true;
  end;
  if not v_err then
    raise exception 'TEST FAILED: Clients must not add activity entries!';
  end if;

  v_err := false;
  begin
    update public.project_activity set summary = 'rewritten' where project_id = v_project;
  exception when insufficient_privilege then
    v_err := true;
  end;
  if not v_err then
    raise exception 'TEST FAILED: Clients must not rewrite activity entries!';
  end if;

  v_err := false;
  begin
    delete from public.project_activity where project_id = v_project;
  exception when insufficient_privilege then
    v_err := true;
  end;
  if not v_err then
    raise exception 'TEST FAILED: Clients must not delete activity entries!';
  end if;

  execute 'reset role';
  raise notice 'ALL PROJECT ACTIVITY SQL TESTS PASSED.';
end $$;

rollback;
