-- =============================================================================
-- Migration: 20261118000011_atomic_version_functions.sql
-- Purpose: Move multi-step writes into single database functions so each one
--          either completes fully or not at all.
--
--   transition_version(version, action, comment)
--       submit / approve / reject: status change + approval event together.
--   create_revision(source_version)
--       new draft (next version_no under a lock) + copied door groups and
--       lines + source marked superseded, together.
--   import_quotation(project, storage_path, filename, parse_report, doors, groups)
--       upload record + doors + version 1 + door groups + lines, together.
--   save_project_lines(version, lines)
--       batch line edits (autosave, reordering) in one call.
--
-- All functions are SECURITY INVOKER: the caller's RLS policies and the
-- draft-lock triggers still apply. They add clear permission messages and
-- run everything in one transaction.
--
-- Version status can now only change through transition_version() and
-- create_revision(), so every status change has its approval event.
--
-- Also (B9): standard_sets.leaf accepts 'CAVITY DOUBLE' and 'TRIPLE', which
-- the quotation parser produces, so standard sets can exist for those doors.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 0. B9: allow every leaf value the quotation parser produces
-- -----------------------------------------------------------------------------
do $$
declare
  r record;
begin
  for r in
    select conname
    from pg_constraint
    where conrelid = 'public.standard_sets'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%leaf%'
  loop
    execute format('alter table public.standard_sets drop constraint %I', r.conname);
  end loop;
end $$;

alter table public.standard_sets
  add constraint standard_sets_leaf_check
  check (leaf in ('SINGLE', 'DOUBLE', 'CAVITY SINGLE', 'CAVITY DOUBLE', 'TRIPLE', ''));

-- -----------------------------------------------------------------------------
-- 1. Status changes only through the functions below
-- -----------------------------------------------------------------------------
create or replace function public.enforce_version_status_transition()
returns trigger
language plpgsql
as $$
begin
  if new.status is distinct from old.status
     and coalesce(current_setting('app.version_transition', true), '') <> 'on' then
    raise exception 'Change a version''s status with transition_version() or create_revision()'
      using errcode = '42501';
  end if;

  if old.status in ('approved', 'superseded') and new.status is distinct from 'superseded' then
    raise exception 'Cannot transition version from "%" to "%"', old.status, new.status
      using errcode = '42501';
  end if;

  if old.status = 'changes_requested' and new.status is distinct from 'superseded' then
    raise exception 'Create a new draft version instead of editing a "%" version', old.status
      using errcode = '42501';
  end if;

  if old.status = 'draft' and new.status = 'submitted' and new.submitted_at is null then
    new.submitted_at = now();
  end if;

  return new;
end;
$$;

-- Serialises version creation per project (version_no, single draft).
create or replace function public.lock_project_versions(p_project_id uuid)
returns void
language sql
as $$
  select pg_advisory_xact_lock(hashtextextended('project_versions:' || p_project_id::text, 0));
$$;

-- -----------------------------------------------------------------------------
-- 2. transition_version: submit / approve / reject
-- -----------------------------------------------------------------------------
create or replace function public.transition_version(
  p_version_id uuid,
  p_action public.approval_action,
  p_comment text default ''
)
returns public.project_versions
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_version public.project_versions;
  v_from public.version_status;
  v_to public.version_status;
  v_comment text := coalesce(btrim(p_comment), '');
  v_updated integer;
