-- =============================================================================
-- Migration: 20261124000024_line_review_flag.sql
--
-- review_flag per hardware line: why the estimator should check it, e.g. a
-- standard-set part with no matching PREPARATION / INSTALLATION cost in the
-- quotation ("No STOP cost in the quotation — check this part"). Set on
-- import, shown on the row in the grid (not exported), cleared by the
-- estimator. The functions that write or copy lines now carry it:
--   - save_project_lines       (grid edits; clearing the flag)
--   - create_revision          (copied into the new version)
--   - add_quote_sheet          (copied to the new sheet)
--   - write_quotation_content  (import / re-import)
--   - reimport_quotation       (kept lines of unchanged door groups)
-- Unchanged otherwise: same signatures, checks and grants.
-- =============================================================================

alter table public.project_lines
  add column if not exists review_flag text not null default '';

alter table public.project_lines drop constraint if exists project_lines_review_flag_length;
alter table public.project_lines
  add constraint project_lines_review_flag_length check (char_length(review_flag) <= 300);


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
    review_flag = case when i.e ? 'review_flag' then coalesce(i.e->>'review_flag', '') else pl.review_flag end,
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

  perform public.assert_quote_open(v_source.quote_id);
  perform public.lock_project_versions(v_source.project_id);

  -- Re-read under the lock.
  select * into v_source from public.project_versions where id = p_source_version_id;
  if v_source.status not in ('approved', 'changes_requested') then
    raise exception 'Only an approved or changes-requested version can be revised (this one is "%")',
      v_source.status using errcode = '22023';
  end if;

  if exists (
    select 1 from public.project_versions
    where quote_id = v_source.quote_id and status in ('draft', 'submitted')
  ) then
    raise exception 'This quote already has a version in progress' using errcode = '22023';
  end if;

  select coalesce(max(version_no), 0) + 1 into v_next_no
  from public.project_versions
  where quote_id = v_source.quote_id;

  insert into public.project_versions (project_id, quote_id, version_no, status, upload_id, markup_pct, created_by)
  values (v_source.project_id, v_source.quote_id, v_next_no, 'draft', v_source.upload_id, v_source.markup_pct, auth.uid())
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

  insert into public.quote_sheets (version_id, supplier_id, name, position)
  select v_new_id, supplier_id, name, position
  from public.quote_sheets
  where version_id = p_source_version_id;

  insert into public.project_lines (
    group_id, sheet_id, position, sku, description, qty_per_door, unit_price, origin, part_id, mhqt_remarks, review_flag
  )
  select
    ng.id, ns.id, l.position, l.sku, l.description, l.qty_per_door, l.unit_price, l.origin,
    l.part_id, l.mhqt_remarks, l.review_flag
  from public.project_lines l
  join public.door_groups og on og.id = l.group_id and og.version_id = p_source_version_id
  join public.door_groups ng on ng.version_id = v_new_id and ng.group_key = og.group_key
  join public.quote_sheets os on os.id = l.sheet_id
  join public.quote_sheets ns on ns.version_id = v_new_id and ns.supplier_id = os.supplier_id;

  perform set_config('app.version_transition', 'on', true);
  update public.project_versions set status = 'superseded' where id = p_source_version_id;
  perform set_config('app.version_transition', 'off', true);

  return v_new_id;
end;
$$;

create or replace function public.add_quote_sheet(
  p_version_id uuid,
  p_supplier_id uuid,
  p_name text default null,
  p_source_sheet_id uuid default null
)
returns uuid
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_version public.project_versions;
  v_source uuid := p_source_sheet_id;
  v_name text;
  v_sheet_id uuid;
  v_position integer;
