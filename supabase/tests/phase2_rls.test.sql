-- =============================================================================
-- SQL Test Suite: Phase 2 RLS, project team roles & version locking
-- Tests:
--   1. Viewers and estimators cannot create projects; PMs can, and become the project's PM.
--   2. Only the project's PM assigns estimators; only estimator-role users can be assigned.
--   3. Unassigned estimators cannot see or work on a project; assigned estimators can.
--   4. Submitting a version locks door_groups and project_lines (DB trigger blocks edits).
--   5. Only the project's own PM approves and writes PM remarks.
--   6. The team can supersede an approved version when starting a new revision.
--   7. Approval events are append-only (no update/delete even by admin).
--   8. Nullable unit_price stays NULL (never defaults to 0).
--   9. import_quotation, save_project_lines, transition_version and
--      create_revision (migration 011) are all-or-nothing, check permissions,
--      and version status can only change through them.
--  10. reimport_quotation (migration 012) replaces a draft's quotation or
--      creates the next revision, and is refused while a version is submitted.
-- =============================================================================

begin;

do $$
declare
  v_admin_id uuid := '00000000-0000-0000-0000-000000000011';
  v_estimator_id uuid := '00000000-0000-0000-0000-000000000012';
  v_pm_id uuid := '00000000-0000-0000-0000-000000000013';
  v_viewer_id uuid := '00000000-0000-0000-0000-000000000014';
  v_other_estimator_id uuid := '00000000-0000-0000-0000-000000000015';
  v_other_pm_id uuid := '00000000-0000-0000-0000-000000000016';
  v_project_id uuid;
  v_version_id uuid;
  v_group_id uuid;
  v_line_id uuid;
  v_line2_id uuid;
  v_version2_id uuid;
  v_version3_id uuid;
  v_updated integer;
  v_count integer;
  v_err boolean;