begin
  if auth.uid() is null then
    raise exception 'Not signed in' using errcode = '42501';
  end if;

  select * into v_version from public.project_versions where id = p_version_id;
  if not found then
    raise exception 'Version not found' using errcode = 'P0002';
  end if;

  if p_action = 'submit' then
    if not public.can_edit_project_content(v_version.project_id) then
      raise exception 'Only an estimator assigned to this project (or an admin) can submit it'
        using errcode = '42501';
    end if;
    if v_version.upload_id is null then
      raise exception 'Import the quotation before submitting' using errcode = '22023';
    end if;
    v_from := 'draft';
    v_to := 'submitted';
  else
    if not public.can_review_project(v_version.project_id) then
      raise exception 'Only this project''s PM (or an admin) can approve or request changes'
        using errcode = '42501';
    end if;
    if p_action = 'reject' and v_comment = '' then
      raise exception 'A comment is required when requesting changes' using errcode = '22023';
    end if;
    v_from := 'submitted';
    v_to := case when p_action = 'approve' then 'approved' else 'changes_requested' end;
  end if;

  perform set_config('app.version_transition', 'on', true);

  update public.project_versions
  set status = v_to
  where id = p_version_id and status = v_from
  returning * into v_version;
  get diagnostics v_updated = row_count; -- read before PERFORM, which resets FOUND

  perform set_config('app.version_transition', 'off', true);

  if v_updated = 0 then
    raise exception 'This version is no longer "%" — refresh the page and try again', v_from
      using errcode = '40001';
  end if;

  insert into public.approval_events (version_id, action, actor, comment)
  values (p_version_id, p_action, auth.uid(), v_comment);

  return v_version;
end;
$$;

-- -----------------------------------------------------------------------------
-- 3. create_revision: new draft from an approved / changes-requested version
-- -----------------------------------------------------------------------------
create or replace function public.create_revision(p_source_version_id uuid)
returns uuid
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_source public.project_versions;
  v_new_id uuid;
  v_next_no integer;
begin
  if auth.uid() is null then
    raise exception 'Not signed in' using errcode = '42501';
  end if;

  select * into v_source from public.project_versions where id = p_source_version_id;
  if not found then
    raise exception 'Version not found' using errcode = 'P0002';
  end if;

  if not public.can_edit_project_content(v_source.project_id) then
    raise exception 'Only an estimator assigned to this project (or an admin) can start a new revision'
      using errcode = '42501';
  end if;

  perform public.lock_project_versions(v_source.project_id);

  -- Re-read under the lock.
  select * into v_source from public.project_versions where id = p_source_version_id;
  if v_source.status not in ('approved', 'changes_requested') then
    raise exception 'Only an approved or changes-requested version can be revised (this one is "%")',
      v_source.status using errcode = '22023';
  end if;

  if exists (
    select 1 from public.project_versions
    where project_id = v_source.project_id and status in ('draft', 'submitted')
  ) then
    raise exception 'This project already has a version in progress' using errcode = '22023';
  end if;

  select coalesce(max(version_no), 0) + 1 into v_next_no
  from public.project_versions
  where project_id = v_source.project_id;

  insert into public.project_versions (project_id, version_no, status, upload_id, markup_pct, created_by)
  values (v_source.project_id, v_next_no, 'draft', v_source.upload_id, v_source.markup_pct, auth.uid())
  returning id into v_new_id;

  insert into public.door_groups (
    version_id, position, group_key, door_tag, room_name, classification, leaf, door_size,
    door_qty, matched_set_id, match_status, match_score, match_reason, pm_remarks
  )
  select
    v_new_id, position, group_key, door_tag, room_name, classification, leaf, door_size,
    door_qty, matched_set_id, match_status, match_score, match_reason, pm_remarks
  from public.door_groups
  where version_id = p_source_version_id;

  insert into public.project_lines (
    group_id, position, sku, description, qty_per_door, unit_price, origin, part_id
  )
  select
    ng.id, l.position, l.sku, l.description, l.qty_per_door, l.unit_price, l.origin, l.part_id
  from public.project_lines l
  join public.door_groups og on og.id = l.group_id and og.version_id = p_source_version_id
  join public.door_groups ng on ng.version_id = v_new_id and ng.group_key = og.group_key;

  perform set_config('app.version_transition', 'on', true);
  update public.project_versions set status = 'superseded' where id = p_source_version_id;
  perform set_config('app.version_transition', 'off', true);

  return v_new_id;
end;
$$;

