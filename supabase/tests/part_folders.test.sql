-- =============================================================================
-- SQL Test Suite: part folders, legends and automatic swapping (migration 022)
--   1. Everyone signed in reads folders; only admins create / rename / delete.
--   2. Deleting a folder leaves its parts unfiled.
--   3. supplier_equivalent_part: exactly one active part from the supplier in
--      the same folder; never for owner-supplied parts.
--   4. add_quote_sheet swaps lines to the new supplier's part (SKU,
--      description, unit cost, "edited"); keeps the line when there is no
--      single equivalent or the part is owner-supplied.
--   5. import_quotation: new lines take the first sheet's supplier part.
-- =============================================================================

begin;

do $$
declare
  v_admin uuid := '00000000-0000-0000-0000-000000000091';
  v_pm uuid := '00000000-0000-0000-0000-000000000092';
  v_est uuid := '00000000-0000-0000-0000-000000000093';
  v_novas uuid;
  v_lockwood uuid;
  v_geze uuid;
  v_mm uuid;
  v_closers uuid;
  v_stops uuid;
  v_tmp uuid;
  v_nv_closer uuid;
  v_lw_closer uuid;
  v_geze_a uuid;
  v_geze_b uuid;
  v_mm_hinge uuid;
  v_project uuid;
  v_version uuid;
  v_sheet uuid;
  v_count integer;
  v_err boolean;
  v_line record;
