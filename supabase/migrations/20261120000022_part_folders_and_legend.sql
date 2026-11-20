-- =============================================================================
-- Migration: 20261120000022_part_folders_and_legend.sql
-- Purpose: Folders in the Parts library, a legend code per part, and
--   automatic part swapping between supplier sheets.
--
--   part_folders       Families of hardware (e.g. "Lever furniture - round
--                      rose", "Seals"). A folder holds parts from every
--                      supplier. Everyone signed in reads; admins write.
--   parts.folder_id    The part's folder (null = unfiled). Deleting a folder
--                      leaves its parts unfiled.
--   parts.legend       Legend code from the quotes (e.g. "F7", "C4", "MM");
--                      '' when none. Shown in the grid's LEGEND column.
--
--   supplier_equivalent_part(part, sku, supplier)
--       The supplier's part in the same folder, when there is exactly one
--       active one. Never swaps owner-supplied parts (MM) or a part that is
--       already from that supplier.
--   add_quote_sheet    copies the source sheet's lines and swaps each one to
--                      the new supplier's equivalent part (when there is one).
--   write_quotation_content  new door groups (import / re-import) get, on
--                      each sheet, that sheet supplier's equivalent part.
--   Swapped lines take the part's SKU, description and unit cost (a part with
--   no unit cost stays blank, never 0); a line that came from the standard
--   set becomes "edited".
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Folders
-- -----------------------------------------------------------------------------
create table if not exists public.part_folders (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  position integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint part_folders_name_length check (char_length(btrim(name)) between 1 and 100)
);

create unique index if not exists uq_part_folders_name on public.part_folders (lower(btrim(name)));

drop trigger if exists trg_part_folders_updated_at on public.part_folders;
create trigger trg_part_folders_updated_at
  before update on public.part_folders
  for each row execute function public.set_updated_at();

alter table public.part_folders enable row level security;
alter table public.part_folders force row level security;

drop policy if exists "part_folders_select_authenticated" on public.part_folders;
create policy "part_folders_select_authenticated"
  on public.part_folders for select to authenticated
  using (true);

drop policy if exists "part_folders_write_admin_only" on public.part_folders;
create policy "part_folders_write_admin_only"
  on public.part_folders for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

revoke all on public.part_folders from anon, authenticated;
grant select, insert, update, delete on public.part_folders to authenticated;

-- -----------------------------------------------------------------------------
-- 2. Parts: folder and legend
-- -----------------------------------------------------------------------------
alter table public.parts
  add column if not exists folder_id uuid null references public.part_folders(id) on delete set null,
  add column if not exists legend text not null default '';

alter table public.parts drop constraint if exists parts_legend_length;
alter table public.parts add constraint parts_legend_length check (char_length(legend) <= 20);

create index if not exists idx_parts_folder_supplier on public.parts (folder_id, supplier_id) where active;

-- -----------------------------------------------------------------------------
-- 3. The supplier's equivalent part (same folder, exactly one active)
-- -----------------------------------------------------------------------------
create or replace function public.supplier_equivalent_part(
  p_part_id uuid,
  p_sku text,
  p_supplier_id uuid
)
returns uuid
language sql
stable
security invoker
set search_path = public
as $$
  with src as (
    select p.folder_id, p.supplier_id, s.is_owner_supplied
    from public.parts p
    join public.suppliers s on s.id = p.supplier_id
    where (p_part_id is not null and p.id = p_part_id)
       or (p_part_id is null and upper(btrim(p.sku)) = upper(btrim(coalesce(p_sku, ''))))
    limit 1
  ),
  candidates as (
    select p.id
    from public.parts p, src
    where src.folder_id is not null
      and not src.is_owner_supplied
      and src.supplier_id <> p_supplier_id
      and p.folder_id = src.folder_id
      and p.supplier_id = p_supplier_id
      and p.active
  )
  select case when (select count(*) from candidates) = 1 then (select id from candidates) end;
$$;

revoke all on function public.supplier_equivalent_part(uuid, text, uuid) from public, anon;
grant execute on function public.supplier_equivalent_part(uuid, text, uuid) to authenticated;

-- -----------------------------------------------------------------------------
-- 4. add_quote_sheet (from 021) + swap to the new supplier's parts
-- -----------------------------------------------------------------------------
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
    group_id, sheet_id, position, sku, description, qty_per_door, unit_price, origin, part_id, mhqt_remarks
  )
  select
    l.group_id, v_sheet_id, l.position,
    coalesce(sw.sku, l.sku),
    coalesce(sw.description, l.description),
    l.qty_per_door,
    case when sw.id is not null then sw.unit_cost else l.unit_price end,
    case when sw.id is not null and l.origin = 'set' then 'edited'::public.line_origin else l.origin end,
    coalesce(sw.id, l.part_id),
    l.mhqt_remarks
  from public.project_lines l
  left join public.parts sw on sw.id = public.supplier_equivalent_part(l.part_id, l.sku, p_supplier_id)
  where l.sheet_id = v_source;

  return v_sheet_id;
end;
$$;

-- -----------------------------------------------------------------------------
-- 5. write_quotation_content (from 021) + new groups use each sheet's supplier
-- -----------------------------------------------------------------------------
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
        part_id, mhqt_remarks
      )
      select
        v_group_id, s.id, c.position, c.sku, c.description, c.qty_per_door, c.unit_price,
        c.origin, c.part_id, coalesce(c.mhqt_remarks, '')
      from jsonb_to_recordset(coalesce(p_carry, '[]'::jsonb)) as c(
        base_group_id uuid, supplier_id uuid, position integer, sku text, description text,
        qty_per_door numeric, unit_price numeric, origin public.line_origin, part_id uuid,
        mhqt_remarks text
      )
      join public.quote_sheets s on s.version_id = p_version_id and s.supplier_id = c.supplier_id
      where c.base_group_id = v_carried;
    else
      insert into public.project_lines (
        group_id, sheet_id, position, sku, description, qty_per_door, unit_price, origin,
        part_id, mhqt_remarks
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
        coalesce(l.mhqt_remarks, '')
      from public.quote_sheets s
      cross join jsonb_to_recordset(coalesce(v_group->'lines', '[]'::jsonb)) as l(
        position integer, sku text, description text, qty_per_door numeric,
        unit_price numeric, origin text, part_id uuid, mhqt_remarks text
      )
      left join public.parts sw on sw.id = public.supplier_equivalent_part(l.part_id, l.sku, s.supplier_id)
      where s.version_id = p_version_id;
    end if;
  end loop;
end;
$$;