-- -----------------------------------------------------------------------------
-- 4. import_quotation: everything after the file upload, in one transaction
--
--   p_doors:  [{door_ref, room_name, classification, leaf, door_size, qty, source_row}]
--   p_groups: [{position, group_key, door_tag, room_name, classification, leaf,
--               door_size, door_qty, matched_set_id, match_status, match_score,
--               match_reason, lines: [{position, sku, description, qty_per_door,
--               unit_price, origin, part_id}]}]
-- -----------------------------------------------------------------------------
create or replace function public.import_quotation(
  p_project_id uuid,
  p_storage_path text,
  p_original_filename text,
  p_parse_report jsonb,
  p_doors jsonb,
  p_groups jsonb
)
returns uuid
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_version_id uuid;
  v_upload_id uuid;
  v_group jsonb;
  v_group_id uuid;
begin
  if auth.uid() is null then
    raise exception 'Not signed in' using errcode = '42501';
  end if;

  if not public.can_edit_project_content(p_project_id) then
    raise exception 'Only an estimator assigned to this project (or an admin) can import its quotation'
      using errcode = '42501';
  end if;

  if public.project_of_storage_path(p_storage_path) is distinct from p_project_id then
    raise exception 'The quotation file must be stored under the project''s folder'
      using errcode = '22023';
  end if;

  if coalesce(jsonb_array_length(p_groups), 0) = 0 then
    raise exception 'The quotation has no door groups to import' using errcode = '22023';
  end if;

  perform public.lock_project_versions(p_project_id);

  if exists (
    select 1 from public.project_versions
    where project_id = p_project_id and upload_id is not null
  ) then
    raise exception 'A quotation has already been imported for this project. Start a new revision to change it.'
      using errcode = '22023';
  end if;

  -- Reuse an unfinished version 1 left by an import from before this migration.
  select id into v_version_id
  from public.project_versions
  where project_id = p_project_id and version_no = 1 and status = 'draft' and upload_id is null;

  if found then
    delete from public.door_groups where version_id = v_version_id;
  else
    if exists (select 1 from public.project_versions where project_id = p_project_id) then
      raise exception 'This project already has versions' using errcode = '22023';
    end if;
    insert into public.project_versions (project_id, version_no, status, created_by)
    values (p_project_id, 1, 'draft', auth.uid())
    returning id into v_version_id;
  end if;

  insert into public.quotation_uploads (project_id, storage_path, original_filename, uploaded_by, parse_report)
  values (p_project_id, p_storage_path, p_original_filename, auth.uid(), coalesce(p_parse_report, '{}'::jsonb))
  returning id into v_upload_id;

  insert into public.quotation_doors (
    upload_id, door_ref, room_name, classification, leaf, door_size, qty, source_row
  )
  select
    v_upload_id, coalesce(d.door_ref, ''), d.room_name, coalesce(d.classification, ''),
    coalesce(d.leaf, ''), coalesce(d.door_size, ''), d.qty, d.source_row
  from jsonb_to_recordset(coalesce(p_doors, '[]'::jsonb)) as d(
    door_ref text, room_name text, classification text, leaf text, door_size text,
    qty numeric, source_row integer
  );

  for v_group in select value from jsonb_array_elements(p_groups) loop
    insert into public.door_groups (
      version_id, position, group_key, door_tag, room_name, classification, leaf, door_size,
      door_qty, matched_set_id, match_status, match_score, match_reason
    )
    values (
      v_version_id,
      (v_group->>'position')::integer,
      v_group->>'group_key',
      coalesce(v_group->>'door_tag', ''),
      v_group->>'room_name',
      coalesce(v_group->>'classification', ''),
      coalesce(v_group->>'leaf', ''),
      coalesce(v_group->>'door_size', ''),
      (v_group->>'door_qty')::numeric,
      nullif(v_group->>'matched_set_id', '')::uuid,
      coalesce(v_group->>'match_status', 'unmatched')::public.match_status,
      (v_group->>'match_score')::numeric,
      coalesce(v_group->>'match_reason', '')
    )
    returning id into v_group_id;

    insert into public.project_lines (
      group_id, position, sku, description, qty_per_door, unit_price, origin, part_id
    )
    select
      v_group_id, l.position, l.sku, l.description, l.qty_per_door, l.unit_price,
      coalesce(l.origin, 'set')::public.line_origin, l.part_id
    from jsonb_to_recordset(coalesce(v_group->'lines', '[]'::jsonb)) as l(
      position integer, sku text, description text, qty_per_door numeric,
      unit_price numeric, origin text, part_id uuid
    );
  end loop;

  -- Linking the upload marks the import as complete.
  update public.project_versions set upload_id = v_upload_id where id = v_version_id;

  return v_version_id;
