-- =============================================================================
-- Migration: 20261119000019_line_mhqt_remarks.sql
-- Purpose: "MHQT REMARKS" per hardware line (the last column of the NOVAS
--   Template), edited in the grid by whoever can edit the version's lines and
--   written to column M of the Excel export.
--   The functions that write or copy lines now carry it:
--   - save_project_lines   (grid edits)
--   - create_revision      (copied into the new version)
--   - write_quotation_content (import / re-import; the client passes the
--     remarks of door groups kept from the previous version)
--   Unchanged otherwise: same signatures, checks and grants.
-- =============================================================================

alter table public.project_lines
  add column if not exists mhqt_remarks text not null default '';

alter table public.project_lines drop constraint if exists project_lines_mhqt_remarks_length;
alter table public.project_lines
  add constraint project_lines_mhqt_remarks_length check (char_length(mhqt_remarks) <= 500);

-- -----------------------------------------------------------------------------
-- save_project_lines (from 20261118000011, + mhqt_remarks)
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
    mhqt_remarks = case when i.e ? 'mhqt_remarks' then coalesce(i.e->>'mhqt_remarks', '') else pl.mhqt_remarks end,
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
-- create_revision (from 20261118000011, + mhqt_remarks)
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
    group_id, position, sku, description, qty_per_door, unit_price, origin, part_id, mhqt_remarks
  )
  select
    ng.id, l.position, l.sku, l.description, l.qty_per_door, l.unit_price, l.origin, l.part_id, l.mhqt_remarks
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
-- write_quotation_content (from 20261118000012, + mhqt_remarks)
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
      group_id, position, sku, description, qty_per_door, unit_price, origin, part_id, mhqt_remarks
    )
    select
      v_group_id, l.position, l.sku, l.description, l.qty_per_door, l.unit_price,
      coalesce(l.origin, 'set')::public.line_origin, l.part_id, coalesce(l.mhqt_remarks, '')
    from jsonb_to_recordset(coalesce(v_group->'lines', '[]'::jsonb)) as l(
      position integer, sku text, description text, qty_per_door numeric,
      unit_price numeric, origin text, part_id uuid, mhqt_remarks text
    );
  end loop;
end;
$$;
