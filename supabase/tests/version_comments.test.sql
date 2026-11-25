-- =============================================================================
-- SQL Test Suite: PM comments on a version (migration 018)
--   1. The assigned PM (and admins) can comment, on the whole schedule or on a
--      door group of that version; estimators and other PMs cannot.
--   2. A comment cannot point at a door group of another version.
--   3. Everyone on the project can read comments; outsiders cannot.
--   4. Authors delete their own comments; others cannot (admins can).
--   5. A new comment is logged in the activity and notifies the estimators.
-- =============================================================================

begin;

do $$
declare
  v_supplier uuid;
  v_admin uuid := '00000000-0000-0000-0000-000000000061';
  v_pm uuid := '00000000-0000-0000-0000-000000000062';
  v_other_pm uuid := '00000000-0000-0000-0000-000000000063';
  v_est uuid := '00000000-0000-0000-0000-000000000064';
  v_outsider uuid := '00000000-0000-0000-0000-000000000065';
  v_project uuid;
  v_version uuid;
  v_version2 uuid;
  v_group uuid;
  v_group_v2 uuid;
  v_comment uuid;
  v_count integer;
  v_err boolean;
  v_groups jsonb := '[{"position": 1, "group_key": "G1", "room_name": "ENTRY", "door_qty": 2,
                       "match_status": "manual", "match_reason": "Custom: Entry",
                       "lines": [{"position": 1, "sku": "H-1", "description": "Hinge", "qty_per_door": 3, "unit_price": 10}]}]';
