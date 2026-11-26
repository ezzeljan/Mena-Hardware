-- =============================================================================
-- SQL Test Suite: generic set items (migration 027)
--   1. The clean-up's generic items are back, and set lines name them again
--      (no set line uses a part the clean-up replaced a generic item with).
--   2. Everyone signed in reads generic items and preferred parts; only
--      admins change them.
--   3. A preferred part must be one of that supplier's parts.
-- =============================================================================

begin;

do $$
declare
  v_admin uuid := '00000000-0000-0000-0000-0000000000a1';
  v_est uuid := '00000000-0000-0000-0000-0000000000a2';
  v_sup uuid;
  v_other uuid;
  v_part uuid;
  v_generic uuid;
  v_count integer;
  v_err boolean;
begin
  -- 1. Data.
  select count(*) into v_count from public.generic_items;
  if v_count < 46 then
    raise exception 'TEST FAILED: expected the 46 generic items, found %', v_count;
  end if;
  select count(*) into v_count from public.standard_set_lines l
  join public.generic_items g on g.id = l.generic_id
  where upper(btrim(l.sku)) <> upper(btrim(g.code));
  if v_count > 0 then
    raise exception 'TEST FAILED: % set lines link a generic item but name something else', v_count;
  end if;
  select count(*) into v_count from public.standard_set_lines where upper(btrim(sku)) in ('B0163SSS', '6115SSS', '1500BCSIL');
  if v_count > 0 then
    raise exception 'TEST FAILED: % set lines still name a part the clean-up used for a generic item', v_count;
  end if;
  select count(*) into v_count from public.generic_item_parts gp
  join public.generic_items g on g.id = gp.generic_id
  join public.parts p on p.id = gp.part_id
  where g.code = 'PASSSETLEVR' and p.sku = 'B0163SSS';
  if v_count <> 1 then
    raise exception 'TEST FAILED: PASSSETLEVR should prefer B0163SSS';
  end if;

  insert into auth.users (id, email, raw_user_meta_data) values
    (v_admin, 'g.admin@mena.local', '{"full_name": "G Admin"}'),
    (v_est, 'g.est@mena.local', '{"full_name": "G Estimator"}');
  update public.profiles set role = 'admin' where id = v_admin;
  update public.profiles set role = 'estimator' where id = v_est;

  insert into public.suppliers (name) values ('G SUPPLIER') returning id into v_sup;
  insert into public.suppliers (name) values ('G OTHER') returning id into v_other;
  insert into public.parts (sku, supplier_id, description, unit_cost, active)
  values ('G-PART-1', v_sup, 'G TEST PASSAGE SET', 10, true) returning id into v_part;

  execute 'set local role authenticated';

  -- 2. Estimators read but cannot write.
  perform set_config('request.jwt.claims', json_build_object('sub', v_est, 'role', 'authenticated')::text, true);
  select count(*) into v_count from public.generic_items;
  if v_count < 46 then
    raise exception 'TEST FAILED: estimators should read generic items';
  end if;
  v_err := false;
  begin
    insert into public.generic_items (code, description) values ('G-EST', 'G EST ITEM');
  exception when insufficient_privilege then
    v_err := true;
  end;
  if not v_err then
    raise exception 'TEST FAILED: estimators must not add generic items';
  end if;

  -- Admins can.
  perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  insert into public.generic_items (code, description) values ('G-ITEM', 'G TEST ITEM') returning id into v_generic;
  insert into public.generic_item_parts (generic_id, supplier_id, part_id) values (v_generic, v_sup, v_part);

  -- 3. The part must be that supplier's.
  v_err := false;
  begin
    insert into public.generic_item_parts (generic_id, supplier_id, part_id) values (v_generic, v_other, v_part);
  exception when check_violation then
    v_err := true;
  end;
  if not v_err then
    raise exception 'TEST FAILED: a preferred part from another supplier must be rejected';
  end if;

  execute 'reset role';
  raise notice 'ALL GENERIC SET ITEM SQL TESTS PASSED.';
end $$;

rollback;
