-- =============================================================================
-- SQL Test Suite: deleting a builder's quote (migration 023)
--   1. Only an estimator assigned to the project (or an admin) can delete it.
--   2. Not while a version is waiting for PM review.
--   3. Deleting removes its versions, sheets, door groups and lines (approved
--      versions included); other quotes are untouched; the deletion is logged.
--   4. Not once the project is awarded.
-- =============================================================================

begin;

do $$
declare
  v_admin uuid := '00000000-0000-0000-0000-000000000081';
  v_pm uuid := '00000000-0000-0000-0000-000000000082';
  v_est uuid := '00000000-0000-0000-0000-000000000083';
  v_other_est uuid := '00000000-0000-0000-0000-000000000084';
  v_sup uuid;
  v_sup_b uuid;
  v_project uuid;
  v_va1 uuid;
  v_va2 uuid;
  v_vb1 uuid;
  v_vc1 uuid;
  v_quote_a uuid;
  v_quote_b uuid;
  v_quote_c uuid;
  v_count integer;
  v_err boolean;
  v_groups jsonb := '[{"position": 1, "group_key": "G1", "room_name": "Entry", "door_qty": 2,
                       "match_status": "manual", "match_reason": "Custom: Entry",
                       "lines": [{"position": 1, "sku": "S-1", "description": "Closer", "qty_per_door": 1,
                                  "unit_price": 10, "origin": "set", "part_id": null}]}]';
begin
  insert into auth.users (id, email, raw_user_meta_data) values
    (v_admin, 'd.admin@mena.local', '{"full_name": "D Admin"}'),
    (v_pm, 'd.pm@mena.local', '{"full_name": "D PM"}'),
    (v_est, 'd.est@mena.local', '{"full_name": "D Estimator"}'),
    (v_other_est, 'd.est2@mena.local', '{"full_name": "D Other Estimator"}');
  update public.profiles set role = 'admin' where id = v_admin;
  update public.profiles set role = 'pm' where id = v_pm;
  update public.profiles set role = 'estimator' where id in (v_est, v_other_est);
  insert into public.suppliers (name) values ('D SUPPLIER') returning id into v_sup;
  insert into public.suppliers (name) values ('D SUPPLIER B') returning id into v_sup_b;

  execute 'set local role authenticated';

  perform set_config('request.jwt.claims', json_build_object('sub', v_pm, 'role', 'authenticated')::text, true);
  insert into public.projects (reference_no, name, created_by) values ('D001', 'Delete Tower', v_pm)
  returning id into v_project;
  insert into public.project_estimators (project_id, estimator_id, assigned_by) values (v_project, v_est, v_pm);

  perform set_config('request.jwt.claims', json_build_object('sub', v_est, 'role', 'authenticated')::text, true);
  v_va1 := public.import_quotation(v_project, 'Builder A', v_sup, v_project::text || '/a.xlsx', 'a.xlsx', '{}', '[]', v_groups);
  v_vb1 := public.import_quotation(v_project, 'Builder B', v_sup, v_project::text || '/b.xlsx', 'b.xlsx', '{}', '[]', v_groups);
  v_vc1 := public.import_quotation(v_project, 'Builder C', v_sup, v_project::text || '/c.xlsx', 'c.xlsx', '{}', '[]', v_groups);
  select quote_id into v_quote_a from public.project_versions where id = v_va1;
  select quote_id into v_quote_b from public.project_versions where id = v_vb1;
  select quote_id into v_quote_c from public.project_versions where id = v_vc1;
  perform public.add_quote_sheet(v_va1, v_sup_b, null, null);

  -- 1. An estimator not on the project, and the PM, cannot delete it.
  perform set_config('request.jwt.claims', json_build_object('sub', v_other_est, 'role', 'authenticated')::text, true);
  v_err := false;
  begin
    perform public.delete_quote(v_quote_a);
  exception when others then v_err := true;
  end;
  if not v_err then
    raise exception 'TEST FAILED: An estimator not assigned to the project must not delete its quotes!';
  end if;

  perform set_config('request.jwt.claims', json_build_object('sub', v_pm, 'role', 'authenticated')::text, true);
  v_err := false;
  begin
    perform public.delete_quote(v_quote_a);
  exception when others then v_err := true;
  end;
  if not v_err then
    raise exception 'TEST FAILED: The PM must not delete quotes (estimator feature)!';
  end if;

  -- 2. Not while waiting for PM review.
  perform set_config('request.jwt.claims', json_build_object('sub', v_est, 'role', 'authenticated')::text, true);
  perform public.transition_version(v_va1, 'submit', '');
  v_err := false;
  begin
    perform public.delete_quote(v_quote_a);
  exception when others then
    v_err := sqlerrm like '%waiting for PM review%';
  end;
  if not v_err then
    raise exception 'TEST FAILED: A quote with a version waiting for PM review must not be deleted!';
  end if;

  -- 3. Approved v1 + draft v2, two sheets: all of it goes.
  perform set_config('request.jwt.claims', json_build_object('sub', v_pm, 'role', 'authenticated')::text, true);
  perform public.transition_version(v_va1, 'approve', '');
  perform set_config('request.jwt.claims', json_build_object('sub', v_est, 'role', 'authenticated')::text, true);
  v_va2 := public.create_revision(v_va1);
  perform public.delete_quote(v_quote_a);

  if exists (select 1 from public.hardware_quotes where id = v_quote_a)
     or exists (select 1 from public.project_versions where quote_id = v_quote_a)
     or exists (select 1 from public.quote_sheets where version_id in (v_va1, v_va2))
     or exists (select 1 from public.door_groups where version_id in (v_va1, v_va2)) then
    raise exception 'TEST FAILED: Deleting a quote must remove its versions, sheets and door groups!';
  end if;

  select count(*) into v_count from public.project_lines l
  join public.door_groups g on g.id = l.group_id where g.version_id = v_vb1;
  if v_count <> 1 or not exists (select 1 from public.hardware_quotes where id = v_quote_b) then
    raise exception 'TEST FAILED: Other quotes must be untouched!';
  end if;

  if not exists (
    select 1 from public.project_activity
    where project_id = v_project and action = 'quote_deleted' and actor_id = v_est
      and summary = 'deleted Builder A''s quote (2 versions)'
  ) then
    raise exception 'TEST FAILED: Deleting a quote must be logged in the activity!';
  end if;

  -- An admin can delete too.
  perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  perform public.delete_quote(v_quote_c);
  if exists (select 1 from public.hardware_quotes where id = v_quote_c) then
    raise exception 'TEST FAILED: An admin must be able to delete a quote!';
  end if;

  -- 4. Once awarded, no quote can be deleted.
  perform set_config('request.jwt.claims', json_build_object('sub', v_est, 'role', 'authenticated')::text, true);
  perform public.transition_version(v_vb1, 'submit', '');
  perform set_config('request.jwt.claims', json_build_object('sub', v_pm, 'role', 'authenticated')::text, true);
  perform public.transition_version(v_vb1, 'approve', '');
  update public.projects set stage = 'awarded', awarded_quote_id = v_quote_b, awarded_supplier_id = v_sup
  where id = v_project;
  perform set_config('request.jwt.claims', json_build_object('sub', v_est, 'role', 'authenticated')::text, true);
  v_err := false;
  begin
    perform public.delete_quote(v_quote_b);
  exception when others then
    v_err := sqlerrm like '%awarded%';
  end;
  if not v_err then
    raise exception 'TEST FAILED: Quotes of an awarded project must not be deleted!';
  end if;

  raise notice 'delete_quote tests passed';
end;
$$;

rollback;
