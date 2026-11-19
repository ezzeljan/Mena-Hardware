-- =============================================================================
-- SQL Test Suite: builder quotes and supplier sheets (migration 021)
--   1. Each builder gets its own quote with its own version numbers; builder
--      names are unique per project (case-insensitive).
--   2. add_quote_sheet copies the door groups' lines from a sheet; one sheet
--      per supplier; only the team adds sheets, only in a draft.
--   3. A line's sheet must be in the same version as its door group.
--   4. Sheets can be renamed (unique names) and removed, but a version keeps
--      at least one.
--   5. create_revision copies every sheet with its own lines.
--   6. Re-import keeps each sheet's lines for unchanged door groups; new door
--      groups get their lines on every sheet.
--   7. A comment may point at a sheet of the same version only.
--   8. Once awarded, the other quotes are read-only and no quote can be added;
--      the winning quote can still be revised.
--   9. Adding a sheet to an existing draft is logged.
-- =============================================================================

begin;

do $$
declare
  v_admin uuid := '00000000-0000-0000-0000-000000000071';
  v_pm uuid := '00000000-0000-0000-0000-000000000072';
  v_est uuid := '00000000-0000-0000-0000-000000000073';
  v_viewer uuid := '00000000-0000-0000-0000-000000000074';
  v_sup_a uuid;
  v_sup_b uuid;
  v_sup_c uuid;
  v_project uuid;
  v_va1 uuid;   -- Builder A v1
  v_va2 uuid;   -- Builder A v2
  v_vb1 uuid;   -- Builder B v1
  v_vb2 uuid;
  v_quote_a uuid;
  v_quote_b uuid;
  v_sheet_a uuid;
  v_sheet_b uuid;
  v_sheet_c uuid;
  v_group uuid;
  v_line uuid;
  v_count integer;
  v_err boolean;
  v_groups jsonb := '[{"position": 1, "group_key": "G1", "room_name": "ENTRY", "door_qty": 2,
                       "match_status": "manual", "match_reason": "Custom: Entry",
                       "lines": [{"position": 1, "sku": "S-1", "description": "Closer", "qty_per_door": 1,
                                  "unit_price": 10, "origin": "set", "part_id": null},
                                 {"position": 2, "sku": "S-2", "description": "Hinge", "qty_per_door": 3,
                                  "unit_price": null, "origin": "set", "part_id": null}]}]';
