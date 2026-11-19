-- =============================================================================
-- Migration: 20261118000012_reimport_quotation.sql
-- Purpose: Re-import an updated quotation file into an existing project.
--
--   reimport_quotation(project, storage_path, filename, parse_report, doors, groups)
--     * If the project has a draft, its quotation is replaced (door groups and
--       lines are rewritten from p_groups).
--     * Otherwise the latest version must be approved or changes-requested: a
--       new draft revision is created from p_groups and the latest version is
--       marked superseded.
--     * Refused while a version is submitted (waiting for PM review), or if no
--       quotation was imported yet (use import_quotation).
--   The client decides what each group contains: door groups that did not
--   change keep their matched set, edited lines, prices and PM remarks; new
--   groups come from matching; removed groups are simply not sent.
--   All in one transaction.
--
-- write_quotation_content() is shared by import_quotation and
-- reimport_quotation (doors + door groups + lines for one version).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Shared: write doors, door groups and their lines for one version
-- -----------------------------------------------------------------------------
create or replace function public.write_quotation_content(
  p_version_id uuid,
  p_upload_id uuid,
  p_doors jsonb,
  p_groups jsonb
)
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_group jsonb;
  v_group_id uuid;
begin
  insert into public.quotation_doors (
    upload_id, door_ref, room_name, classification, leaf, door_size, qty, source_row
  )
  select
    p_upload_id, coalesce(d.door_ref, ''), d.room_name, coalesce(d.classification, ''),
    coalesce(d.leaf, ''), coalesce(d.door_size, ''), d.qty, d.source_row
  from jsonb_to_recordset(coalesce(p_doors, '[]'::jsonb)) as d(
    door_ref text, room_name text, classification text, leaf text, door_size text,
    qty numeric, source_row integer
  );

  for v_group in select value from jsonb_array_elements(p_groups) loop
    insert into public.door_groups (
      version_id, position, group_key, door_tag, room_name, classification, leaf, door_size,
      door_qty, matched_set_id, match_status, match_score, match_reason, pm_remarks
    )
    values (
      p_version_id,
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
      coalesce(v_group->>'match_reason', ''),
      coalesce(v_group->>'pm_remarks', '')
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
end;
$$;

-- -----------------------------------------------------------------------------
-- 2. import_quotation (first import) now uses the shared writer
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
    raise exception 'A quotation has already been imported for this project. Use Re-import Quotation to load an updated file.'
      using errcode = '22023';
  end if;

  -- Reuse an unfinished version 1 left by an import from before migration 011.
  select id into v_version_id
  from public.project_versions
  where project_id = p_project_id and version_no = 1 and status = 'draft' and upload_id is null;

  if v_version_id is not null then
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

  perform public.write_quotation_content(v_version_id, v_upload_id, p_doors, p_groups);

  -- Linking the upload marks the import as complete.
  update public.project_versions set upload_id = v_upload_id where id = v_version_id;

  return v_version_id;
end;
$$;

-- -----------------------------------------------------------------------------
-- 3. reimport_quotation
-- -----------------------------------------------------------------------------
create or replace function public.reimport_quotation(
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
  v_draft public.project_versions;
  v_latest public.project_versions;
  v_version_id uuid;
  v_upload_id uuid;
  v_next_no integer;
begin
  if auth.uid() is null then
    raise exception 'Not signed in' using errcode = '42501';
  end if;

  if not public.can_edit_project_content(p_project_id) then
    raise exception 'Only an estimator assigned to this project (or an admin) can re-import its quotation'
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

  if not exists (
    select 1 from public.project_versions
    where project_id = p_project_id and upload_id is not null
  ) then
    raise exception 'No quotation has been imported for this project yet — use Upload Quotation'
      using errcode = '22023';
  end if;

  if exists (
    select 1 from public.project_versions
    where project_id = p_project_id and status = 'submitted'
  ) then
    raise exception 'A version is waiting for PM review. Re-import after it is approved or changes are requested.'
      using errcode = '22023';
  end if;

  insert into public.quotation_uploads (project_id, storage_path, original_filename, uploaded_by, parse_report)
  values (p_project_id, p_storage_path, p_original_filename, auth.uid(), coalesce(p_parse_report, '{}'::jsonb))
  returning id into v_upload_id;

  select * into v_draft
  from public.project_versions
  where project_id = p_project_id and status = 'draft'
  order by version_no desc
  limit 1;

  if v_draft.id is not null then
    -- Replace the draft's quotation in place.
    v_version_id := v_draft.id;
    delete from public.door_groups where version_id = v_version_id;
  else
    -- Start the next revision from the latest version.
    select * into v_latest
    from public.project_versions
    where project_id = p_project_id
    order by version_no desc
    limit 1;

    if v_latest.status not in ('approved', 'changes_requested') then
      raise exception 'The latest version is "%"; re-import needs a draft, or an approved / changes-requested version',
        v_latest.status using errcode = '22023';
    end if;

    v_next_no := v_latest.version_no + 1;

    insert into public.project_versions (project_id, version_no, status, markup_pct, created_by)
    values (p_project_id, v_next_no, 'draft', v_latest.markup_pct, auth.uid())
    returning id into v_version_id;

    perform set_config('app.version_transition', 'on', true);
    update public.project_versions set status = 'superseded' where id = v_latest.id;
    perform set_config('app.version_transition', 'off', true);
  end if;

  perform public.write_quotation_content(v_version_id, v_upload_id, p_doors, p_groups);

  update public.project_versions set upload_id = v_upload_id where id = v_version_id;

  return v_version_id;
end;
$$;

-- -----------------------------------------------------------------------------
-- 4. Grants
-- -----------------------------------------------------------------------------
revoke all on function public.write_quotation_content(uuid, uuid, jsonb, jsonb) from public;
revoke all on function public.reimport_quotation(uuid, text, text, jsonb, jsonb, jsonb) from public;
grant execute on function public.write_quotation_content(uuid, uuid, jsonb, jsonb) to authenticated;
grant execute on function public.reimport_quotation(uuid, text, text, jsonb, jsonb, jsonb) to authenticated;
