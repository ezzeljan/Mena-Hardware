-- =============================================================================
-- SQL Test Suite: project stage (migration 017)
--   New projects start at Tender; the assigned PM (and admins) can move them to
--   Awarded and back; estimators and other PMs cannot; only Tender / Awarded
--   are allowed; every change is logged in the project activity.
-- =============================================================================

begin;

do $$
declare
  v_admin uuid := '00000000-0000-0000-0000-000000000051';
  v_pm uuid := '00000000-0000-0000-0000-000000000052';
  v_other_pm uuid := '00000000-0000-0000-0000-000000000053';
  v_est uuid := '00000000-0000-0000-0000-000000000054';
  v_project uuid;
  v_stage text;
  v_err boolean;
begin
  insert into auth.users (id, email, raw_user_meta_data) values
    (v_admin, 's.admin@mena.local', '{"full_name": "S Admin"}'),
    (v_pm, 's.pm@mena.local', '{"full_name": "S PM"}'),
    (v_other_pm, 's.pm2@mena.local', '{"full_name": "S Other PM"}'),
    (v_est, 's.est@mena.local', '{"full_name": "S Estimator"}');
  update public.profiles set role = 'admin' where id = v_admin;
  update public.profiles set role = 'pm' where id in (v_pm, v_other_pm);
  update public.profiles set role = 'estimator' where id = v_est;

  execute 'set local role authenticated';

  perform set_config('request.jwt.claims', json_build_object('sub', v_pm, 'role', 'authenticated')::text, true);
  insert into public.projects (reference_no, name, created_by) values ('S001', 'Stage Tower', v_pm)
  returning id, stage into v_project, v_stage;
  if v_stage <> 'tender' then
    raise exception 'TEST FAILED: New projects must start at Tender (got %)', v_stage;
  end if;
  insert into public.project_estimators (project_id, estimator_id, assigned_by) values (v_project, v_est, v_pm);

  -- The assigned PM moves it to Awarded.
  update public.projects set stage = 'awarded' where id = v_project;
  select stage into v_stage from public.projects where id = v_project;
  if v_stage <> 'awarded' then
    raise exception 'TEST FAILED: The assigned PM must be able to change the stage!';
  end if;
  if not exists (select 1 from public.project_activity where project_id = v_project and action = 'stage_changed'
                 and actor_id = v_pm and details->>'from' = 'tender' and details->>'to' = 'awarded'
                 and summary = 'moved the project to Awarded') then
    raise exception 'TEST FAILED: The stage change was not logged!';
  end if;

  -- Only Tender / Awarded.
  v_err := false;
  begin
    update public.projects set stage = 'lost' where id = v_project;
  exception when check_violation then
    v_err := true;
  end;
  if not v_err then
    raise exception 'TEST FAILED: Stages other than Tender / Awarded must be rejected!';
  end if;

  -- The estimator and another PM cannot change it (no rows updated).
  perform set_config('request.jwt.claims', json_build_object('sub', v_est, 'role', 'authenticated')::text, true);
  update public.projects set stage = 'tender' where id = v_project;
  perform set_config('request.jwt.claims', json_build_object('sub', v_other_pm, 'role', 'authenticated')::text, true);
  update public.projects set stage = 'tender' where id = v_project;
  perform set_config('request.jwt.claims', json_build_object('sub', v_pm, 'role', 'authenticated')::text, true);
  select stage into v_stage from public.projects where id = v_project;
  if v_stage <> 'awarded' then
    raise exception 'TEST FAILED: Only the assigned PM or an admin may change the stage!';
  end if;

  -- An admin can change it back.
  perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  update public.projects set stage = 'tender' where id = v_project;
  select stage into v_stage from public.projects where id = v_project;
  if v_stage <> 'tender' then
    raise exception 'TEST FAILED: An admin must be able to change the stage!';
  end if;

  execute 'reset role';
  raise notice 'ALL PROJECT STAGE SQL TESTS PASSED.';
end $$;

rollback;