begin
  insert into auth.users (id, email, raw_user_meta_data) values
    (v_admin, 'q.admin@mena.local', '{"full_name": "Q Admin"}'),
    (v_pm, 'q.pm@mena.local', '{"full_name": "Q PM"}'),
    (v_est, 'q.est@mena.local', '{"full_name": "Q Estimator"}'),
    (v_viewer, 'q.viewer@mena.local', '{"full_name": "Q Viewer"}');
  update public.profiles set role = 'admin' where id = v_admin;
  update public.profiles set role = 'pm' where id = v_pm;
  update public.profiles set role = 'estimator' where id = v_est;
  insert into public.suppliers (name) values ('Q SUPPLIER A') returning id into v_sup_a;
  insert into public.suppliers (name) values ('Q SUPPLIER B') returning id into v_sup_b;
  insert into public.suppliers (name) values ('Q SUPPLIER C') returning id into v_sup_c;

  execute 'set local role authenticated';

  perform set_config('request.jwt.claims', json_build_object('sub', v_pm, 'role', 'authenticated')::text, true);
  insert into public.projects (reference_no, name, created_by) values ('Q001', 'Quote Tower', v_pm)
  returning id into v_project;
  insert into public.project_estimators (project_id, estimator_id, assigned_by) values (v_project, v_est, v_pm);

  -- 1. Two builders, two quotes, both at v1.
  perform set_config('request.jwt.claims', json_build_object('sub', v_est, 'role', 'authenticated')::text, true);
  v_va1 := public.import_quotation(v_project, 'Builder A', v_sup_a, v_project::text || '/a.xlsx', 'a.xlsx', '{}', '[]', v_groups);
  v_vb1 := public.import_quotation(v_project, '  Builder B ', v_sup_a, v_project::text || '/b.xlsx', 'b.xlsx', '{}', '[]', v_groups);
  select quote_id into v_quote_a from public.project_versions where id = v_va1;
  select quote_id into v_quote_b from public.project_versions where id = v_vb1;

  if v_quote_a = v_quote_b
     or (select version_no from public.project_versions where id = v_vb1) <> 1
     or (select builder_name from public.hardware_quotes where id = v_quote_b) <> 'Builder B' then
    raise exception 'TEST FAILED: Each builder must get its own quote starting at v1 (trimmed name)!';
  end if;

  select id into v_sheet_a from public.quote_sheets where version_id = v_va1;
  if (select name from public.quote_sheets where id = v_sheet_a) <> 'Q SUPPLIER A'
     or (select count(*) from public.project_lines where sheet_id = v_sheet_a) <> 2 then
    raise exception 'TEST FAILED: The import must create the first sheet (named after the supplier) with the lines!';
  end if;

  v_err := false;
  begin
    perform public.import_quotation(v_project, 'BUILDER a', v_sup_a, v_project::text || '/c.xlsx', 'c.xlsx', '{}', '[]', v_groups);
  exception when unique_violation then
    v_err := true;
  end;
  if not v_err then
    raise exception 'TEST FAILED: Builder names must be unique per project (case-insensitive)!';
  end if;

  -- 2. add_quote_sheet
  perform set_config('request.jwt.claims', json_build_object('sub', v_pm, 'role', 'authenticated')::text, true);
  v_err := false;
  begin
    perform public.add_quote_sheet(v_va1, v_sup_b);
  exception when insufficient_privilege then
    v_err := true;
  end;
  if not v_err then
    raise exception 'TEST FAILED: The PM must not add supplier sheets!';
  end if;

  perform set_config('request.jwt.claims', json_build_object('sub', v_est, 'role', 'authenticated')::text, true);
  v_sheet_b := public.add_quote_sheet(v_va1, v_sup_b);
  if (select name from public.quote_sheets where id = v_sheet_b) <> 'Q SUPPLIER B'
     or (select position from public.quote_sheets where id = v_sheet_b) <> 1
     or (select count(*) from public.project_lines where sheet_id = v_sheet_b) <> 2
     or exists (select 1 from public.project_lines where sheet_id = v_sheet_b and sku = 'S-2' and unit_price is not null) then
    raise exception 'TEST FAILED: add_quote_sheet must copy the lines (NULL prices kept)!';
  end if;

  v_err := false;
  begin
    perform public.add_quote_sheet(v_va1, v_sup_b);
  exception when unique_violation then
    v_err := true;
  end;
  if not v_err then
    raise exception 'TEST FAILED: One sheet per supplier!';
  end if;

  -- Edits on one sheet leave the other alone.
  select id into v_line from public.project_lines where sheet_id = v_sheet_b and sku = 'S-1';
  perform public.save_project_lines(v_va1, jsonb_build_array(jsonb_build_object('id', v_line, 'unit_price', 12)));
  if (select unit_price from public.project_lines where sheet_id = v_sheet_a and sku = 'S-1') <> 10 then
    raise exception 'TEST FAILED: Editing a line must not change the other sheet!';
  end if;

  -- 3. Line sheet must match the group's version.
  select id into v_group from public.door_groups where version_id = v_va1;
  v_err := false;
  begin
    insert into public.project_lines (group_id, sheet_id, position, sku, description, qty_per_door, origin)
    values (v_group, (select id from public.quote_sheets where version_id = v_vb1), 9, 'X', 'Wrong sheet', 1, 'added');
  exception when check_violation then
    v_err := true;
  end;
  if not v_err then
    raise exception 'TEST FAILED: A line cannot use a sheet from another version!';
  end if;

  insert into public.project_lines (group_id, sheet_id, position, sku, description, qty_per_door, origin)
  values (v_group, v_sheet_b, 3, 'S-3', 'Door stop', 1, 'added');

  -- 4. Rename, unique names, remove, keep one.
  update public.quote_sheets set name = 'Supplier B (option 1)' where id = v_sheet_b;
  if (select name from public.quote_sheets where id = v_sheet_b) <> 'Supplier B (option 1)' then
    raise exception 'TEST FAILED: The team must be able to rename a sheet!';
  end if;

  v_err := false;
  begin
    update public.quote_sheets set name = 'supplier b (OPTION 1)' where id = v_sheet_a;
  exception when unique_violation then
    v_err := true;
  end;
  if not v_err then
    raise exception 'TEST FAILED: Sheet names must be unique within a version!';
  end if;

  v_sheet_c := public.add_quote_sheet(v_va1, v_sup_c, 'Third', v_sheet_b);
  if (select count(*) from public.project_lines where sheet_id = v_sheet_c) <> 3 then
    raise exception 'TEST FAILED: add_quote_sheet must copy from the chosen sheet!';
  end if;
  delete from public.quote_sheets where id = v_sheet_c;
  if exists (select 1 from public.project_lines where sheet_id = v_sheet_c) then
    raise exception 'TEST FAILED: Removing a sheet must remove its lines!';
  end if;

  v_err := false;
  begin
    delete from public.quote_sheets where version_id = v_vb1;
  exception when invalid_parameter_value then
    v_err := true;
  end;
  if not v_err then
    raise exception 'TEST FAILED: The last sheet of a version must not be removed!';
  end if;

  -- Viewers cannot touch sheets.
  perform set_config('request.jwt.claims', json_build_object('sub', v_viewer, 'role', 'authenticated')::text, true);
  update public.quote_sheets set name = 'Hacked' where id = v_sheet_a;
  perform set_config('request.jwt.claims', json_build_object('sub', v_est, 'role', 'authenticated')::text, true);
  if (select name from public.quote_sheets where id = v_sheet_a) <> 'Q SUPPLIER A' then
    raise exception 'TEST FAILED: Viewers must not rename sheets!';
  end if;

  -- 7. Comments on a sheet (the PM, after submit).
  perform public.transition_version(v_va1, 'submit', '');
  perform set_config('request.jwt.claims', json_build_object('sub', v_pm, 'role', 'authenticated')::text, true);
  insert into public.version_comments (version_id, sheet_id, author_id, body)
  values (v_va1, v_sheet_b, v_pm, 'Supplier B is cheaper on closers');
  if not exists (select 1 from public.project_activity where project_id = v_project and action = 'comment_added'
                 and summary = 'commented on Supplier B (option 1) in Builder A v1') then
    raise exception 'TEST FAILED: A sheet comment must be logged with the sheet name!';
  end if;

  v_err := false;
  begin
    insert into public.version_comments (version_id, sheet_id, author_id, body)
    values (v_vb1, v_sheet_b, v_pm, 'Wrong version');
  exception when insufficient_privilege then
    v_err := true;
  end;
  if not v_err then
    raise exception 'TEST FAILED: A comment''s sheet must belong to its version!';
  end if;

  -- Sheets are locked once submitted.
  perform set_config('request.jwt.claims', json_build_object('sub', v_est, 'role', 'authenticated')::text, true);
  v_err := false;
  begin
    perform public.add_quote_sheet(v_va1, v_sup_c);
  exception when invalid_parameter_value then
    v_err := true;
  end;
  if not v_err then
    raise exception 'TEST FAILED: Sheets can only be added to a draft!';
  end if;

  -- 5. create_revision copies every sheet with its own lines.
  perform set_config('request.jwt.claims', json_build_object('sub', v_pm, 'role', 'authenticated')::text, true);
  perform public.transition_version(v_va1, 'approve', '');
  perform set_config('request.jwt.claims', json_build_object('sub', v_est, 'role', 'authenticated')::text, true);
  v_va2 := public.create_revision(v_va1);
  if (select count(*) from public.quote_sheets where version_id = v_va2) <> 2
     or (select count(*) from public.project_lines l join public.quote_sheets s on s.id = l.sheet_id
         where s.version_id = v_va2 and s.supplier_id = v_sup_b) <> 3
     or (select l.unit_price from public.project_lines l join public.quote_sheets s on s.id = l.sheet_id
         where s.version_id = v_va2 and s.supplier_id = v_sup_b and l.sku = 'S-1') <> 12
     or (select count(*) from public.project_lines l join public.quote_sheets s on s.id = l.sheet_id
         where s.version_id = v_va2 and s.supplier_id = v_sup_a) <> 2 then
    raise exception 'TEST FAILED: create_revision must copy each sheet with its own lines!';
  end if;
  if (select status from public.project_versions where id = v_vb1) <> 'draft' then
    raise exception 'TEST FAILED: Revising one quote must not touch another quote!';
  end if;

  -- 6. Re-import into the draft: G1 kept (both sheets keep their lines), G2 new.
  perform public.reimport_quotation(v_quote_a, v_project::text || '/a2.xlsx', 'a2.xlsx', '{}', '[]',
    jsonb_build_array(
      jsonb_build_object('position', 1, 'group_key', 'G1', 'room_name', 'ENTRY', 'door_qty', 4,
        'match_status', 'manual', 'match_reason', 'Custom: Entry',
        'carried_from_group_id', (select id from public.door_groups where version_id = v_va2 and group_key = 'G1'),
        'lines', '[]'::jsonb),
      jsonb_build_object('position', 2, 'group_key', 'G2', 'room_name', 'BATH', 'door_qty', 1,
        'match_status', 'manual', 'match_reason', 'Custom: Bath',
        'lines', '[{"position": 1, "sku": "S-9", "description": "Privacy set", "qty_per_door": 1, "unit_price": 5, "origin": "set", "part_id": null}]'::jsonb)
    ));

  if (select count(*) from public.door_groups where version_id = v_va2) <> 2
     or (select l.unit_price from public.project_lines l
         join public.quote_sheets s on s.id = l.sheet_id
         join public.door_groups g on g.id = l.group_id
         where s.version_id = v_va2 and s.supplier_id = v_sup_b and g.group_key = 'G1' and l.sku = 'S-1') <> 12
     or (select count(*) from public.project_lines l
         join public.quote_sheets s on s.id = l.sheet_id
         join public.door_groups g on g.id = l.group_id
         where s.version_id = v_va2 and g.group_key = 'G1' and s.supplier_id = v_sup_b) <> 3
     or (select count(*) from public.project_lines l
         join public.quote_sheets s on s.id = l.sheet_id
         join public.door_groups g on g.id = l.group_id
         where s.version_id = v_va2 and g.group_key = 'G2') <> 2 then
    raise exception 'TEST FAILED: Re-import must keep each sheet''s lines and add new groups to every sheet!';
  end if;

  -- 8. Award Builder B (approved) with supplier A; Builder A becomes read-only.
  perform public.transition_version(v_vb1, 'submit', '');
  perform set_config('request.jwt.claims', json_build_object('sub', v_pm, 'role', 'authenticated')::text, true);
  perform public.transition_version(v_vb1, 'approve', '');
  update public.projects set stage = 'awarded', awarded_quote_id = v_quote_b, awarded_supplier_id = v_sup_a
  where id = v_project;

  perform set_config('request.jwt.claims', json_build_object('sub', v_est, 'role', 'authenticated')::text, true);
  select l.id into v_line from public.project_lines l join public.quote_sheets s on s.id = l.sheet_id
  where s.version_id = v_va2 limit 1;

  v_err := false;
  begin
    perform public.save_project_lines(v_va2, jsonb_build_array(jsonb_build_object('id', v_line, 'qty_per_door', 9)));
  exception when insufficient_privilege then
    v_err := true;
  end;
  if not v_err then
    raise exception 'TEST FAILED: Lines of a quote that lost the award must be read-only!';
  end if;

  v_err := false;
  begin
    perform public.transition_version(v_va2, 'submit', '');
  exception when insufficient_privilege then
    v_err := true;
  end;
  if not v_err then
    raise exception 'TEST FAILED: A quote that lost the award must not be submitted!';
  end if;

  v_err := false;
  begin
    perform public.add_quote_sheet(v_va2, v_sup_c);
  exception when insufficient_privilege then
    v_err := true;
  end;
  if not v_err then
    raise exception 'TEST FAILED: A quote that lost the award must not get new sheets!';
  end if;

  v_err := false;
  begin
    perform public.import_quotation(v_project, 'Builder C', v_sup_a, v_project::text || '/c.xlsx', 'c.xlsx', '{}', '[]', v_groups);
  exception when insufficient_privilege then
    v_err := true;
  end;
  if not v_err then
    raise exception 'TEST FAILED: No new quotes once the project is awarded!';
  end if;

  -- The winner can still be revised.
  v_vb2 := public.create_revision(v_vb1);
  if (select version_no from public.project_versions where id = v_vb2) <> 2 then
    raise exception 'TEST FAILED: The winning quote must stay revisable!';
  end if;

  -- 9. Adding a sheet to an existing draft is logged (pretend the draft is older).
  execute 'reset role';
  update public.project_versions set created_at = now() - interval '1 hour' where id = v_vb2;
  execute 'set local role authenticated';
  perform public.add_quote_sheet(v_vb2, v_sup_b);
  if not exists (select 1 from public.project_activity where project_id = v_project and action = 'sheet_added'
                 and summary = 'added the Q SUPPLIER B sheet to Builder B v2') then
    raise exception 'TEST FAILED: Adding a sheet must be logged!';
  end if;
  if exists (select 1 from public.project_activity where project_id = v_project and action = 'lines_edited'
             and version_id = v_vb2) then
    raise exception 'TEST FAILED: Lines copied into a new sheet must not be logged as edits!';
  end if;

  -- Back to Tender unlocks Builder A.
  perform set_config('request.jwt.claims', json_build_object('sub', v_pm, 'role', 'authenticated')::text, true);
  update public.projects set stage = 'tender' where id = v_project;
  perform set_config('request.jwt.claims', json_build_object('sub', v_est, 'role', 'authenticated')::text, true);
  perform public.save_project_lines(v_va2, jsonb_build_array(jsonb_build_object('id', v_line, 'qty_per_door', 9)));

  execute 'reset role';
  raise notice 'ALL QUOTE & SHEET SQL TESTS PASSED.';
end $$;

rollback;
