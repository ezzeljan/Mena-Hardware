-- =============================================================================
-- SQL Test Suite: in-app notifications (migration 014)
--   1. Assigning an estimator notifies that estimator (not the PM who did it).
--   2. Submitting notifies the project's PM; approving / requesting changes
--      notifies the estimators; the actor is never notified.
--   3. Users only see their own notifications, can mark them read, and cannot
--      create or rewrite them.
--   4. Submitting on a project without a PM notifies the admins.
-- =============================================================================

begin;

do $$
declare
  v_admin uuid := '00000000-0000-0000-0000-000000000031';
  v_pm uuid := '00000000-0000-0000-0000-000000000032';
  v_est uuid := '00000000-0000-0000-0000-000000000033';
  v_other uuid := '00000000-0000-0000-0000-000000000034';
  v_project uuid;
  v_project2 uuid;
  v_version uuid;
  v_version2 uuid;
  v_count integer;
  v_err boolean;
  v_groups jsonb := '[{"position": 1, "group_key": "G1", "room_name": "ENTRY", "door_qty": 1,
                       "match_status": "manual", "match_reason": "Custom: Entry", "lines": []}]';
begin
  insert into auth.users (id, email, raw_user_meta_data) values
    (v_admin, 'n.admin@mena.local', '{"full_name": "N Admin"}'),
    (v_pm, 'n.pm@mena.local', '{"full_name": "N PM"}'),
    (v_est, 'n.est@mena.local', '{"full_name": "N Estimator"}'),
    (v_other, 'n.other@mena.local', '{"full_name": "N Other"}');
  update public.profiles set role = 'admin' where id = v_admin;
  update public.profiles set role = 'pm' where id = v_pm;
  update public.profiles set role = 'estimator' where id in (v_est, v_other);

  execute 'set local role authenticated';

  -- PM creates a project (no notification to themselves) and assigns the estimator.
  perform set_config('request.jwt.claims', json_build_object('sub', v_pm, 'role', 'authenticated')::text, true);
  insert into public.projects (reference_no, name, created_by) values ('N001', 'Notify Tower', v_pm)
  returning id into v_project;
  insert into public.project_estimators (project_id, estimator_id, assigned_by) values (v_project, v_est, v_pm);

  select count(*) into v_count from public.notifications;
  if v_count <> 0 then
    raise exception 'TEST FAILED: The PM must not get notifications about their own actions (got %)', v_count;
  end if;

  -- 1. The estimator was notified about the assignment.
  perform set_config('request.jwt.claims', json_build_object('sub', v_est, 'role', 'authenticated')::text, true);
  if not exists (
    select 1 from public.notifications
    where user_id = v_est and kind = 'assigned_estimator' and project_id = v_project
      and title = 'You were added to N001 — Notify Tower'
  ) then
    raise exception 'TEST FAILED: Assigned estimator was not notified!';
  end if;

  -- 2a. Estimator imports and submits -> PM notified.
  v_version := public.import_quotation(v_project, v_project::text || '/q.xlsx', 'q.xlsx', '{}', '[]', v_groups);
  perform public.transition_version(v_version, 'submit', 'Ready');

  select count(*) into v_count from public.notifications where user_id = v_est;
  if v_count <> 1 then
    raise exception 'TEST FAILED: The submitting estimator must not be notified about their own submit!';
  end if;

  -- 3a. The estimator cannot see the PM's notification, nor create one.
  if exists (select 1 from public.notifications where user_id = v_pm) then
    raise exception 'TEST FAILED: Users must only see their own notifications!';
  end if;
  v_err := false;
  begin
    insert into public.notifications (user_id, kind, title) values (v_pm, 'approved', 'Fake');
  exception when insufficient_privilege then
    v_err := true;
  end;
  if not v_err then
    raise exception 'TEST FAILED: Clients must not create notifications!';
  end if;

  perform set_config('request.jwt.claims', json_build_object('sub', v_pm, 'role', 'authenticated')::text, true);
  if not exists (
    select 1 from public.notifications
    where user_id = v_pm and kind = 'submitted' and version_id = v_version and read_at is null
  ) then
    raise exception 'TEST FAILED: The project PM was not notified about the submit!';
  end if;

  -- 3b. The PM can mark it read but not rewrite it.
  update public.notifications set read_at = now() where user_id = v_pm;
  if exists (select 1 from public.notifications where user_id = v_pm and read_at is null) then
    raise exception 'TEST FAILED: Marking a notification read did not work!';
  end if;
  v_err := false;
  begin
    update public.notifications set title = 'Changed' where user_id = v_pm;
  exception when insufficient_privilege then
    v_err := true;
  end;
  if not v_err then
    raise exception 'TEST FAILED: Clients must not rewrite notification text!';
  end if;

  -- 2b. PM requests changes -> estimator notified with the comment; PM is not.
  perform public.transition_version(v_version, 'reject', 'Check closers');
  if (select count(*) from public.notifications where user_id = v_pm) <> 1 then
    raise exception 'TEST FAILED: The PM must not be notified about their own review!';
  end if;

  perform set_config('request.jwt.claims', json_build_object('sub', v_est, 'role', 'authenticated')::text, true);
  if not exists (
    select 1 from public.notifications
    where user_id = v_est and kind = 'changes_requested' and body like '%Check closers%'
  ) then
    raise exception 'TEST FAILED: Estimator was not notified about the changes request!';
  end if;

  -- 4. A project with no PM: submit notifies the admins.
  perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  insert into public.projects (name, created_by) values ('No PM Project', v_admin) returning id into v_project2;
  insert into public.project_estimators (project_id, estimator_id, assigned_by) values (v_project2, v_other, v_admin);

  perform set_config('request.jwt.claims', json_build_object('sub', v_other, 'role', 'authenticated')::text, true);
  v_version2 := public.import_quotation(v_project2, v_project2::text || '/q.xlsx', 'q.xlsx', '{}', '[]', v_groups);
  perform public.transition_version(v_version2, 'submit', '');

  perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  if not exists (
    select 1 from public.notifications
    where user_id = v_admin and kind = 'submitted' and version_id = v_version2
  ) then
    raise exception 'TEST FAILED: Admins must be notified when a project without a PM is submitted!';
  end if;

  -- 2c. Admin sets a PM -> that PM is notified.
  update public.projects set assigned_pm = v_pm where id = v_project2;
  perform set_config('request.jwt.claims', json_build_object('sub', v_pm, 'role', 'authenticated')::text, true);
  if not exists (
    select 1 from public.notifications where user_id = v_pm and kind = 'assigned_pm' and project_id = v_project2
  ) then
    raise exception 'TEST FAILED: A newly assigned PM was not notified!';
  end if;

  execute 'reset role';
  raise notice 'ALL NOTIFICATION SQL TESTS PASSED.';
end $$;

rollback;