end;
$$;

-- -----------------------------------------------------------------------------
-- 5. save_project_lines: batch line edits for one draft version
--
--   p_lines: [{id, sku?, description?, qty_per_door?, unit_price?, origin?,
--              part_id?, position?}]
--   Only the keys present are changed ("unit_price": null clears the price).
--   Either every line saves or none do.
-- -----------------------------------------------------------------------------
create or replace function public.save_project_lines(
  p_version_id uuid,
  p_lines jsonb
)
returns integer
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_expected integer := coalesce(jsonb_array_length(p_lines), 0);
  v_updated integer;
begin
  if auth.uid() is null then
    raise exception 'Not signed in' using errcode = '42501';
  end if;

  if not public.can_edit_project_content(public.project_of_version(p_version_id)) then
    raise exception 'Only an estimator assigned to this project (or an admin) can edit its lines'
      using errcode = '42501';
  end if;

  if v_expected = 0 then
    return 0;
  end if;

  with input as (
    select distinct on ((e->>'id')::uuid) (e->>'id')::uuid as id, e
    from jsonb_array_elements(p_lines) as e
  )
  update public.project_lines pl
  set
    sku = case when i.e ? 'sku' then i.e->>'sku' else pl.sku end,
    description = case when i.e ? 'description' then i.e->>'description' else pl.description end,
    qty_per_door = case when i.e ? 'qty_per_door' then (i.e->>'qty_per_door')::numeric else pl.qty_per_door end,
    unit_price = case when i.e ? 'unit_price' then (i.e->>'unit_price')::numeric else pl.unit_price end,
    origin = case when i.e ? 'origin' then (i.e->>'origin')::public.line_origin else pl.origin end,
    part_id = case when i.e ? 'part_id' then (i.e->>'part_id')::uuid else pl.part_id end,
    position = case when i.e ? 'position' then (i.e->>'position')::integer else pl.position end
  from input i, public.door_groups dg
  where pl.id = i.id
    and dg.id = pl.group_id
    and dg.version_id = p_version_id;

  get diagnostics v_updated = row_count;

  if v_updated <> (select count(distinct e->>'id') from jsonb_array_elements(p_lines) as e) then
    raise exception 'Some lines no longer exist in this version — refresh the page'
      using errcode = 'P0002';
  end if;

  return v_updated;
end;
$$;

-- -----------------------------------------------------------------------------
-- 6. Grants
-- -----------------------------------------------------------------------------
revoke all on function public.lock_project_versions(uuid) from public;
revoke all on function public.transition_version(uuid, public.approval_action, text) from public;
revoke all on function public.create_revision(uuid) from public;
revoke all on function public.import_quotation(uuid, text, text, jsonb, jsonb, jsonb) from public;
revoke all on function public.save_project_lines(uuid, jsonb) from public;

grant execute on function public.lock_project_versions(uuid) to authenticated;
grant execute on function public.transition_version(uuid, public.approval_action, text) to authenticated;
grant execute on function public.create_revision(uuid) to authenticated;
grant execute on function public.import_quotation(uuid, text, text, jsonb, jsonb, jsonb) to authenticated;
grant execute on function public.save_project_lines(uuid, jsonb) to authenticated;