begin
  if auth.uid() is null then
    raise exception 'Not signed in' using errcode = '42501';
  end if;

  select * into v_version from public.project_versions where id = p_version_id;
  if not found then
    raise exception 'Version not found' using errcode = 'P0002';
  end if;

  if not public.can_edit_project_content(v_version.project_id) then
    raise exception 'Only an estimator assigned to this project (or an admin) can add supplier sheets'
      using errcode = '42501';
  end if;

  if v_version.status <> 'draft' then
    raise exception 'Supplier sheets can only be added to a draft (this version is "%")', v_version.status
      using errcode = '22023';
  end if;

  select coalesce(nullif(btrim(p_name), ''), name) into v_name from public.suppliers where id = p_supplier_id;
  if v_name is null then
    raise exception 'Supplier not found' using errcode = 'P0002';
  end if;

  if exists (select 1 from public.quote_sheets where version_id = p_version_id and supplier_id = p_supplier_id) then
    raise exception 'This quote already has a sheet for that supplier' using errcode = '23505';
  end if;

  if v_source is null then
    select id into v_source from public.quote_sheets
    where version_id = p_version_id order by position, created_at limit 1;
  elsif not exists (select 1 from public.quote_sheets where id = v_source and version_id = p_version_id) then
    raise exception 'The sheet to copy from is not in this version' using errcode = '22023';
  end if;

  select coalesce(max(position), -1) + 1 into v_position
  from public.quote_sheets where version_id = p_version_id;

  insert into public.quote_sheets (version_id, supplier_id, name, position)
  values (p_version_id, p_supplier_id, v_name, v_position)
  returning id into v_sheet_id;

  -- Same door groups as the source sheet; each part swaps to the new
  -- supplier's part in the same folder when there is exactly one. The rest
  -- are copied as they are (the grid flags other suppliers' parts).
  insert into public.project_lines (
    group_id, sheet_id, position, sku, description, qty_per_door, unit_price, origin, part_id, mhqt_remarks, review_flag
  )
  select
    l.group_id, v_sheet_id, l.position,
    coalesce(sw.sku, l.sku),
    coalesce(sw.description, l.description),
    l.qty_per_door,
    case when sw.id is not null then sw.unit_cost else l.unit_price end,
    case when sw.id is not null and l.origin = 'set' then 'edited'::public.line_origin else l.origin end,
    coalesce(sw.id, l.part_id),
    l.mhqt_remarks,
    l.review_flag
  from public.project_lines l
  left join public.parts sw on sw.id = public.supplier_equivalent_part(l.part_id, l.sku, p_supplier_id)
  where l.sheet_id = v_source;

  return v_sheet_id;
end;
$$;

create or replace function public.write_quotation_content(
  p_version_id uuid,
  p_upload_id uuid,
  p_doors jsonb,
  p_groups jsonb,
  p_carry jsonb default '[]'::jsonb
)
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_group jsonb;
  v_group_id uuid;
  v_carried uuid;
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

    v_carried := nullif(v_group->>'carried_from_group_id', '')::uuid;

    if v_carried is not null then
      insert into public.project_lines (
        group_id, sheet_id, position, sku, description, qty_per_door, unit_price, origin,
        part_id, mhqt_remarks, review_flag
      )
      select
        v_group_id, s.id, c.position, c.sku, c.description, c.qty_per_door, c.unit_price,
        c.origin, c.part_id, coalesce(c.mhqt_remarks, ''), coalesce(c.review_flag, '')
      from jsonb_to_recordset(coalesce(p_carry, '[]'::jsonb)) as c(
        base_group_id uuid, supplier_id uuid, position integer, sku text, description text,
        qty_per_door numeric, unit_price numeric, origin public.line_origin, part_id uuid,
        mhqt_remarks text, review_flag text
      )
      join public.quote_sheets s on s.version_id = p_version_id and s.supplier_id = c.supplier_id
      where c.base_group_id = v_carried;
    else
      insert into public.project_lines (
        group_id, sheet_id, position, sku, description, qty_per_door, unit_price, origin,
        part_id, mhqt_remarks, review_flag
      )
      select
        v_group_id, s.id, l.position,
        coalesce(sw.sku, l.sku),
        coalesce(sw.description, l.description),
        l.qty_per_door,
        case when sw.id is not null then sw.unit_cost else l.unit_price end,
        case when sw.id is not null and coalesce(l.origin, 'set') = 'set' then 'edited'::public.line_origin
             else coalesce(l.origin, 'set')::public.line_origin end,
        coalesce(sw.id, l.part_id),
        coalesce(l.mhqt_remarks, ''),
        coalesce(l.review_flag, '')
      from public.quote_sheets s
      cross join jsonb_to_recordset(coalesce(v_group->'lines', '[]'::jsonb)) as l(
        position integer, sku text, description text, qty_per_door numeric,
        unit_price numeric, origin text, part_id uuid, mhqt_remarks text, review_flag text
      )
      left join public.parts sw on sw.id = public.supplier_equivalent_part(l.part_id, l.sku, s.supplier_id)
      where s.version_id = p_version_id;
    end if;
  end loop;
end;
$$;

create or replace function public.reimport_quotation(
  p_quote_id uuid,
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
  v_project_id uuid;
  v_base public.project_versions;
  v_version_id uuid;
  v_upload_id uuid;
  v_carry jsonb;
begin
  if auth.uid() is null then
    raise exception 'Not signed in' using errcode = '42501';
  end if;

  v_project_id := public.project_of_quote(p_quote_id);
  if v_project_id is null then
    raise exception 'Quote not found' using errcode = 'P0002';
  end if;

  if not public.can_edit_project_content(v_project_id) then
    raise exception 'Only an estimator assigned to this project (or an admin) can re-import its quotation'
      using errcode = '42501';
  end if;

  perform public.assert_quote_open(p_quote_id);

  if public.project_of_storage_path(p_storage_path) is distinct from v_project_id then
    raise exception 'The quotation file must be stored under the project''s folder'
      using errcode = '22023';
  end if;

  if coalesce(jsonb_array_length(p_groups), 0) = 0 then
    raise exception 'The quotation has no door groups to import' using errcode = '22023';
  end if;

  perform public.lock_project_versions(v_project_id);

  if not exists (
    select 1 from public.project_versions where quote_id = p_quote_id and upload_id is not null
  ) then
    raise exception 'No quotation has been imported for this quote yet' using errcode = '22023';
  end if;

  if exists (
    select 1 from public.project_versions where quote_id = p_quote_id and status = 'submitted'
  ) then
    raise exception 'A version is waiting for PM review. Re-import after it is approved or changes are requested.'
      using errcode = '22023';
  end if;

  -- The version the file is compared with: the draft, else the latest version.
  select * into v_base
  from public.project_versions
  where quote_id = p_quote_id
  order by (status = 'draft') desc, version_no desc
  limit 1;

  if v_base.status <> 'draft' and v_base.status not in ('approved', 'changes_requested') then
    raise exception 'The latest version is "%"; re-import needs a draft, or an approved / changes-requested version',
      v_base.status using errcode = '22023';
  end if;

  -- Lines of every sheet, kept for unchanged door groups.
  select coalesce(jsonb_agg(jsonb_build_object(
           'base_group_id', l.group_id, 'supplier_id', s.supplier_id, 'position', l.position,
           'sku', l.sku, 'description', l.description, 'qty_per_door', l.qty_per_door,
           'unit_price', l.unit_price, 'origin', l.origin, 'part_id', l.part_id,
           'mhqt_remarks', l.mhqt_remarks, 'review_flag', l.review_flag)), '[]'::jsonb)
  into v_carry
  from public.project_lines l
  join public.quote_sheets s on s.id = l.sheet_id
  join public.door_groups g on g.id = l.group_id
  where g.version_id = v_base.id;

  insert into public.quotation_uploads (project_id, storage_path, original_filename, uploaded_by, parse_report)
  values (v_project_id, p_storage_path, p_original_filename, auth.uid(), coalesce(p_parse_report, '{}'::jsonb))
  returning id into v_upload_id;

  if v_base.status = 'draft' then
    -- Replace the draft's quotation in place (its sheets stay).
    v_version_id := v_base.id;
    delete from public.door_groups where version_id = v_version_id;
  else
    -- Start the next revision with the same sheets.
    insert into public.project_versions (project_id, quote_id, version_no, status, markup_pct, created_by)
    values (v_project_id, p_quote_id, v_base.version_no + 1, 'draft', v_base.markup_pct, auth.uid())
    returning id into v_version_id;

    insert into public.quote_sheets (version_id, supplier_id, name, position)
    select v_version_id, supplier_id, name, position
    from public.quote_sheets where version_id = v_base.id;

    perform set_config('app.version_transition', 'on', true);
    update public.project_versions set status = 'superseded' where id = v_base.id;
    perform set_config('app.version_transition', 'off', true);
  end if;

  perform public.write_quotation_content(v_version_id, v_upload_id, p_doors, p_groups, v_carry);

  update public.project_versions set upload_id = v_upload_id where id = v_version_id;

  return v_version_id;
end;
$$;