begin
  insert into auth.users (id, email, raw_user_meta_data) values
    (v_admin, 'c.admin@mena.local', '{"full_name": "C Admin"}'),
    (v_pm, 'c.pm@mena.local', '{"full_name": "C PM"}'),
    (v_other_pm, 'c.pm2@mena.local', '{"full_name": "C Other PM"}'),
    (v_est, 'c.est@mena.local', '{"full_name": "C Estimator"}'),
    (v_outsider, 'c.out@mena.local', '{"full_name": "C Outsider"}');
  update public.profiles set role = 'admin' where id = v_admin;
  update public.profiles set role = 'pm' where id in (v_pm, v_other_pm);
  update public.profiles set role = 'estimator' where id in (v_est, v_outsider);

  insert into public.suppliers (name) values ('T SUPPLIER version_comments') returning id into v_supplier;

  execute 'set local role authenticated';

  perform set_config('request.jwt.claims', json_build_object('sub', v_pm, 'role', 'authenticated')::text, true);
  insert into public.projects (reference_no, name, created_by, assigned_pm) values ('C001', 'Comment Tower', v_pm, v_pm)
  returning id into v_project;
  insert into public.project_estimators (project_id, estimator_id, assigned_by) values (v_project, v_est, v_pm);

  perform set_config('request.jwt.claims', json_build_object('sub', v_est, 'role', 'authenticated')::text, true);
  v_version := public.import_quotation(v_project, 'Builder A', v_supplier, v_project::text || '/q.xlsx', 'q.xlsx', '{}', '[]', v_groups);
  select id into v_group from public.door_groups where version_id = v_version;
  perform public.transition_version(v_version, 'submit', '');

  -- 1. The assigned PM comments on a door group and on the whole schedule.
  perform set_config('request.jwt.claims', json_build_object('sub', v_pm, 'role', 'authenticated')::text, true);
  insert into public.version_comments (version_id, door_group_id, author_id, body)
  values (v_version, v_group, v_pm, 'Use the satin finish hinges here')
  returning id into v_comment;
  insert into public.version_comments (version_id, author_id, body) values (v_version, v_pm, 'Overall looks fine');

  if not exists (select 1 from public.project_activity where project_id = v_project and action = 'comment_added'
                 and actor_id = v_pm and summary = 'commented on ENTRY in Builder A v1'
                 and details->>'comment' = 'Use the satin finish hinges here') then
    raise exception 'TEST FAILED: A comment was not logged in the activity!';
  end if;

  -- Estimators and other PMs cannot comment.
  foreach v_admin in array array[v_est, v_other_pm] loop
    perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
    v_err := false;
    begin
      insert into public.version_comments (version_id, author_id, body) values (v_version, v_admin, 'Hello');
    exception when insufficient_privilege then
      v_err := true;
    end;
    if not v_err then
      raise exception 'TEST FAILED: % must not be able to comment!', v_admin;
    end if;
  end loop;
  v_admin := '00000000-0000-0000-0000-000000000061';

  -- 2. Not on a door group of another version; not as someone else.
  perform set_config('request.jwt.claims', json_build_object('sub', v_pm, 'role', 'authenticated')::text, true);
  perform public.transition_version(v_version, 'reject', 'Fix it');
  perform set_config('request.jwt.claims', json_build_object('sub', v_est, 'role', 'authenticated')::text, true);
  v_version2 := public.create_revision(v_version);
  select id into v_group_v2 from public.door_groups where version_id = v_version2;
  perform set_config('request.jwt.claims', json_build_object('sub', v_pm, 'role', 'authenticated')::text, true);
  v_err := false;
  begin
    insert into public.version_comments (version_id, door_group_id, author_id, body)
    values (v_version, v_group_v2, v_pm, 'Wrong version');
  exception when insufficient_privilege then
    v_err := true;
  end;
  if not v_err then
    raise exception 'TEST FAILED: A comment must not point at a door group of another version!';
  end if;
  v_err := false;
  begin
    insert into public.version_comments (version_id, author_id, body) values (v_version2, v_est, 'Impersonated');
  exception when insufficient_privilege then
    v_err := true;
  end;
  if not v_err then
    raise exception 'TEST FAILED: Comments must be posted as yourself!';
  end if;
  -- Comments are allowed on a draft too.
  insert into public.version_comments (version_id, door_group_id, author_id, body)
  values (v_version2, v_group_v2, v_pm, 'Thanks, check again');

  -- 3. Read access.
  perform set_config('request.jwt.claims', json_build_object('sub', v_est, 'role', 'authenticated')::text, true);
  select count(*) into v_count from public.version_comments where version_id = v_version;
  if v_count <> 2 then
    raise exception 'TEST FAILED: The estimator should see the 2 comments on v1 (saw %)', v_count;
  end if;
  -- 5. ...and was notified of each.
  select count(*) into v_count from public.notifications where user_id = v_est and kind = 'comment';
  if v_count <> 3 then
    raise exception 'TEST FAILED: The estimator should have 3 comment notifications (got %)', v_count;
  end if;

  perform set_config('request.jwt.claims', json_build_object('sub', v_outsider, 'role', 'authenticated')::text, true);
  if exists (select 1 from public.version_comments where version_id = v_version) then
    raise exception 'TEST FAILED: Someone not on the project must not see its comments!';
  end if;

  -- 4. Delete: not someone else's; own yes; admin any.
  perform set_config('request.jwt.claims', json_build_object('sub', v_est, 'role', 'authenticated')::text, true);
  delete from public.version_comments where id = v_comment;
  perform set_config('request.jwt.claims', json_build_object('sub', v_pm, 'role', 'authenticated')::text, true);
  if not exists (select 1 from public.version_comments where id = v_comment) then
    raise exception 'TEST FAILED: Only the author or an admin may delete a comment!';
  end if;
  delete from public.version_comments where id = v_comment;
  if exists (select 1 from public.version_comments where id = v_comment) then
    raise exception 'TEST FAILED: The author must be able to delete their comment!';
  end if;
  perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  delete from public.version_comments where version_id = v_version;
  select count(*) into v_count from public.version_comments where version_id = v_version;
  if v_count <> 0 then
    raise exception 'TEST FAILED: An admin must be able to delete any comment!';
  end if;

  -- Comments cannot be edited.
  v_err := false;
  begin
    update public.version_comments set body = 'edited' where version_id = v_version2;
  exception when insufficient_privilege then
    v_err := true;
  end;
  if not v_err then
    raise exception 'TEST FAILED: Comments must not be editable!';
  end if;

  execute 'reset role';
  raise notice 'ALL VERSION COMMENT SQL TESTS PASSED.';
end $$;

rollback;
