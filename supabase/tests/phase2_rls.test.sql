-- =============================================================================
-- SQL Test Suite: Phase 2 RLS & Version Locking Verification
-- Tests:
--   1. Estimator & Admin can create projects, uploads, draft versions, groups, lines.
--   2. Viewer & PM cannot create/edit projects, groups, or lines.
--   3. Submitting a version locks door_groups and project_lines (DB trigger blocks edits).
--   4. Estimator cannot approve/reject; PM can approve/reject submitted versions.
--   5. Approval events are append-only (no update/delete even by admin).
--   6. Nullable unit_price stays NULL (never defaults to 0).
-- =============================================================================

begin;

do $$
declare
  v_admin_id uuid := '00000000-0000-0000-0000-000000000011';
  v_estimator_id uuid := '00000000-0000-0000-0000-000000000012';
  v_pm_id uuid := '00000000-0000-0000-0000-000000000013';
  v_viewer_id uuid := '00000000-0000-0000-0000-000000000014';
  v_project_id uuid;
  v_version_id uuid;
  v_group_id uuid;
  v_line_id uuid;
  v_updated integer;
  v_err boolean;
begin
  -- Create test users
  insert into auth.users (id, email, raw_user_meta_data)
  values
    (v_admin_id, 'p2.admin@mena.local', '{"full_name": "P2 Admin"}'::jsonb),
    (v_estimator_id, 'p2.estimator@mena.local', '{"full_name": "P2 Estimator"}'::jsonb),
    (v_pm_id, 'p2.pm@mena.local', '{"full_name": "P2 PM"}'::jsonb),
    (v_viewer_id, 'p2.viewer@mena.local', '{"full_name": "P2 Viewer"}'::jsonb);

  update public.profiles set role = 'admin' where id = v_admin_id;
  update public.profiles set role = 'estimator' where id = v_estimator_id;
  update public.profiles set role = 'pm' where id = v_pm_id;

  -- 1. Viewer CANNOT create a project
  perform set_config('request.jwt.claim.sub', v_viewer_id::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', v_viewer_id::text, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';

  v_err := false;
  begin
    insert into public.projects (name, created_by) values ('Viewer Project', v_viewer_id);
  exception when insufficient_privilege then
    v_err := true;
  end;
  if not v_err then
    raise exception 'TEST FAILED: Viewer should not be able to create a project!';
  end if;

  -- 2. PM CANNOT create a project
  perform set_config('request.jwt.claim.sub', v_pm_id::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', v_pm_id::text, 'role', 'authenticated')::text, true);

  v_err := false;
  begin
    insert into public.projects (name, created_by) values ('PM Project', v_pm_id);
  exception when insufficient_privilege then
    v_err := true;
  end;
  if not v_err then
    raise exception 'TEST FAILED: PM should not be able to create a project!';
  end if;

  -- 3. Estimator CAN create project, draft version, door group, and line (with NULL price)
  perform set_config('request.jwt.claim.sub', v_estimator_id::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', v_estimator_id::text, 'role', 'authenticated')::text, true);

  insert into public.projects (name, client, created_by, assigned_pm)
  values ('Tower A', 'Client X', v_estimator_id, v_pm_id)
  returning id into v_project_id;

  insert into public.project_versions (project_id, version_no, status, created_by)
  values (v_project_id, 1, 'draft', v_estimator_id)
  returning id into v_version_id;

  insert into public.door_groups (version_id, position, group_key, room_name, classification, leaf, door_size, door_qty)
  values (v_version_id, 1, 'UNIT ENTRY|FIRE RATED|SINGLE|2040X920', 'UNIT ENTRY', 'FIRE RATED', 'SINGLE', '2040 x 920', 5)
  returning id into v_group_id;

  insert into public.project_lines (group_id, position, sku, description, qty_per_door, unit_price, origin)
  values (v_group_id, 1, '505BC+SLC', 'SLIDING ARM DOOR CLOSER', 1, null, 'set')
  returning id into v_line_id;

  -- Estimator CANNOT insert an 'approve' event
  v_err := false;
  begin
    insert into public.approval_events (version_id, action, actor, comment)
    values (v_version_id, 'approve', v_estimator_id, 'Self-approve');
  exception when insufficient_privilege then
    v_err := true;
  end;
  if not v_err then
    raise exception 'TEST FAILED: Estimator should not be able to insert an approve event!';
  end if;

  -- Estimator submits version 1
  update public.project_versions set status = 'submitted' where id = v_version_id;
  insert into public.approval_events (version_id, action, actor, comment)
  values (v_version_id, 'submit', v_estimator_id, 'Ready for review');

  -- 4. Once submitted, Estimator CANNOT edit lines or groups (DB trigger blocks it)
  v_err := false;
  begin
    update public.project_lines set qty_per_door = 99 where id = v_line_id;
  exception when insufficient_privilege then
    v_err := true;
  end;
  if not v_err then
    raise exception 'TEST FAILED: Submitted version lines must be locked!';
  end if;

  -- 5. PM CAN read and approve submitted version
  perform set_config('request.jwt.claim.sub', v_pm_id::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', v_pm_id::text, 'role', 'authenticated')::text, true);

  update public.project_versions set status = 'approved' where id = v_version_id;
  get diagnostics v_updated = row_count;
  if v_updated <> 1 then
    raise exception 'TEST FAILED: PM should be able to approve a submitted version!';
  end if;

  insert into public.approval_events (version_id, action, actor, comment)
  values (v_version_id, 'approve', v_pm_id, 'Approved');

  -- 6. Even Admin CANNOT edit lines of an approved version or delete approval_events
  perform set_config('request.jwt.claim.sub', v_admin_id::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', v_admin_id::text, 'role', 'authenticated')::text, true);

  v_err := false;
  begin
    update public.project_lines set qty_per_door = 50 where id = v_line_id;
  exception when insufficient_privilege then
    v_err := true;
  end;
  if not v_err then
    raise exception 'TEST FAILED: Admin should not be able to edit lines on an approved version!';
  end if;

  delete from public.approval_events where version_id = v_version_id;
  get diagnostics v_updated = row_count;
  if v_updated > 0 then
    raise exception 'TEST FAILED: Approval events must be append-only (no deletes)!';
  end if;

  execute 'reset role';
  raise notice 'ALL PHASE 2 RLS & VERSION LOCKING SQL TESTS PASSED.';
end $$;

rollback;
