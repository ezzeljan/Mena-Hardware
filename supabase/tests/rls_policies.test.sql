-- =============================================================================
-- SQL Test Suite: Row Level Security & Trigger Verification
-- Checks that each role (admin, estimator, pm, viewer) can do ONLY what it should,
-- that new users default to 'viewer', and that unit_cost updates write to
-- part_price_history while preserving intentional NULL values.
-- =============================================================================

begin;

do $$
declare
  v_admin_id uuid := '00000000-0000-0000-0000-000000000001';
  v_estimator_id uuid := '00000000-0000-0000-0000-000000000002';
  v_pm_id uuid := '00000000-0000-0000-0000-000000000003';
  v_viewer_id uuid := '00000000-0000-0000-0000-000000000004';
  v_mfg_id uuid;
  v_part_id uuid;
  v_set_id uuid;
  v_line_id uuid;
  v_role public.user_role;
  v_count integer;
  v_updated integer;
  v_err boolean;
begin
  -- ---------------------------------------------------------------------------
  -- 1. Create test auth.users and verify handle_new_user() creates viewer profiles
  -- ---------------------------------------------------------------------------
  insert into auth.users (id, email, raw_user_meta_data)
  values
    (v_admin_id, 'admin.test@mena.local', '{"full_name": "Test Admin"}'::jsonb),
    (v_estimator_id, 'estimator.test@mena.local', '{"full_name": "Test Estimator"}'::jsonb),
    (v_pm_id, 'pm.test@mena.local', '{"full_name": "Test PM"}'::jsonb),
    (v_viewer_id, 'viewer.test@mena.local', '{"full_name": "Test Viewer"}'::jsonb);

  select role into v_role from public.profiles where id = v_viewer_id;
  if v_role is distinct from 'viewer' then
    raise exception 'TEST FAILED: Expected new user default role to be viewer, got %', v_role;
  end if;

  -- Promote admin, estimator, and pm via superuser (first-admin SQL step)
  update public.profiles set role = 'admin' where id = v_admin_id;
  update public.profiles set role = 'estimator' where id = v_estimator_id;
  update public.profiles set role = 'pm' where id = v_pm_id;

  -- ---------------------------------------------------------------------------
  -- 2. Test ADMIN permissions (can insert/update/delete across all tables)
  -- ---------------------------------------------------------------------------
  perform set_config('request.jwt.claim.sub', v_admin_id::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', v_admin_id::text, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';

  -- Admin can read all 4 test profiles
  select count(*) into v_count from public.profiles
  where id in (v_admin_id, v_estimator_id, v_pm_id, v_viewer_id);
  if v_count <> 4 then
    raise exception 'TEST FAILED: Admin should read all 4 test profiles, got %', v_count;
  end if;

  -- Admin can insert manufacturer
  insert into public.suppliers (name, is_owner_supplied)
  values ('TEST_MFG_RLS', false)
  returning id into v_mfg_id;

  -- Admin can insert part with NULL unit_cost
  insert into public.parts (sku, supplier_id, description, unit_cost, active)
  values ('TEST-SKU-RLS', v_mfg_id, 'NOVAS TEST PART', null, true)
  returning id into v_part_id;

  -- Verify no price history row was created on INSERT (trigger is UPDATE only)
  select count(*) into v_count from public.part_price_history where part_id = v_part_id;
  if v_count <> 0 then
    raise exception 'TEST FAILED: Expected 0 price history rows on INSERT, got %', v_count;
  end if;

  -- Admin updates unit_cost -> trigger writes 1 row to part_price_history
  update public.parts set unit_cost = 42.50 where id = v_part_id;
  select count(*) into v_count from public.part_price_history
  where part_id = v_part_id and unit_cost = 42.50 and changed_by = v_admin_id;
  if v_count <> 1 then
    raise exception 'TEST FAILED: Expected 1 price history row on unit_cost UPDATE, got %', v_count;
  end if;

  -- Admin CANNOT directly insert, update, or delete part_price_history (audit log is trigger-only)
  v_err := false;
  begin
    insert into public.part_price_history (part_id, unit_cost) values (v_part_id, 1.00);
  exception when insufficient_privilege then
    v_err := true;
  end;
  if not v_err then
    raise exception 'TEST FAILED: Admin should not be able to INSERT into part_price_history!';
  end if;

  update public.part_price_history set unit_cost = 1.00 where part_id = v_part_id;
  get diagnostics v_updated = row_count;
  if v_updated > 0 then
    raise exception 'TEST FAILED: Admin should not be able to UPDATE part_price_history!';
  end if;

  delete from public.part_price_history where part_id = v_part_id;
  get diagnostics v_updated = row_count;
  if v_updated > 0 then
    raise exception 'TEST FAILED: Admin should not be able to DELETE from part_price_history!';
  end if;

  -- Admin CANNOT change their own role
  update public.profiles set role = 'viewer' where id = v_admin_id;
  get diagnostics v_updated = row_count;
  if v_updated > 0 then
    raise exception 'TEST FAILED: Admin should not be able to change their own role!';
  end if;

  -- Admin CAN change another user's role
  update public.profiles set role = 'pm' where id = v_viewer_id;
  get diagnostics v_updated = row_count;
  if v_updated <> 1 then
    raise exception 'TEST FAILED: Admin should be able to update another user role!';
  end if;
  update public.profiles set role = 'viewer' where id = v_viewer_id;

  -- Admin can insert standard_set and standard_set_lines (including NULL unit_price)
  insert into public.standard_sets (room_name, classification, leaf, door_size)
  values ('TEST ROOM RLS', 'FIRE RATED', 'SINGLE', '2040 x 920')
  returning id into v_set_id;

  insert into public.standard_set_lines (set_id, position, sku, description, qty, unit_price)
  values (v_set_id, 1, 'TEST-SKU-RLS', 'NOVAS TEST PART', 2, null)
  returning id into v_line_id;

  -- Admin can reorder lines atomically via swap_standard_set_lines RPC
  declare
    v_line2_id uuid;
    v_pos1 integer;
  begin
    insert into public.standard_set_lines (set_id, position, sku, description, qty, unit_price)
    values (v_set_id, 2, 'TEST-SKU-RLS-2', 'NOVAS TEST PART 2', 1, 10)
    returning id into v_line2_id;

    perform public.swap_standard_set_lines(v_line_id, v_line2_id);
    select position into v_pos1 from public.standard_set_lines where id = v_line_id;
    if v_pos1 <> 2 then
      raise exception 'TEST FAILED: Expected line 1 position to swap to 2, got %', v_pos1;
    end if;
  end;

  -- ---------------------------------------------------------------------------
  -- 3. Test non-admin roles: VIEWER, ESTIMATOR, PM
  --    Must be able to SELECT library & sets, but CANNOT INSERT/UPDATE/DELETE
  -- ---------------------------------------------------------------------------
  for v_Count in 1..3 loop
    declare
      v_uid uuid := case v_Count
        when 1 then v_viewer_id
        when 2 then v_estimator_id
        when 3 then v_pm_id
      end;
      v_label text := case v_Count
        when 1 then 'viewer'
        when 2 then 'estimator'
        when 3 then 'pm'
      end;
    begin
      perform set_config('request.jwt.claim.sub', v_uid::text, true);
      perform set_config('request.jwt.claims', json_build_object('sub', v_uid::text, 'role', 'authenticated')::text, true);

      -- Can only read own profile (not other users)
      select count(*) into v_updated from public.profiles
      where id in (v_admin_id, v_estimator_id, v_pm_id, v_viewer_id);
      if v_updated <> 1 then
        raise exception 'TEST FAILED: % should only see 1 profile (own), saw %', v_label, v_updated;
      end if;

      -- Cannot escalate own role to admin
      update public.profiles set role = 'admin' where id = v_uid;
      get diagnostics v_updated = row_count;
      if v_updated > 0 then
        raise exception 'TEST FAILED: % was able to update own profile role!', v_label;
      end if;

      -- Can SELECT manufacturers, parts, standard_sets, standard_set_lines
      select count(*) into v_updated from public.suppliers where id = v_mfg_id;
      if v_updated <> 1 then
        raise exception 'TEST FAILED: % could not read manufacturers', v_label;
      end if;

      select count(*) into v_updated from public.parts where id = v_part_id;
      if v_updated <> 1 then
        raise exception 'TEST FAILED: % could not read parts', v_label;
      end if;

      select count(*) into v_updated from public.standard_sets where id = v_set_id;
      if v_updated <> 1 then
        raise exception 'TEST FAILED: % could not read standard_sets', v_label;
      end if;

      select count(*) into v_updated from public.standard_set_lines where id = v_line_id;
      if v_updated <> 1 then
        raise exception 'TEST FAILED: % could not read standard_set_lines', v_label;
      end if;

      -- Cannot INSERT, UPDATE, or DELETE manufacturer
      v_err := false;
      begin
        insert into public.suppliers (name) values ('UNAUTHORIZED_' || v_label);
      exception when insufficient_privilege then
        v_err := true;
      end;
      if not v_err then
        raise exception 'TEST FAILED: % was able to INSERT into manufacturers!', v_label;
      end if;

      update public.suppliers set name = 'HACKED' where id = v_mfg_id;
      get diagnostics v_updated = row_count;
      if v_updated > 0 then
        raise exception 'TEST FAILED: % was able to UPDATE manufacturers!', v_label;
      end if;

      delete from public.suppliers where id = v_mfg_id;
      get diagnostics v_updated = row_count;
      if v_updated > 0 then
        raise exception 'TEST FAILED: % was able to DELETE manufacturers!', v_label;
      end if;

      -- Cannot INSERT or DELETE profiles
      v_err := false;
      begin
        insert into public.profiles (id, full_name, role) values (gen_random_uuid(), 'FAKE', 'admin');
      exception when insufficient_privilege then
        v_err := true;
      end;
      if not v_err then
        raise exception 'TEST FAILED: % was able to INSERT into profiles!', v_label;
      end if;

      delete from public.profiles where id = v_uid;
      get diagnostics v_updated = row_count;
      if v_updated > 0 then
        raise exception 'TEST FAILED: % was able to DELETE from profiles!', v_label;
      end if;

      -- Cannot UPDATE part
      update public.parts set unit_cost = 999 where id = v_part_id;
      get diagnostics v_updated = row_count;
      if v_updated > 0 then
        raise exception 'TEST FAILED: % was able to UPDATE parts!', v_label;
      end if;

      -- Cannot DELETE part
      delete from public.parts where id = v_part_id;
      get diagnostics v_updated = row_count;
      if v_updated > 0 then
        raise exception 'TEST FAILED: % was able to DELETE parts!', v_label;
      end if;

      -- Cannot INSERT/UPDATE/DELETE standard_sets or standard_set_lines
      v_err := false;
      begin
        insert into public.standard_sets (room_name) values ('UNAUTHORIZED_SET');
      exception when insufficient_privilege then
        v_err := true;
      end;
      if not v_err then
        raise exception 'TEST FAILED: % was able to INSERT into standard_sets!', v_label;
      end if;

      update public.standard_sets set room_name = 'HACKED_SET' where id = v_set_id;
      get diagnostics v_updated = row_count;
      if v_updated > 0 then
        raise exception 'TEST FAILED: % was able to UPDATE standard_sets!', v_label;
      end if;

      delete from public.standard_sets where id = v_set_id;
      get diagnostics v_updated = row_count;
      if v_updated > 0 then
        raise exception 'TEST FAILED: % was able to DELETE standard_sets!', v_label;
      end if;

      update public.standard_set_lines set qty = 99 where id = v_line_id;
      get diagnostics v_updated = row_count;
      if v_updated > 0 then
        raise exception 'TEST FAILED: % was able to UPDATE standard_set_lines!', v_label;
      end if;

      delete from public.standard_set_lines where id = v_line_id;
      get diagnostics v_updated = row_count;
      if v_updated > 0 then
        raise exception 'TEST FAILED: % was able to DELETE standard_set_lines!', v_label;
      end if;
    end;
  end loop;

  execute 'reset role';
  raise notice 'ALL RLS & TRIGGER SQL TESTS PASSED (admin, estimator, pm, viewer verified).';
end $$;

rollback;
