-- =============================================================================
-- SQL Test Suite: merge / unmerge door groups (migration 026)
--   Merge sums door qty, keeps the chosen lines (own kept + others copied),
--   moves PM comments, remembers the originals; unmerge restores each with
--   its own room / qty / key and the merged group's specs and lines on every
--   sheet. Only the team, only a draft.
-- =============================================================================

begin;

do $$
declare
  v_supplier uuid;
  v_supplier_b uuid;
  v_pm uuid := '00000000-0000-0000-0000-0000000000a1';
  v_est uuid := '00000000-0000-0000-0000-0000000000a2';
  v_other uuid := '00000000-0000-0000-0000-0000000000a3';
  v_project uuid;
  v_version uuid;
  v_g1 uuid;
  v_g2 uuid;
  v_g3 uuid;
  v_keep uuid[];
  v_copy uuid[];
  v_count integer;
  v_err boolean;
  v_groups jsonb := '[
    {"position": 1, "group_key": "* | LINEN | NON RATED | SINGLE | 2040x770", "room_name": "Linen", "door_qty": 10,
     "match_status": "manual", "match_reason": "Custom: Linen",
     "lines": [{"position": 1, "sku": "H-1", "description": "Hinge", "qty_per_door": 3, "unit_price": 5, "origin": "set"},
               {"position": 2, "sku": "DS-1", "description": "Door stop", "qty_per_door": 1, "unit_price": 3, "origin": "set"}]},
    {"position": 2, "group_key": "* | BROOM | NON RATED | SINGLE | 2040x770", "room_name": "Broom", "door_qty": 1,
     "match_status": "manual", "match_reason": "Custom: Broom",
     "lines": [{"position": 1, "sku": "H-1", "description": "Hinge", "qty_per_door": 3, "unit_price": 5, "origin": "set"},
               {"position": 2, "sku": "KP-1", "description": "Kick plate", "qty_per_door": 1, "unit_price": 40, "origin": "set"}]},
    {"position": 3, "group_key": "* | STORE | NON RATED | SINGLE | 2040x820", "room_name": "Store", "door_qty": 2,
     "match_status": "manual", "match_reason": "Custom: Store", "lines": []}]';