begin
  -- Create test users
  insert into auth.users (id, email, raw_user_meta_data)
  values
    (v_admin_id, 'p2.admin@mena.local', '{"full_name": "P2 Admin"}'::jsonb),
    (v_estimator_id, 'p2.estimator@mena.local', '{"full_name": "P2 Estimator"}'::jsonb),
    (v_pm_id, 'p2.pm@mena.local', '{"full_name": "P2 PM"}'::jsonb),
    (v_viewer_id, 'p2.viewer@mena.local', '{"full_name": "P2 Viewer"}'::jsonb),
    (v_other_estimator_id, 'p2.estimator2@mena.local', '{"full_name": "P2 Estimator Two"}'::jsonb),
    (v_other_pm_id, 'p2.pm2@mena.local', '{"full_name": "P2 PM Two"}'::jsonb);

  update public.profiles set role = 'admin' where id = v_admin_id;
  update public.profiles set role = 'estimator' where id in (v_estimator_id, v_other_estimator_id);
  update public.profiles set role = 'pm' where id in (v_pm_id, v_other_pm_id);

  execute 'set local role authenticated';

  -- 1a. Viewer CANNOT create a project
  perform set_config('request.jwt.claim.sub', v_viewer_id::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', v_viewer_id::text, 'role', 'authenticated')::text, true);

  v_err := false;
  begin
    insert into public.projects (name, created_by) values ('Viewer Project', v_viewer_id);
  exception when insufficient_privilege then
    v_err := true;
  end;
  if not v_err then
    raise exception 'TEST FAILED: Viewer should not be able to create a project!';
  end if;

  -- 1b. Estimator CANNOT create a project (PMs create projects now)
  perform set_config('request.jwt.claim.sub', v_estimator_id::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', v_estimator_id::text, 'role', 'authenticated')::text, true);

  v_err := false;
  begin
    insert into public.projects (name, created_by) values ('Estimator Project', v_estimator_id);
  exception when insufficient_privilege then
    v_err := true;
  end;
  if not v_err then
    raise exception 'TEST FAILED: Estimator should not be able to create a project!';
  end if;

  -- 1c. PM CAN create a project and is auto-assigned as its PM
  perform set_config('request.jwt.claim.sub', v_pm_id::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', v_pm_id::text, 'role', 'authenticated')::text, true);

  insert into public.projects (name, client, created_by, assigned_pm)
  values ('Tower A', 'Client X', v_pm_id, null)
  returning id into v_project_id;

  if (select assigned_pm from public.projects where id = v_project_id) is distinct from v_pm_id then
    raise exception 'TEST FAILED: A project created by a PM must be assigned to that PM!';
  end if;

  -- 1d. PM CANNOT create versions (estimators import the quotation)
  v_err := false;
  begin
    insert into public.project_versions (project_id, version_no, status, created_by)
    values (v_project_id, 1, 'draft', v_pm_id);
  exception when insufficient_privilege then
    v_err := true;
  end;
  if not v_err then
    raise exception 'TEST FAILED: PM should not be able to create versions!';
  end if;

  -- 2a. Another PM CANNOT assign estimators to this project
  perform set_config('request.jwt.claim.sub', v_other_pm_id::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', v_other_pm_id::text, 'role', 'authenticated')::text, true);

  v_err := false;
  begin
    insert into public.project_estimators (project_id, estimator_id, assigned_by)
    values (v_project_id, v_other_estimator_id, v_other_pm_id);
  exception when insufficient_privilege then
    v_err := true;
  end;
  if not v_err then
    raise exception 'TEST FAILED: Only the project''s PM may assign estimators!';
  end if;

  -- 2b. The project's PM CAN assign an estimator, but not a non-estimator
  perform set_config('request.jwt.claim.sub', v_pm_id::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', v_pm_id::text, 'role', 'authenticated')::text, true);

  insert into public.project_estimators (project_id, estimator_id, assigned_by)
  values (v_project_id, v_estimator_id, v_pm_id);

  v_err := false;
  begin
    insert into public.project_estimators (project_id, estimator_id, assigned_by)
    values (v_project_id, v_other_pm_id, v_pm_id);
  exception when check_violation then
    v_err := true;
  end;
  if not v_err then
    raise exception 'TEST FAILED: Only estimator-role users can be assigned to a project!';
  end if;

  -- 3a. An UNASSIGNED estimator cannot see or work on the project
  perform set_config('request.jwt.claim.sub', v_other_estimator_id::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', v_other_estimator_id::text, 'role', 'authenticated')::text, true);

  select count(*) into v_count from public.projects where id = v_project_id;
  if v_count <> 0 then
    raise exception 'TEST FAILED: Unassigned estimator must not see the project!';
  end if;

  v_err := false;
  begin
    insert into public.project_versions (project_id, version_no, status, created_by)
    values (v_project_id, 1, 'draft', v_other_estimator_id);
  exception when insufficient_privilege then
    v_err := true;
  end;
  if not v_err then
    raise exception 'TEST FAILED: Unassigned estimator must not create versions!';
  end if;

  v_err := false;
  begin
    perform public.import_quotation(v_project_id, v_project_id::text || '/x.xlsx', 'x.xlsx',
      '{}'::jsonb, '[]'::jsonb, '[{"position": 1, "group_key": "X", "room_name": "X", "door_qty": 1}]'::jsonb);
  exception when insufficient_privilege then
    v_err := true;
  end;
  if not v_err then
    raise exception 'TEST FAILED: Unassigned estimator must not import a quotation!';
  end if;

  -- 3b. The ASSIGNED estimator sees the project and imports the quotation (NULL price kept)
  perform set_config('request.jwt.claim.sub', v_estimator_id::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', v_estimator_id::text, 'role', 'authenticated')::text, true);

  select count(*) into v_count from public.projects where id = v_project_id;
  if v_count <> 1 then
    raise exception 'TEST FAILED: Assigned estimator should see the project!';
  end if;

  -- Assigned estimator imports the quotation in one call (version 1 + upload + doors + groups + lines)
  v_version_id := public.import_quotation(
    v_project_id,
    v_project_id::text || '/1700000000000-quote.xlsx',
    'quote.xlsx',
    '{"rows": 2}'::jsonb,
    '[{"door_ref": "D01", "room_name": "UNIT ENTRY", "classification": "FIRE RATED", "leaf": "SINGLE", "door_size": "2040 x 920", "qty": 5, "source_row": 6}]'::jsonb,
    '[{"position": 1, "group_key": "UNIT ENTRY|FIRE RATED|SINGLE|2040X920", "door_tag": "D01",
       "room_name": "UNIT ENTRY", "classification": "FIRE RATED", "leaf": "SINGLE", "door_size": "2040 x 920",
       "door_qty": 5, "matched_set_id": null, "match_status": "manual", "match_score": null, "match_reason": "Custom",
       "lines": [
         {"position": 1, "sku": "505BC+SLC", "description": "SLIDING ARM DOOR CLOSER", "qty_per_door": 1, "unit_price": null, "origin": "set", "part_id": null},
         {"position": 2, "sku": "MMHINGE", "description": "HINGES", "qty_per_door": 3, "unit_price": 4, "origin": "set", "part_id": null}
       ]}]'::jsonb
  );

  select id into v_group_id from public.door_groups where version_id = v_version_id;
  select id into v_line_id from public.project_lines where group_id = v_group_id and position = 1;
  select id into v_line2_id from public.project_lines where group_id = v_group_id and position = 2;

  if (select upload_id from public.project_versions where id = v_version_id) is null
     or (select count(*) from public.quotation_doors qd
         join public.project_versions pv on pv.upload_id = qd.upload_id
         where pv.id = v_version_id) <> 1
     or v_line_id is null or v_line2_id is null then
    raise exception 'TEST FAILED: import_quotation did not create the upload, doors, group and lines!';
  end if;

  if (select unit_price from public.project_lines where id = v_line_id) is not null then
    raise exception 'TEST FAILED: NULL unit_price must stay NULL!';
  end if;

  -- 3c. A second import is refused (start a new revision instead)
  v_err := false;
  begin
    perform public.import_quotation(v_project_id, v_project_id::text || '/again.xlsx', 'again.xlsx',
      '{}'::jsonb, '[]'::jsonb, '[{"position": 1, "group_key": "X", "room_name": "X", "door_qty": 1}]'::jsonb);
  exception when others then
    v_err := true;
  end;
  if not v_err then
    raise exception 'TEST FAILED: A quotation must not be imported twice!';
  end if;

  -- 3d. save_project_lines: only the keys sent change; a NULL price is kept; positions can swap
  perform public.save_project_lines(v_version_id, jsonb_build_array(
    jsonb_build_object('id', v_line_id, 'qty_per_door', 2),
    jsonb_build_object('id', v_line2_id, 'unit_price', 4.5, 'origin', 'edited')
  ));
  if (select qty_per_door from public.project_lines where id = v_line_id) <> 2
     or (select unit_price from public.project_lines where id = v_line_id) is not null
     or (select unit_price from public.project_lines where id = v_line2_id) <> 4.5 then
    raise exception 'TEST FAILED: save_project_lines changed the wrong fields!';
  end if;

  perform public.save_project_lines(v_version_id, jsonb_build_array(
    jsonb_build_object('id', v_line_id, 'position', 2),
    jsonb_build_object('id', v_line2_id, 'position', 1)
  ));
  if (select position from public.project_lines where id = v_line_id) <> 2 then
    raise exception 'TEST FAILED: save_project_lines should swap line positions!';
  end if;

  -- 3e. save_project_lines is all-or-nothing: an unknown line id saves nothing
  v_err := false;
  begin
    perform public.save_project_lines(v_version_id, jsonb_build_array(
      jsonb_build_object('id', v_line_id, 'qty_per_door', 7),
      jsonb_build_object('id', gen_random_uuid(), 'qty_per_door', 1)
    ));
  exception when others then
    v_err := true;
  end;
  if not v_err or (select qty_per_door from public.project_lines where id = v_line_id) <> 2 then
    raise exception 'TEST FAILED: save_project_lines must save all lines or none!';
  end if;

  -- 3f. Estimator CANNOT insert an 'approve' event directly
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

  -- 3g. Status cannot be changed with a direct update (only through the functions)
  v_err := false;
  begin
    update public.project_versions set status = 'submitted' where id = v_version_id;
  exception when insufficient_privilege then
    v_err := true;
  end;
  if not v_err then
    raise exception 'TEST FAILED: Direct status updates must be blocked!';
  end if;

  -- 3h. Estimator CANNOT approve their own version through the function
  v_err := false;
  begin
    perform public.transition_version(v_version_id, 'approve', 'Self-approve');
  exception when insufficient_privilege then
    v_err := true;
  end;
  if not v_err then
    raise exception 'TEST FAILED: Estimator must not approve through transition_version!';
  end if;

  -- Estimator submits version 1: status and event are written together
  perform public.transition_version(v_version_id, 'submit', 'Ready for review');
  if (select status from public.project_versions where id = v_version_id) <> 'submitted'
     or (select submitted_at from public.project_versions where id = v_version_id) is null
     or (select count(*) from public.approval_events where version_id = v_version_id and action = 'submit') <> 1 then
    raise exception 'TEST FAILED: Submit must set the status and write one submit event!';
  end if;

  if coalesce(current_setting('app.version_transition', true), '') = 'on' then
    raise exception 'TEST FAILED: app.version_transition flag leaked past transition_version!';
  end if;

  -- Submitting twice is refused
  v_err := false;
  begin
    perform public.transition_version(v_version_id, 'submit', 'Again');
  exception when others then
    v_err := true;
  end;
  if not v_err then
    raise exception 'TEST FAILED: A submitted version must not be submitted again!';
  end if;

  -- 4a. Once submitted, Estimator CANNOT edit lines (DB trigger blocks it)
  v_err := false;
  begin
    update public.project_lines set qty_per_door = 99 where id = v_line_id;
  exception when insufficient_privilege then
    v_err := true;
  end;
  if not v_err then
    raise exception 'TEST FAILED: Submitted version lines must be locked!';
  end if;

  v_err := false;
  begin
    perform public.save_project_lines(v_version_id, jsonb_build_array(
      jsonb_build_object('id', v_line_id, 'qty_per_door', 99)));
  exception when insufficient_privilege then
    v_err := true;
  end;
  if not v_err then
    raise exception 'TEST FAILED: save_project_lines must not edit a submitted version!';
  end if;

  -- 4b. Estimator CANNOT write pm_remarks directly on a submitted version
  v_err := false;
  begin
    update public.door_groups set pm_remarks = 'Estimator note' where id = v_group_id;
  exception when insufficient_privilege then
    v_err := true;
  end;
  if not v_err then
    raise exception 'TEST FAILED: Estimator must not edit door_groups (incl. pm_remarks) on a submitted version!';
  end if;

  -- 4c. Estimator can see the team's names in profile_directory
  if not exists (select 1 from public.profile_directory where id = v_pm_id and role = 'pm') then
    raise exception 'TEST FAILED: Estimator should see PMs in profile_directory!';
  end if;

  -- 5a. Another PM can see the project but CANNOT approve it or write remarks
  perform set_config('request.jwt.claim.sub', v_other_pm_id::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', v_other_pm_id::text, 'role', 'authenticated')::text, true);

  select count(*) into v_count from public.projects where id = v_project_id;
  if v_count <> 1 then
    raise exception 'TEST FAILED: PMs should be able to view all projects!';
  end if;

  v_err := false;
  begin
    perform public.transition_version(v_version_id, 'approve', 'Not my project');
  exception when insufficient_privilege then
    v_err := true;
  end;
  if not v_err then
    raise exception 'TEST FAILED: Only the project''s PM may approve!';
  end if;

  v_err := false;
  begin
    perform public.update_door_group_pm_remark(v_group_id, 'Not my project');
  exception when insufficient_privilege then
    v_err := true;
  end;
  if not v_err then
    raise exception 'TEST FAILED: Only the project''s PM may write PM remarks!';
  end if;

  -- 5b. The project's PM CAN save PM remarks via the RPC
  perform set_config('request.jwt.claim.sub', v_pm_id::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', v_pm_id::text, 'role', 'authenticated')::text, true);

  perform public.update_door_group_pm_remark(v_group_id, 'Use satin chrome closer');
  if (select pm_remarks from public.door_groups where id = v_group_id) <> 'Use satin chrome closer' then
    raise exception 'TEST FAILED: PM remark was not saved on a submitted version!';
  end if;

  if coalesce(current_setting('app.pm_remark_update', true), '') = 'on' then
    raise exception 'TEST FAILED: app.pm_remark_update flag leaked past the RPC!';
  end if;

  -- 5c. Requesting changes needs a comment
  v_err := false;
  begin
    perform public.transition_version(v_version_id, 'reject', '   ');
  exception when others then
    v_err := true;
  end;
  if not v_err or (select status from public.project_versions where id = v_version_id) <> 'submitted' then
    raise exception 'TEST FAILED: Request changes without a comment must be refused!';
  end if;

  -- 5d. The project's PM CAN approve (status + event together)
  perform public.transition_version(v_version_id, 'approve', 'Approved');
  if (select status from public.project_versions where id = v_version_id) <> 'approved'
     or (select count(*) from public.approval_events where version_id = v_version_id and action = 'approve') <> 1 then
    raise exception 'TEST FAILED: The project''s PM should be able to approve a submitted version!';
  end if;

  -- 6a. The PM CANNOT start a new revision (estimators do)
  v_err := false;
  begin
    perform public.create_revision(v_version_id);
  exception when insufficient_privilege then
    v_err := true;
  end;
  if not v_err then
    raise exception 'TEST FAILED: PM must not start a new revision!';
  end if;

  -- 6b. The assigned estimator starts revision 2: copies groups and lines, supersedes v1
  perform set_config('request.jwt.claim.sub', v_estimator_id::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', v_estimator_id::text, 'role', 'authenticated')::text, true);

  v_version2_id := public.create_revision(v_version_id);

  if (select version_no from public.project_versions where id = v_version2_id) <> 2
     or (select status from public.project_versions where id = v_version2_id) <> 'draft'
     or (select status from public.project_versions where id = v_version_id) <> 'superseded'
     or (select count(*) from public.door_groups where version_id = v_version2_id) <> 1
     or (select count(*) from public.project_lines pl
         join public.door_groups dg on dg.id = pl.group_id
         where dg.version_id = v_version2_id) <> 2
     or exists (select 1 from public.project_lines pl
                join public.door_groups dg on dg.id = pl.group_id
                where dg.version_id = v_version2_id and pl.sku = '505BC+SLC' and pl.unit_price is not null) then
    raise exception 'TEST FAILED: create_revision must copy groups and lines and supersede the source!';
  end if;

  -- 6c. A second revision while a draft exists is refused
  v_err := false;
  begin
    perform public.create_revision(v_version_id);
  exception when others then
    v_err := true;
  end;
  if not v_err then
    raise exception 'TEST FAILED: create_revision must refuse while a draft exists!';
  end if;

  -- 8a. Re-import while a draft exists replaces the draft's quotation in place
  v_version3_id := public.reimport_quotation(
    v_project_id,
    v_project_id::text || '/1700000000001-quote-rev.xlsx',
    'quote-rev.xlsx',
    '{}'::jsonb,
    '[{"door_ref": "D01", "room_name": "UNIT ENTRY", "qty": 6, "source_row": 6},
      {"door_ref": "D02", "room_name": "BATHROOM", "qty": 2, "source_row": 7}]'::jsonb,
    '[{"position": 1, "group_key": "UNIT ENTRY|FIRE RATED|SINGLE|2040X920", "room_name": "UNIT ENTRY",
       "door_qty": 6, "match_status": "manual", "match_reason": "Custom", "pm_remarks": "Use satin chrome closer",
       "lines": [{"position": 1, "sku": "505BC+SLC", "description": "SLIDING ARM DOOR CLOSER", "qty_per_door": 2, "unit_price": null, "origin": "edited", "part_id": null}]},
      {"position": 2, "group_key": "BATHROOM|NON RATED|SINGLE|2040X820", "room_name": "BATHROOM",
       "door_qty": 2, "match_status": "confirmed", "match_score": 0.9,
       "lines": [{"position": 1, "sku": "MMHINGE", "description": "HINGES", "qty_per_door": 3, "unit_price": 4, "origin": "set", "part_id": null}]}]'::jsonb
  );

  if v_version3_id <> v_version2_id
     or (select count(*) from public.project_versions where project_id = v_project_id) <> 2
     or (select count(*) from public.door_groups where version_id = v_version2_id) <> 2
     or (select door_qty from public.door_groups where version_id = v_version2_id and room_name = 'UNIT ENTRY') <> 6
     or (select pm_remarks from public.door_groups where version_id = v_version2_id and room_name = 'UNIT ENTRY') <> 'Use satin chrome closer'
     or (select qu.original_filename from public.project_versions pv
         join public.quotation_uploads qu on qu.id = pv.upload_id where pv.id = v_version2_id) <> 'quote-rev.xlsx' then
    raise exception 'TEST FAILED: Re-import must replace the draft''s groups, lines and upload in place!';
  end if;

  -- 8b. Re-import is refused while a version waits for PM review
  perform public.transition_version(v_version2_id, 'submit', 'Revised quotation');
  v_err := false;
  begin
    perform public.reimport_quotation(v_project_id, v_project_id::text || '/r2.xlsx', 'r2.xlsx',
      '{}'::jsonb, '[]'::jsonb, '[{"position": 1, "group_key": "X", "room_name": "X", "door_qty": 1}]'::jsonb);
  exception when others then
    v_err := true;
  end;
  if not v_err then
    raise exception 'TEST FAILED: Re-import must be refused while a version is submitted!';
  end if;

  -- 8c. The PM cannot re-import; after approval the estimator's re-import creates v3
  perform set_config('request.jwt.claim.sub', v_pm_id::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', v_pm_id::text, 'role', 'authenticated')::text, true);
  perform public.transition_version(v_version2_id, 'approve', 'OK');

  v_err := false;
  begin
    perform public.reimport_quotation(v_project_id, v_project_id::text || '/pm.xlsx', 'pm.xlsx',
      '{}'::jsonb, '[]'::jsonb, '[{"position": 1, "group_key": "X", "room_name": "X", "door_qty": 1}]'::jsonb);
  exception when insufficient_privilege then
    v_err := true;
  end;
  if not v_err then
    raise exception 'TEST FAILED: The PM must not re-import the quotation!';
  end if;

  perform set_config('request.jwt.claim.sub', v_estimator_id::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', v_estimator_id::text, 'role', 'authenticated')::text, true);

  v_version3_id := public.reimport_quotation(v_project_id, v_project_id::text || '/r3.xlsx', 'r3.xlsx',
    '{}'::jsonb, '[]'::jsonb,
    '[{"position": 1, "group_key": "BATHROOM|NON RATED|SINGLE|2040X820", "room_name": "BATHROOM", "door_qty": 4,
       "match_status": "confirmed", "lines": []}]'::jsonb);

  if (select version_no from public.project_versions where id = v_version3_id) <> 3
     or (select status from public.project_versions where id = v_version3_id) <> 'draft'
     or (select status from public.project_versions where id = v_version2_id) <> 'superseded'
     or (select upload_id from public.project_versions where id = v_version3_id) is null
     or (select count(*) from public.door_groups where version_id = v_version3_id) <> 1 then
    raise exception 'TEST FAILED: Re-import after approval must create the next draft and supersede the latest!';
  end if;

  if coalesce(current_setting('app.version_transition', true), '') = 'on' then
    raise exception 'TEST FAILED: app.version_transition flag leaked past reimport_quotation!';
  end if;

  -- 8d. An unassigned estimator cannot re-import
  perform set_config('request.jwt.claim.sub', v_other_estimator_id::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', v_other_estimator_id::text, 'role', 'authenticated')::text, true);
  v_err := false;
  begin
    perform public.reimport_quotation(v_project_id, v_project_id::text || '/x.xlsx', 'x.xlsx',
      '{}'::jsonb, '[]'::jsonb, '[{"position": 1, "group_key": "X", "room_name": "X", "door_qty": 1}]'::jsonb);
  exception when insufficient_privilege then
    v_err := true;
  end;
  if not v_err then
    raise exception 'TEST FAILED: An unassigned estimator must not re-import!';
  end if;

  -- 7. Even Admin CANNOT edit lines of a locked version or delete approval_events
  perform set_config('request.jwt.claim.sub', v_admin_id::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', v_admin_id::text, 'role', 'authenticated')::text, true);

  v_err := false;
  begin
    update public.project_lines set qty_per_door = 50 where id = v_line_id;
  exception when insufficient_privilege then
    v_err := true;
  end;
  if not v_err then
    raise exception 'TEST FAILED: Admin should not be able to edit lines on a locked version!';
  end if;

  delete from public.approval_events where version_id = v_version_id;
  get diagnostics v_updated = row_count;
  if v_updated > 0 then
    raise exception 'TEST FAILED: Approval events must be append-only (no deletes)!';
  end if;

  execute 'reset role';
  raise notice 'ALL PHASE 2 RLS, PROJECT TEAM & VERSION LOCKING SQL TESTS PASSED.';
end $$;

rollback;