begin
  insert into auth.users (id, email, raw_user_meta_data) values
    (v_admin, 'f.admin@mena.local', '{"full_name": "F Admin"}'),
    (v_pm, 'f.pm@mena.local', '{"full_name": "F PM"}'),
    (v_est, 'f.est@mena.local', '{"full_name": "F Estimator"}');
  update public.profiles set role = 'admin' where id = v_admin;
  update public.profiles set role = 'pm' where id = v_pm;
  update public.profiles set role = 'estimator' where id = v_est;

  insert into public.suppliers (name) values ('F NOVAS') returning id into v_novas;
  insert into public.suppliers (name) values ('F LOCKWOOD') returning id into v_lockwood;
  insert into public.suppliers (name) values ('F GEZE') returning id into v_geze;
  insert into public.suppliers (name, is_owner_supplied) values ('F MM', true) returning id into v_mm;

  execute 'set local role authenticated';

  -- 1. Folders: admins only.
  perform set_config('request.jwt.claims', json_build_object('sub', v_est, 'role', 'authenticated')::text, true);
  v_err := false;
  begin
    insert into public.part_folders (name) values ('Estimator folder');
  exception when insufficient_privilege then
    v_err := true;
  end;
  if not v_err then
    raise exception 'TEST FAILED: Estimators must not create folders!';
  end if;

  perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  insert into public.part_folders (name, position) values ('F Door closers', 1) returning id into v_closers;
  insert into public.part_folders (name, position) values ('F Hinges', 2) returning id into v_stops;

  v_err := false;
  begin
    insert into public.part_folders (name) values ('  f door CLOSERS ');
  exception when unique_violation then
    v_err := true;
  end;
  if not v_err then
    raise exception 'TEST FAILED: Folder names must be unique (case-insensitive)!';
  end if;

  insert into public.parts (sku, supplier_id, description, unit_cost, folder_id, legend)
  values ('F-NV-1500', v_novas, 'NOVAS 1500 CLOSER', 120, v_closers, 'C4') returning id into v_nv_closer;
  insert into public.parts (sku, supplier_id, description, unit_cost, folder_id, legend)
  values ('F-LW-726', v_lockwood, 'LOCKWOOD 726 CLOSER', null, v_closers, 'C18') returning id into v_lw_closer;
  insert into public.parts (sku, supplier_id, description, unit_cost, folder_id)
  values ('F-GZ-A', v_geze, 'GEZE CLOSER A', 90, v_closers) returning id into v_geze_a;
  insert into public.parts (sku, supplier_id, description, unit_cost, folder_id)
  values ('F-GZ-B', v_geze, 'GEZE CLOSER B', 95, v_closers) returning id into v_geze_b;
  insert into public.parts (sku, supplier_id, description, unit_cost, folder_id, legend)
  values ('F-MM-HINGE', v_mm, 'MM HINGE', 4, v_stops, 'MM') returning id into v_mm_hinge;
  -- An inactive Lockwood hinge must not count.
  insert into public.parts (sku, supplier_id, description, unit_cost, folder_id, active)
  values ('F-LW-HINGE', v_lockwood, 'LOCKWOOD HINGE', 5, v_stops, false);

  -- Estimators read folders.
  perform set_config('request.jwt.claims', json_build_object('sub', v_est, 'role', 'authenticated')::text, true);
  select count(*) into v_count from public.part_folders where id in (v_closers, v_stops);
  if v_count <> 2 then
    raise exception 'TEST FAILED: Everyone signed in must read folders (saw %)', v_count;
  end if;

  -- 3. Equivalents.
  if public.supplier_equivalent_part(v_nv_closer, null, v_lockwood) is distinct from v_lw_closer then
    raise exception 'TEST FAILED: The single Lockwood closer in the folder must be the equivalent!';
  end if;
  if public.supplier_equivalent_part(null, 'f-nv-1500', v_lockwood) is distinct from v_lw_closer then
    raise exception 'TEST FAILED: The equivalent must also be found by SKU!';
  end if;
  if public.supplier_equivalent_part(v_nv_closer, null, v_geze) is not null then
    raise exception 'TEST FAILED: Two GEZE closers in the folder: no automatic equivalent!';
  end if;
  if public.supplier_equivalent_part(v_mm_hinge, null, v_lockwood) is not null then
    raise exception 'TEST FAILED: Owner-supplied parts are never swapped (and inactive parts never count)!';
  end if;
  if public.supplier_equivalent_part(v_nv_closer, null, v_novas) is not null then
    raise exception 'TEST FAILED: A part already from the supplier must not swap!';
  end if;

  -- 5. Import: the first sheet is Lockwood, the set lines are NOVAS / MM.
  perform set_config('request.jwt.claims', json_build_object('sub', v_pm, 'role', 'authenticated')::text, true);
  insert into public.projects (reference_no, name, created_by) values ('F001', 'Folder Tower', v_pm)
  returning id into v_project;
  insert into public.project_estimators (project_id, estimator_id, assigned_by) values (v_project, v_est, v_pm);

  perform set_config('request.jwt.claims', json_build_object('sub', v_est, 'role', 'authenticated')::text, true);
  v_version := public.import_quotation(v_project, 'Builder F', v_lockwood, v_project::text || '/f.xlsx', 'f.xlsx', '{}', '[]',
    jsonb_build_array(jsonb_build_object('position', 1, 'group_key', 'G1', 'room_name', 'ENTRY', 'door_qty', 1,
      'match_status', 'manual', 'match_reason', 'Custom: Entry',
      'lines', jsonb_build_array(
        jsonb_build_object('position', 1, 'sku', 'F-NV-1500', 'description', 'NOVAS 1500 CLOSER', 'qty_per_door', 1,
          'unit_price', 120, 'origin', 'set', 'part_id', v_nv_closer),
        jsonb_build_object('position', 2, 'sku', 'F-MM-HINGE', 'description', 'MM HINGE', 'qty_per_door', 3,
          'unit_price', 4, 'origin', 'set', 'part_id', v_mm_hinge)))));
  select id into v_sheet from public.quote_sheets where version_id = v_version;

  select * into v_line from public.project_lines where sheet_id = v_sheet and position = 1;
  if v_line.part_id <> v_lw_closer or v_line.sku <> 'F-LW-726' or v_line.unit_price is not null
     or v_line.origin <> 'edited' then
    raise exception 'TEST FAILED: The import must swap the closer to Lockwood (blank price, edited), got % % % %',
      v_line.sku, v_line.unit_price, v_line.origin, v_line.part_id;
  end if;
  select * into v_line from public.project_lines where sheet_id = v_sheet and position = 2;
  if v_line.part_id <> v_mm_hinge or v_line.unit_price <> 4 or v_line.origin <> 'set' then
    raise exception 'TEST FAILED: The MM hinge must stay as it is on import!';
  end if;

  -- 4. Add a NOVAS sheet from the Lockwood one: closer swaps back, hinge stays.
  v_tmp := public.add_quote_sheet(v_version, v_novas);
  select * into v_line from public.project_lines where sheet_id = v_tmp and position = 1;
  if v_line.part_id <> v_nv_closer or v_line.sku <> 'F-NV-1500' or v_line.description <> 'NOVAS 1500 CLOSER'
     or v_line.unit_price <> 120 then
    raise exception 'TEST FAILED: Add sheet must swap the closer to the NOVAS part (got % %)', v_line.sku, v_line.unit_price;
  end if;
  select * into v_line from public.project_lines where sheet_id = v_tmp and position = 2;
  if v_line.part_id <> v_mm_hinge or v_line.qty_per_door <> 3 then
    raise exception 'TEST FAILED: Add sheet must keep the MM hinge!';
  end if;

  -- Two GEZE closers: the line is copied unchanged.
  v_tmp := public.add_quote_sheet(v_version, v_geze);
  select * into v_line from public.project_lines where sheet_id = v_tmp and position = 1;
  if v_line.part_id <> v_lw_closer then
    raise exception 'TEST FAILED: Without a single GEZE equivalent the line must be copied as it is!';
  end if;

  -- 2. Deleting a folder leaves its parts unfiled.
  perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  delete from public.part_folders where id = v_stops;
  if (select folder_id from public.parts where id = v_mm_hinge) is not null then
    raise exception 'TEST FAILED: Parts of a deleted folder must become unfiled!';
  end if;

  -- Legend length.
  v_err := false;
  begin
    update public.parts set legend = repeat('X', 21) where id = v_nv_closer;
  exception when check_violation then
    v_err := true;
  end;
  if not v_err then
    raise exception 'TEST FAILED: Legends longer than 20 characters must be rejected!';
  end if;

  execute 'reset role';
  raise notice 'ALL PART FOLDER SQL TESTS PASSED.';
end $$;

rollback;