begin
  insert into auth.users (id, email, raw_user_meta_data) values
    (v_pm, 'm.pm@mena.local', '{"full_name": "M PM"}'),
    (v_est, 'm.est@mena.local', '{"full_name": "M Estimator"}'),
    (v_other, 'm.other@mena.local', '{"full_name": "M Other"}');
  update public.profiles set role = 'pm' where id = v_pm;
  update public.profiles set role = 'estimator' where id in (v_est, v_other);
  insert into public.suppliers (name) values ('M SUPPLIER A') returning id into v_supplier;
  insert into public.suppliers (name) values ('M SUPPLIER B') returning id into v_supplier_b;

  execute 'set local role authenticated';
  perform set_config('request.jwt.claims', json_build_object('sub', v_pm, 'role', 'authenticated')::text, true);
  insert into public.projects (reference_no, name, created_by, assigned_pm) values ('M001', 'Merge Tower', v_pm, v_pm)
  returning id into v_project;
  insert into public.project_estimators (project_id, estimator_id, assigned_by) values (v_project, v_est, v_pm);

  perform set_config('request.jwt.claims', json_build_object('sub', v_est, 'role', 'authenticated')::text, true);
  v_version := public.import_quotation(v_project, 'Builder A', v_supplier, v_project::text || '/m.xlsx', 'm.xlsx', '{}', '[]', v_groups);
  perform public.add_quote_sheet(v_version, v_supplier_b, null, null); -- a second sheet: lines copied
  select id into v_g1 from public.door_groups where version_id = v_version and room_name = 'Linen';
  select id into v_g2 from public.door_groups where version_id = v_version and room_name = 'Broom';
  select id into v_g3 from public.door_groups where version_id = v_version and room_name = 'Store';
  -- PM comments (only the PM posts them).
  perform set_config('request.jwt.claims', json_build_object('sub', v_pm, 'role', 'authenticated')::text, true);
  insert into public.version_comments (version_id, door_group_id, author_id, body)
  values (v_version, v_g2, v_pm, 'Check the broom door');
  perform set_config('request.jwt.claims', json_build_object('sub', v_est, 'role', 'authenticated')::text, true);

  -- Merge Broom into Linen: keep Linen's hinge (both have it), drop its door stop,
  -- include Broom's kick plate (on both sheets).
  select array_agg(id) into v_keep from public.project_lines where group_id = v_g1 and sku = 'H-1';
  select array_agg(id) into v_copy from public.project_lines where group_id = v_g2 and sku = 'KP-1';
  perform public.merge_door_groups(v_g1, array[v_g2], 'Linen / Broom', v_keep, v_copy);

  if (select door_qty from public.door_groups where id = v_g1) <> 11 then
    raise exception 'TEST FAILED: Merge must add up the door qty!';
  end if;
  if (select room_name from public.door_groups where id = v_g1) <> 'Linen / Broom' then
    raise exception 'TEST FAILED: Merge must set the room name!';
  end if;
  if exists (select 1 from public.door_groups where id = v_g2) then
    raise exception 'TEST FAILED: The merged-in group must be gone!';
  end if;
  select count(*) into v_count from public.project_lines where group_id = v_g1;
  if v_count <> 4 or exists (select 1 from public.project_lines where group_id = v_g1 and sku = 'DS-1')
     or (select count(*) from public.project_lines where group_id = v_g1 and sku = 'KP-1') <> 2 then
    raise exception 'TEST FAILED: Merge must keep hinge + kick plate on both sheets (got % lines)', v_count;
  end if;
  if (select door_group_id from public.version_comments where body = 'Check the broom door') <> v_g1 then
    raise exception 'TEST FAILED: PM comments must move to the merged group!';
  end if;
  if jsonb_array_length((select merged_from from public.door_groups where id = v_g1)) <> 2 then
    raise exception 'TEST FAILED: Merge must remember both groups!';
  end if;

  -- Another estimator (not on the team) cannot unmerge it.
  perform set_config('request.jwt.claims', json_build_object('sub', v_other, 'role', 'authenticated')::text, true);
  v_err := false;
  begin
    perform public.unmerge_door_group(v_g1);
  exception when others then
    v_err := true;
  end;
  if not v_err then
    raise exception 'TEST FAILED: Someone outside the team must not unmerge!';
  end if;
  perform set_config('request.jwt.claims', json_build_object('sub', v_est, 'role', 'authenticated')::text, true);

  -- Unmerge: Linen 10 and Broom 1 again, both with the current hardware.
  perform public.unmerge_door_group(v_g1);
  if (select door_qty from public.door_groups where id = v_g1) <> 10
     or (select room_name from public.door_groups where id = v_g1) <> 'Linen'
     or (select group_key from public.door_groups where id = v_g1) <> '* | LINEN | NON RATED | SINGLE | 2040x770'
     or jsonb_array_length((select merged_from from public.door_groups where id = v_g1)) <> 0 then
    raise exception 'TEST FAILED: Unmerge must restore the first group!';
  end if;
  select id into v_g2 from public.door_groups where version_id = v_version and room_name = 'Broom';
  if v_g2 is null or (select door_qty from public.door_groups where id = v_g2) <> 1
     or (select group_key from public.door_groups where id = v_g2) <> '* | BROOM | NON RATED | SINGLE | 2040x770' then
    raise exception 'TEST FAILED: Unmerge must restore the other group with its own qty and key!';
  end if;
  if (select count(*) from public.project_lines where group_id = v_g2) <> 4
     or (select count(*) from public.project_lines where group_id = v_g2 and sku = 'KP-1') <> 2 then
    raise exception 'TEST FAILED: The restored group must get the current lines on every sheet!';
  end if;
  -- It sits right after the first group; the rest move down.
  if (select position from public.door_groups where id = v_g2) <> (select position from public.door_groups where id = v_g1) + 1
     or (select position from public.door_groups where id = v_g3) <= (select position from public.door_groups where id = v_g2) then
    raise exception 'TEST FAILED: The restored group must follow the first one!';
  end if;

  v_err := false;
  begin
    perform public.unmerge_door_group(v_g3);
  exception when invalid_parameter_value then
    v_err := true;
  end;
  if not v_err then
    raise exception 'TEST FAILED: A group that was not merged cannot be unmerged!';
  end if;

  -- Only a draft: after submitting, merging is refused.
  perform public.transition_version(v_version, 'submit', '');
  v_err := false;
  begin
    perform public.merge_door_groups(v_g1, array[v_g2], 'Linen / Broom', '{}', '{}');
  exception when others then
    v_err := true;
  end;
  if not v_err then
    raise exception 'TEST FAILED: Merging must be refused outside a draft!';
  end if;

  execute 'reset role';
  raise notice 'ALL MERGE DOOR GROUP SQL TESTS PASSED.';
end $$;

rollback;
