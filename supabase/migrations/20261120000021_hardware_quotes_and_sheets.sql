-- =============================================================================
-- Migration: 20261120000021_hardware_quotes_and_sheets.sql
-- Purpose: Builder quotes with supplier sheets (Tender stage), and the
--   winning quote / supplier when a project is awarded.
--
--   hardware_quotes   One per builder in a project (builder name typed per
--                     quote, unique within the project). Each quote has its
--                     own versions (v1, v2, ...), one quotation upload, one
--                     draft at a time and its own submit / approve flow.
--   project_versions  + quote_id; version_no is now unique per quote.
--   quote_sheets      Supplier sheets of a version: one per supplier, renamed
--                     freely. Door groups are shared by all sheets of the
--                     version; each sheet has its own hardware lines.
--   project_lines     + sheet_id (the sheet the line belongs to).
--   version_comments  + sheet_id (optional: a comment about one sheet).
--   projects          + awarded_quote_id / awarded_supplier_id. Moving a
--                     project to Awarded needs both: an approved quote (its
--                     latest version) and one of its supplier sheets. Back to
--                     Tender clears them. While awarded, the other quotes are
--                     read-only and no new quotes can be added.
--
--   Functions (all-or-nothing, caller's RLS applies):
--     import_quotation(project, builder, supplier, file..., doors, groups)
--         new quote + v1 + its first supplier sheet + door groups + lines.
--     reimport_quotation(quote, file..., doors, groups)
--         as before, per quote; unchanged groups keep the lines of every sheet.
--     create_revision(version)   copies door groups, sheets and lines.
--     add_quote_sheet(version, supplier, name, source_sheet)
--         new supplier sheet with the door groups' lines copied from a sheet.
--     transition_version / save_project_lines: unchanged signatures.
--
--   Existing data: every project with versions gets one quote (builder = the
--   project's client, or "Builder"); every version gets one sheet for the
--   supplier most used on its lines.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Hardware quotes
-- -----------------------------------------------------------------------------
create table if not exists public.hardware_quotes (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  builder_name text not null,
  created_by uuid null references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint hardware_quotes_builder_name_length
    check (char_length(btrim(builder_name)) between 1 and 200),
  constraint hardware_quotes_id_project_key unique (id, project_id)
);

create unique index if not exists uq_hardware_quotes_builder
  on public.hardware_quotes (project_id, lower(btrim(builder_name)));

drop trigger if exists trg_hardware_quotes_updated_at on public.hardware_quotes;
create trigger trg_hardware_quotes_updated_at
  before update on public.hardware_quotes
  for each row execute function public.set_updated_at();

-- -----------------------------------------------------------------------------
-- 2. Versions belong to a quote
-- -----------------------------------------------------------------------------
alter table public.project_versions add column if not exists quote_id uuid;

-- Backfill: one quote per project that has versions.
insert into public.hardware_quotes (project_id, builder_name, created_by, created_at, updated_at)
select p.id,
       coalesce(nullif(btrim(p.client), ''), 'Builder'),
       min(v.created_by::text)::uuid,
       min(v.created_at),
       max(v.updated_at)
from public.projects p
join public.project_versions v on v.project_id = p.id
where v.quote_id is null
  and not exists (select 1 from public.hardware_quotes q where q.project_id = p.id)
group by p.id, p.client;

alter table public.project_versions disable trigger user;
update public.project_versions v
set quote_id = q.id
from public.hardware_quotes q
where q.project_id = v.project_id and v.quote_id is null;
alter table public.project_versions enable trigger user;

alter table public.project_versions alter column quote_id set not null;

alter table public.project_versions drop constraint if exists project_versions_quote_fk;
alter table public.project_versions
  add constraint project_versions_quote_fk
  foreign key (quote_id, project_id) references public.hardware_quotes (id, project_id)
  on delete cascade;

-- version_no: unique per quote instead of per project.
do $$
declare
  r record;
begin
  for r in
    select conname from pg_constraint
    where conrelid = 'public.project_versions'::regclass
      and contype = 'u'
      and pg_get_constraintdef(oid) = 'UNIQUE (project_id, version_no)'
  loop
    execute format('alter table public.project_versions drop constraint %I', r.conname);
  end loop;
end $$;

alter table public.project_versions drop constraint if exists project_versions_quote_version_no_key;
alter table public.project_versions
  add constraint project_versions_quote_version_no_key unique (quote_id, version_no);

create index if not exists idx_project_versions_quote
  on public.project_versions (quote_id, version_no desc);

-- -----------------------------------------------------------------------------
-- 3. Supplier sheets
-- -----------------------------------------------------------------------------
create table if not exists public.quote_sheets (
  id uuid primary key default gen_random_uuid(),
  version_id uuid not null references public.project_versions(id) on delete cascade,
  supplier_id uuid not null references public.suppliers(id) on delete restrict,
  name text not null,
  position integer not null check (position >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint quote_sheets_name_length check (char_length(btrim(name)) between 1 and 100),
  constraint quote_sheets_version_supplier_key unique (version_id, supplier_id),
  constraint quote_sheets_version_position_key unique (version_id, position) deferrable initially deferred
);

create unique index if not exists uq_quote_sheets_name
  on public.quote_sheets (version_id, lower(btrim(name)));

drop trigger if exists trg_quote_sheets_updated_at on public.quote_sheets;
create trigger trg_quote_sheets_updated_at
  before update on public.quote_sheets
  for each row execute function public.set_updated_at();

-- Backfill: one sheet per existing version, for the supplier most used on its lines.
do $$
begin
  if exists (select 1 from public.project_versions v
             where not exists (select 1 from public.quote_sheets s where s.version_id = v.id))
     and not exists (select 1 from public.suppliers) then
    insert into public.suppliers (name) values ('GENERAL');
  end if;
end $$;

with usage as (
  select g.version_id, coalesce(p1.supplier_id, p2.supplier_id) as supplier_id, count(*) as n
  from public.project_lines l
  join public.door_groups g on g.id = l.group_id
  left join public.parts p1 on p1.id = l.part_id
  left join public.parts p2 on l.part_id is null and upper(btrim(p2.sku)) = upper(btrim(l.sku))
  group by 1, 2
),
best as (
  select distinct on (version_id) version_id, supplier_id
  from usage
  where supplier_id is not null
  order by version_id, n desc, supplier_id
),
chosen as (
  select v.id as version_id,
         coalesce(b.supplier_id, (select id from public.suppliers order by name, id limit 1)) as supplier_id
  from public.project_versions v
  left join best b on b.version_id = v.id
  where not exists (select 1 from public.quote_sheets s where s.version_id = v.id)
)
insert into public.quote_sheets (version_id, supplier_id, name, position, created_at)
select c.version_id, c.supplier_id, s.name, 0, v.created_at
from chosen c
join public.suppliers s on s.id = c.supplier_id
join public.project_versions v on v.id = c.version_id;

-- -----------------------------------------------------------------------------
-- 4. Lines belong to a sheet
-- -----------------------------------------------------------------------------
alter table public.project_lines
  add column if not exists sheet_id uuid references public.quote_sheets(id) on delete cascade;

alter table public.project_lines disable trigger user;
update public.project_lines l
set sheet_id = s.id
from public.door_groups g
join public.quote_sheets s on s.version_id = g.version_id and s.position = 0
where g.id = l.group_id and l.sheet_id is null;
alter table public.project_lines enable trigger user;

alter table public.project_lines alter column sheet_id set not null;

-- Line positions: unique per door group per sheet.
do $$
declare
  r record;
begin
  for r in
    select conname from pg_constraint
    where conrelid = 'public.project_lines'::regclass
      and contype = 'u'
      and pg_get_constraintdef(oid) like 'UNIQUE (group_id, "position")%'
  loop
    execute format('alter table public.project_lines drop constraint %I', r.conname);
  end loop;
end $$;

alter table public.project_lines drop constraint if exists project_lines_group_sheet_position_key;
alter table public.project_lines
  add constraint project_lines_group_sheet_position_key
  unique (group_id, sheet_id, position) deferrable initially deferred;

create index if not exists idx_project_lines_sheet on public.project_lines (sheet_id, group_id, position);

-- -----------------------------------------------------------------------------
-- 5. Comments may be about one sheet
-- -----------------------------------------------------------------------------
alter table public.version_comments
  add column if not exists sheet_id uuid null references public.quote_sheets(id) on delete set null;

create index if not exists idx_version_comments_sheet on public.version_comments (sheet_id);

-- -----------------------------------------------------------------------------
-- 6. Winning quote and supplier
-- -----------------------------------------------------------------------------
alter table public.projects
  add column if not exists awarded_quote_id uuid null references public.hardware_quotes(id),
  add column if not exists awarded_supplier_id uuid null references public.suppliers(id);

-- -----------------------------------------------------------------------------
-- 7. Helpers
-- -----------------------------------------------------------------------------
create or replace function public.quote_of_version(p_version_id uuid)
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select quote_id from public.project_versions where id = p_version_id;
$$;

-- Resolves without RLS so permission errors are reported as such.
create or replace function public.project_of_quote(p_quote_id uuid)
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select project_id from public.hardware_quotes where id = p_quote_id;
$$;

create or replace function public.project_of_sheet(p_sheet_id uuid)
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select v.project_id
  from public.quote_sheets s
  join public.project_versions v on v.id = s.version_id
  where s.id = p_sheet_id;
$$;

-- A quote is read-only once the project is awarded to another quote.
create or replace function public.quote_is_locked(p_quote_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.hardware_quotes q
    join public.projects p on p.id = q.project_id
    where q.id = p_quote_id
      and p.stage = 'awarded'
      and p.awarded_quote_id is not null
      and p.awarded_quote_id <> q.id
  );
$$;

create or replace function public.assert_quote_open(p_quote_id uuid)
returns void
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if public.quote_is_locked(p_quote_id) then
    raise exception 'This project was awarded to another quote, so this quote is read-only'
      using errcode = '42501';
  end if;
end;
$$;

-- "Builder v2", used in activity and notification text.
create or replace function public.version_label(p_version_id uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(btrim(q.builder_name) || ' ', '') || 'v' || v.version_no
  from public.project_versions v
  left join public.hardware_quotes q on q.id = v.quote_id
  where v.id = p_version_id;
$$;

revoke all on function public.version_label(uuid) from public, anon, authenticated;
revoke all on function public.quote_of_version(uuid) from public, anon;
revoke all on function public.project_of_quote(uuid) from public, anon;
revoke all on function public.project_of_sheet(uuid) from public, anon;
revoke all on function public.quote_is_locked(uuid) from public, anon;
revoke all on function public.assert_quote_open(uuid) from public, anon;
grant execute on function public.quote_of_version(uuid) to authenticated;
grant execute on function public.project_of_quote(uuid) to authenticated;
grant execute on function public.project_of_sheet(uuid) to authenticated;
grant execute on function public.quote_is_locked(uuid) to authenticated;
grant execute on function public.assert_quote_open(uuid) to authenticated;

-- -----------------------------------------------------------------------------
-- 8. Integrity triggers
-- -----------------------------------------------------------------------------

-- New quotes only while the project is at Tender.
create or replace function public.enforce_quote_insert_tender()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if exists (select 1 from public.projects where id = new.project_id and stage = 'awarded') then
    raise exception 'The project is awarded; new builder quotes can only be added at Tender'
      using errcode = '42501';
  end if;
  new.builder_name := btrim(new.builder_name);
  return new;
end;
$$;

drop trigger if exists trg_hardware_quotes_insert_tender on public.hardware_quotes;
create trigger trg_hardware_quotes_insert_tender
  before insert on public.hardware_quotes
  for each row execute function public.enforce_quote_insert_tender();

-- A line's sheet must belong to the same version as its door group.
create or replace function public.enforce_line_sheet_version()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (
    select 1
    from public.door_groups g
    join public.quote_sheets s on s.version_id = g.version_id
    where g.id = new.group_id and s.id = new.sheet_id
  ) then
    raise exception 'The line''s sheet and door group belong to different versions'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_project_lines_sheet_version on public.project_lines;
create trigger trg_project_lines_sheet_version
  before insert or update of group_id, sheet_id on public.project_lines
  for each row execute function public.enforce_line_sheet_version();

-- Sheets: only in a draft of an open quote; a version keeps at least one sheet.
create or replace function public.enforce_quote_sheet_rules()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_version public.project_versions;
begin
  select * into v_version
  from public.project_versions
  where id = case when tg_op = 'DELETE' then old.version_id else new.version_id end;

  -- ON DELETE CASCADE from the version / project: the parent row is already gone.
  if tg_op = 'DELETE' and v_version.id is null then
    return old;
  end if;

  if v_version.status is distinct from 'draft' then
    raise exception 'Cannot change supplier sheets: version status is "%" (must be draft)', v_version.status
      using errcode = '42501';
  end if;

  perform public.assert_quote_open(v_version.quote_id);

  if tg_op = 'UPDATE' and new.version_id is distinct from old.version_id then
    raise exception 'A sheet cannot move to another version' using errcode = '42501';
  end if;

  if tg_op = 'DELETE' then
    if not exists (select 1 from public.quote_sheets where version_id = old.version_id and id <> old.id) then
      raise exception 'A quote needs at least one supplier sheet' using errcode = '22023';
    end if;
    return old;
  end if;

  new.name := btrim(new.name);
  return new;
end;
$$;

drop trigger if exists trg_quote_sheets_rules on public.quote_sheets;
create trigger trg_quote_sheets_rules
  before insert or update or delete on public.quote_sheets
  for each row execute function public.enforce_quote_sheet_rules();

-- Door groups and lines of a quote that lost the award are read-only.
create or replace function public.enforce_quote_open_for_groups()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_quote uuid;
begin
  select quote_id into v_quote from public.project_versions
  where id = case when tg_op = 'DELETE' then old.version_id else new.version_id end;
  if v_quote is not null then
    perform public.assert_quote_open(v_quote);
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

drop trigger if exists trg_door_groups_quote_open on public.door_groups;
create trigger trg_door_groups_quote_open
  before insert or update or delete on public.door_groups
  for each row execute function public.enforce_quote_open_for_groups();

create or replace function public.enforce_quote_open_for_lines()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_quote uuid;
begin
  select v.quote_id into v_quote
  from public.door_groups g
  join public.project_versions v on v.id = g.version_id
  where g.id = case when tg_op = 'DELETE' then old.group_id else new.group_id end;
  if v_quote is not null then
    perform public.assert_quote_open(v_quote);
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

drop trigger if exists trg_project_lines_quote_open on public.project_lines;
create trigger trg_project_lines_quote_open
  before insert or update or delete on public.project_lines
  for each row execute function public.enforce_quote_open_for_lines();

-- Award rules (projects).
create or replace function public.enforce_project_award()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_latest public.project_versions;
begin
  if new.stage = 'tender' then
    new.awarded_quote_id := null;
    new.awarded_supplier_id := null;
    return new;
  end if;

  -- Awarded: check only when the stage or the winner changes (projects that
  -- were awarded before this migration keep working until they are changed).
  if tg_op = 'UPDATE'
     and old.stage = 'awarded'
     and new.awarded_quote_id is not distinct from old.awarded_quote_id
     and new.awarded_supplier_id is not distinct from old.awarded_supplier_id then
    return new;
  end if;

  if new.awarded_quote_id is null or new.awarded_supplier_id is null then
    raise exception 'Choose the winning quote and supplier sheet to award the project'
      using errcode = '22023';
  end if;

  if not exists (select 1 from public.hardware_quotes where id = new.awarded_quote_id and project_id = new.id) then
    raise exception 'The winning quote must belong to this project' using errcode = '22023';
  end if;

  select * into v_latest
  from public.project_versions
  where quote_id = new.awarded_quote_id
  order by version_no desc
  limit 1;

  if v_latest.id is null or v_latest.status <> 'approved' then
    raise exception 'Only an approved quote can win (its latest version must be approved)'
      using errcode = '22023';
  end if;

  if not exists (
    select 1 from public.quote_sheets
    where version_id = v_latest.id and supplier_id = new.awarded_supplier_id
  ) then
    raise exception 'The winning supplier must have a sheet in the approved version'
      using errcode = '22023';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_projects_award on public.projects;
create trigger trg_projects_award
  before insert or update of stage, awarded_quote_id, awarded_supplier_id on public.projects
  for each row execute function public.enforce_project_award();

-- -----------------------------------------------------------------------------
-- 9. RLS
-- -----------------------------------------------------------------------------
alter table public.hardware_quotes enable row level security;
alter table public.hardware_quotes force row level security;

drop policy if exists "hardware_quotes_select_team" on public.hardware_quotes;
create policy "hardware_quotes_select_team"
  on public.hardware_quotes for select to authenticated
  using (public.can_view_project(project_id));

drop policy if exists "hardware_quotes_insert_team" on public.hardware_quotes;
create policy "hardware_quotes_insert_team"
  on public.hardware_quotes for insert to authenticated
  with check (public.can_edit_project_content(project_id) and created_by = (select auth.uid()));

drop policy if exists "hardware_quotes_update_team" on public.hardware_quotes;
create policy "hardware_quotes_update_team"
  on public.hardware_quotes for update to authenticated
  using (public.can_edit_project_content(project_id) and not public.quote_is_locked(id))
  with check (public.can_edit_project_content(project_id));

-- Admins delete any quote; the team deletes a quote whose quotation was never imported.
drop policy if exists "hardware_quotes_delete" on public.hardware_quotes;
create policy "hardware_quotes_delete"
  on public.hardware_quotes for delete to authenticated
  using (
    public.is_admin()
    or (
      public.can_edit_project_content(project_id)
      and not exists (
        select 1 from public.project_versions v
        where v.quote_id = hardware_quotes.id and v.upload_id is not null
      )
    )
  );

revoke all on public.hardware_quotes from anon, authenticated;
grant select, insert, delete on public.hardware_quotes to authenticated;
grant update (builder_name) on public.hardware_quotes to authenticated;

alter table public.quote_sheets enable row level security;
alter table public.quote_sheets force row level security;

drop policy if exists "quote_sheets_select_team" on public.quote_sheets;
create policy "quote_sheets_select_team"
  on public.quote_sheets for select to authenticated
  using (public.can_view_project(public.project_of_version(version_id)));

drop policy if exists "quote_sheets_write_team" on public.quote_sheets;
create policy "quote_sheets_write_team"
  on public.quote_sheets for all to authenticated
  using (public.can_edit_project_content(public.project_of_version(version_id)))
  with check (public.can_edit_project_content(public.project_of_version(version_id)));

revoke all on public.quote_sheets from anon, authenticated;
grant select, insert, delete on public.quote_sheets to authenticated;
grant update (name, position) on public.quote_sheets to authenticated;

-- Comments: an optional sheet of the same version.
drop policy if exists "version_comments_insert_reviewers" on public.version_comments;
create policy "version_comments_insert_reviewers"
  on public.version_comments for insert to authenticated
  with check (
    author_id = (select auth.uid())
    and public.can_review_project(public.project_of_version(version_id))
    and (
      door_group_id is null
      or exists (select 1 from public.door_groups g
                 where g.id = door_group_id and g.version_id = version_comments.version_id)
    )
    and (
      sheet_id is null
      or exists (select 1 from public.quote_sheets s
                 where s.id = sheet_id and s.version_id = version_comments.version_id)
    )
  );

-- -----------------------------------------------------------------------------
-- 10. Shared writer: doors, door groups and their lines on every sheet
--
--   p_groups: [{position, group_key, door_tag, room_name, classification, leaf,
--               door_size, door_qty, matched_set_id, match_status, match_score,
--               match_reason, pm_remarks,
--               carried_from_group_id?,   -- re-import: keep this group's lines
--               lines: [{position, sku, description, qty_per_door, unit_price,
--                        origin, part_id, mhqt_remarks}]}]
--   p_carry:  lines of the version the file was compared with
--             [{base_group_id, supplier_id, position, sku, ...}] (re-import).
--   A group with carried_from_group_id gets, on each sheet, the lines that
--   group had on the sheet of the same supplier (from p_carry). Other groups
--   get "lines" on every sheet.
-- -----------------------------------------------------------------------------
drop function if exists public.write_quotation_content(uuid, uuid, jsonb, jsonb);

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
        v_group_id, s.id, l.position, l.sku, l.description, l.qty_per_door, l.unit_price,
        coalesce(l.origin, 'set')::public.line_origin, l.part_id, coalesce(l.mhqt_remarks, '')
      from public.quote_sheets s
      cross join jsonb_to_recordset(coalesce(v_group->'lines', '[]'::jsonb)) as l(
        position integer, sku text, description text, qty_per_door numeric,
        unit_price numeric, origin text, part_id uuid, mhqt_remarks text
      )
      where s.version_id = p_version_id;
    end if;
  end loop;
end;
$$;

-- -----------------------------------------------------------------------------
-- 11. import_quotation: new builder quote + v1 + first supplier sheet
-- -----------------------------------------------------------------------------
drop function if exists public.import_quotation(uuid, text, text, jsonb, jsonb, jsonb);

create or replace function public.import_quotation(
  p_project_id uuid,
  p_builder_name text,
  p_supplier_id uuid,
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
  v_builder text := btrim(coalesce(p_builder_name, ''));
  v_quote_id uuid;
  v_version_id uuid;
  v_upload_id uuid;
  v_sheet_name text;
begin
  if auth.uid() is null then
    raise exception 'Not signed in' using errcode = '42501';
  end if;

  if not public.can_edit_project_content(p_project_id) then
    raise exception 'Only an estimator assigned to this project (or an admin) can import a quotation'
      using errcode = '42501';
  end if;

  if v_builder = '' then
    raise exception 'Enter the builder this quote is for' using errcode = '22023';
  end if;

  select name into v_sheet_name from public.suppliers where id = p_supplier_id;
  if v_sheet_name is null then
    raise exception 'Choose the supplier for the first sheet' using errcode = '22023';
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
    select 1 from public.hardware_quotes
    where project_id = p_project_id and lower(btrim(builder_name)) = lower(v_builder)
  ) then
    raise exception 'This project already has a quote for "%"', v_builder using errcode = '23505';
  end if;

  insert into public.hardware_quotes (project_id, builder_name, created_by)
  values (p_project_id, v_builder, auth.uid())
  returning id into v_quote_id;

  insert into public.project_versions (project_id, quote_id, version_no, status, created_by)
  values (p_project_id, v_quote_id, 1, 'draft', auth.uid())
  returning id into v_version_id;

  insert into public.quote_sheets (version_id, supplier_id, name, position)
  values (v_version_id, p_supplier_id, v_sheet_name, 0);

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
-- 12. reimport_quotation: per quote
-- -----------------------------------------------------------------------------
drop function if exists public.reimport_quotation(uuid, text, text, jsonb, jsonb, jsonb);

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
           'mhqt_remarks', l.mhqt_remarks)), '[]'::jsonb)
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

-- -----------------------------------------------------------------------------
-- 13. create_revision: per quote, copies sheets too
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
    group_id, sheet_id, position, sku, description, qty_per_door, unit_price, origin, part_id, mhqt_remarks
  )
  select
    ng.id, ns.id, l.position, l.sku, l.description, l.qty_per_door, l.unit_price, l.origin,
    l.part_id, l.mhqt_remarks
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

-- -----------------------------------------------------------------------------
-- 14. transition_version: + quote lock (same signature and rules otherwise)
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

  perform public.assert_quote_open(v_version.quote_id);

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
-- 15. add_quote_sheet: new supplier sheet in a draft, lines copied from a sheet
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

  -- Same door groups and parts as the source sheet; the estimator swaps the
  -- parts this supplier doesn't carry (the grid flags them).
  insert into public.project_lines (
    group_id, sheet_id, position, sku, description, qty_per_door, unit_price, origin, part_id, mhqt_remarks
  )
  select l.group_id, v_sheet_id, l.position, l.sku, l.description, l.qty_per_door, l.unit_price,
         l.origin, l.part_id, l.mhqt_remarks
  from public.project_lines l
  where l.sheet_id = v_source;

  return v_sheet_id;
end;
$$;

-- -----------------------------------------------------------------------------
-- 16. Activity and notifications name the quote ("Builder v2")
-- -----------------------------------------------------------------------------
create or replace function public.activity_project_versions()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_file text;
  v_groups integer;
  v_previous integer;
  v_label text := public.version_label(new.id);
begin
  if tg_op = 'INSERT' then
    if new.version_no > 1 then
      select max(version_no) into v_previous
      from public.project_versions
      where quote_id = new.quote_id and version_no < new.version_no;
      perform public.log_project_activity(new.project_id, new.id, 'version', 'revision_started',
        'started ' || v_label || coalesce(' from v' || v_previous, ''),
        jsonb_build_object('version_no', new.version_no, 'from_version_no', v_previous, 'quote_id', new.quote_id),
        coalesce(auth.uid(), new.created_by));
    end if;
    return new;
  end if;

  if new.upload_id is distinct from old.upload_id and new.upload_id is not null then
    select original_filename into v_file from public.quotation_uploads where id = new.upload_id;
    select count(*) into v_groups from public.door_groups where version_id = new.id;
    if old.upload_id is null and new.version_no = 1 then
      perform public.log_project_activity(new.project_id, new.id, 'quotation', 'quotation_imported',
        'imported the quotation (' || v_label || ')',
        jsonb_build_object('file', v_file, 'door_groups', v_groups, 'version_no', 1, 'quote_id', new.quote_id));
    else
      perform public.log_project_activity(new.project_id, new.id, 'quotation', 'quotation_reimported',
        're-imported the quotation into ' || v_label,
        jsonb_build_object('file', v_file, 'door_groups', v_groups, 'version_no', new.version_no, 'quote_id', new.quote_id));
    end if;
  end if;

  if new.markup_pct is distinct from old.markup_pct then
    perform public.log_project_activity(new.project_id, new.id, 'hardware', 'markup_changed',
      'changed the markup on ' || v_label,
      jsonb_build_object('from', old.markup_pct, 'to', new.markup_pct, 'version_no', new.version_no));
  end if;
  return new;
end;
$$;

create or replace function public.activity_approval_events()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_version public.project_versions;
  v_label text;
begin
  select * into v_version from public.project_versions where id = new.version_id;
  if v_version.id is null then
    return new;
  end if;
  v_label := public.version_label(v_version.id);
  perform public.log_project_activity(v_version.project_id, v_version.id, 'version',
    case new.action when 'submit' then 'version_submitted'
                    when 'approve' then 'version_approved'
                    else 'version_changes_requested' end,
    case new.action when 'submit' then 'submitted ' || v_label || ' for review'
                    when 'approve' then 'approved ' || v_label
                    else 'requested changes on ' || v_label end,
    jsonb_build_object(
      'version_no', v_version.version_no,
      'comment', nullif(new.comment, ''),
      'from', case new.action when 'submit' then 'draft' else 'submitted' end,
      'to', case new.action when 'submit' then 'submitted'
                            when 'approve' then 'approved'
                            else 'changes_requested' end),
    new.actor);
  return new;
end;
$$;

create or replace function public.activity_project_lines()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_group_id uuid := coalesce(new.group_id, old.group_id);
  v_version public.project_versions;
  v_group_created timestamptz;
  v_key text := case tg_op when 'INSERT' then 'added' when 'DELETE' then 'removed' else 'edited' end;
  v_existing uuid;
begin
  select dg.created_at into v_group_created from public.door_groups dg where dg.id = v_group_id;
  -- Group gone (being deleted) or created in this same transaction: not an edit.
  if v_group_created is null or v_group_created = now() then
    return coalesce(new, old);
  end if;
  -- Lines of a sheet added or removed in this transaction belong to that event.
  if not exists (select 1 from public.quote_sheets s
                 where s.id = coalesce(new.sheet_id, old.sheet_id) and s.created_at <> now()) then
    return coalesce(new, old);
  end if;

  select pv.* into v_version
  from public.project_versions pv
  join public.door_groups dg on dg.version_id = pv.id
  where dg.id = v_group_id;

  select id into v_existing
  from public.project_activity
  where project_id = v_version.project_id
    and version_id = v_version.id
    and action = 'lines_edited'
    and actor_id is not distinct from auth.uid()
    and updated_at > now() - interval '30 minutes'
  order by updated_at desc
  limit 1;

  if v_existing is null then
    perform public.log_project_activity(v_version.project_id, v_version.id, 'hardware', 'lines_edited',
      'updated hardware lines in ' || public.version_label(v_version.id),
      jsonb_build_object('version_no', v_version.version_no, 'edited', 0, 'added', 0, 'removed', 0)
        || jsonb_build_object(v_key, 1));
  else
    update public.project_activity
    set details = jsonb_set(details, array[v_key], to_jsonb(coalesce((details->>v_key)::integer, 0) + 1)),
        updated_at = now()
    where id = v_existing;
  end if;
  return coalesce(new, old);
end;
$$;

create or replace function public.notify_version_event()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_version public.project_versions;
  v_pm uuid;
  v_label text;
  v_version_label text;
  v_title text;
  v_kind text;
  v_recipient uuid;
begin
  select * into v_version from public.project_versions where id = new.version_id;
  if v_version.id is null then
    return new;
  end if;
  v_label := public.project_label(v_version.project_id);
  v_version_label := public.version_label(v_version.id);

  if new.action = 'submit' then
    select assigned_pm into v_pm from public.projects where id = v_version.project_id;
    v_title := v_version_label || ' of ' || v_label || ' is waiting for your review';
    if v_pm is not null then
      perform public.notify_user(v_pm, v_version.project_id, v_version.id, 'submitted', v_title,
        coalesce(public.actor_name(), 'Someone') || ' submitted it.'
        || case when new.comment <> '' then ' "' || new.comment || '"' else '' end);
    else
      for v_recipient in select id from public.profiles where role = 'admin' loop
        perform public.notify_user(v_recipient, v_version.project_id, v_version.id, 'submitted',
          v_title || ' (no PM assigned)',
          coalesce(public.actor_name(), 'Someone') || ' submitted it.');
      end loop;
    end if;
  else
    if new.action = 'approve' then
      v_kind := 'approved';
      v_title := v_version_label || ' of ' || v_label || ' was approved';
    else
      v_kind := 'changes_requested';
      v_title := 'Changes requested on ' || v_version_label || ' of ' || v_label;
    end if;

    for v_recipient in
      select estimator_id from public.project_estimators where project_id = v_version.project_id
      union
      select v_version.created_by
    loop
      perform public.notify_user(v_recipient, v_version.project_id, v_version.id, v_kind, v_title,
        coalesce(public.actor_name(), 'Someone')
        || case when new.comment <> '' then ': "' || new.comment || '"' else '' end);
    end loop;
  end if;

  return new;
end;
$$;

create or replace function public.on_version_comment_added()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_version public.project_versions;
  v_room text;
  v_sheet text;
  v_where text;
  v_excerpt text := left(regexp_replace(btrim(new.body), '\s+', ' ', 'g'), 140);
  v_label text;
  v_estimator uuid;
begin
  select * into v_version from public.project_versions where id = new.version_id;
  v_label := public.version_label(v_version.id);
  if new.door_group_id is not null then
    select nullif(btrim(room_name), '') into v_room from public.door_groups where id = new.door_group_id;
  end if;
  if new.sheet_id is not null then
    select nullif(btrim(name), '') into v_sheet from public.quote_sheets where id = new.sheet_id;
  end if;
  v_where := concat_ws(', ', v_room, v_sheet);
  v_where := nullif(v_where, '');

  perform public.log_project_activity(v_version.project_id, v_version.id, 'version', 'comment_added',
    'commented on ' || coalesce(v_where || ' in ', '') || v_label,
    jsonb_build_object('version_no', v_version.version_no, 'room', v_room, 'sheet', v_sheet, 'comment', v_excerpt),
    new.author_id);

  for v_estimator in
    select estimator_id from public.project_estimators where project_id = v_version.project_id
  loop
    perform public.notify_user(v_estimator, v_version.project_id, v_version.id, 'comment',
      public.actor_name() || ' commented on ' || public.project_label(v_version.project_id)
        || ' ' || v_label,
      coalesce(v_where || ': ', '') || v_excerpt);
  end loop;
  return new;
end;
$$;

-- Quotes: added / renamed / removed.
create or replace function public.activity_hardware_quotes()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    perform public.log_project_activity(new.project_id, null, 'quotation', 'quote_added',
      'added a hardware quote for ' || new.builder_name,
      jsonb_build_object('quote_id', new.id, 'builder', new.builder_name),
      coalesce(auth.uid(), new.created_by));
    return new;
  elsif tg_op = 'UPDATE' then
    if new.builder_name is distinct from old.builder_name then
      perform public.log_project_activity(new.project_id, null, 'quotation', 'quote_renamed',
        'renamed the quote for ' || old.builder_name || ' to ' || new.builder_name,
        jsonb_build_object('quote_id', new.id, 'from', old.builder_name, 'to', new.builder_name));
    end if;
    return new;
  end if;
  perform public.log_project_activity(old.project_id, null, 'quotation', 'quote_removed',
    'removed the hardware quote for ' || old.builder_name,
    jsonb_build_object('builder', old.builder_name));
  return old;
end;
$$;

drop trigger if exists trg_activity_hardware_quotes on public.hardware_quotes;
create trigger trg_activity_hardware_quotes
  after insert or update or delete on public.hardware_quotes
  for each row execute function public.activity_hardware_quotes();

-- Sheets added / renamed / removed in an existing draft (not the ones created
-- together with their version by an import or a new revision).
create or replace function public.activity_quote_sheets()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_version public.project_versions;
begin
  select * into v_version from public.project_versions
  where id = coalesce(new.version_id, old.version_id);
  if v_version.id is null or v_version.created_at = now() then
    return coalesce(new, old);
  end if;

  if tg_op = 'INSERT' then
    perform public.log_project_activity(v_version.project_id, v_version.id, 'hardware', 'sheet_added',
      'added the ' || new.name || ' sheet to ' || public.version_label(v_version.id),
      jsonb_build_object('sheet', new.name, 'version_no', v_version.version_no));
  elsif tg_op = 'UPDATE' then
    if new.name is distinct from old.name then
      perform public.log_project_activity(v_version.project_id, v_version.id, 'hardware', 'sheet_renamed',
        'renamed the ' || old.name || ' sheet to ' || new.name || ' in ' || public.version_label(v_version.id),
        jsonb_build_object('from', old.name, 'to', new.name, 'version_no', v_version.version_no));
    end if;
  else
    perform public.log_project_activity(v_version.project_id, v_version.id, 'hardware', 'sheet_removed',
      'removed the ' || old.name || ' sheet from ' || public.version_label(v_version.id),
      jsonb_build_object('sheet', old.name, 'version_no', v_version.version_no));
  end if;
  return coalesce(new, old);
end;
$$;

drop trigger if exists trg_activity_quote_sheets on public.quote_sheets;
create trigger trg_activity_quote_sheets
  after insert or update or delete on public.quote_sheets
  for each row execute function public.activity_quote_sheets();

-- Stage changes name the winner.
create or replace function public.activity_project_stage()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_builder text;
  v_supplier text;
begin
  if new.stage is distinct from old.stage
     or new.awarded_quote_id is distinct from old.awarded_quote_id
     or new.awarded_supplier_id is distinct from old.awarded_supplier_id then
    if new.stage = 'awarded' and new.awarded_quote_id is not null then
      select builder_name into v_builder from public.hardware_quotes where id = new.awarded_quote_id;
      select name into v_supplier from public.suppliers where id = new.awarded_supplier_id;
      perform public.log_project_activity(new.id, null, 'project', 'stage_changed',
        'awarded the project to ' || coalesce(v_builder, 'a quote')
          || coalesce(' (' || v_supplier || ')', ''),
        jsonb_build_object('from', old.stage, 'to', new.stage, 'builder', v_builder, 'supplier', v_supplier));
    elsif new.stage is distinct from old.stage then
      perform public.log_project_activity(new.id, null, 'project', 'stage_changed',
        'moved the project to ' || case new.stage when 'awarded' then 'Awarded' else 'Tender' end,
        jsonb_build_object('from', old.stage, 'to', new.stage));
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_activity_project_stage on public.projects;
create trigger trg_activity_project_stage
  after update of stage, awarded_quote_id, awarded_supplier_id on public.projects
  for each row execute function public.activity_project_stage();

-- -----------------------------------------------------------------------------
-- 17. Grants
-- -----------------------------------------------------------------------------
revoke all on function public.write_quotation_content(uuid, uuid, jsonb, jsonb, jsonb) from public;
revoke all on function public.import_quotation(uuid, text, uuid, text, text, jsonb, jsonb, jsonb) from public;
revoke all on function public.reimport_quotation(uuid, text, text, jsonb, jsonb, jsonb) from public;
revoke all on function public.add_quote_sheet(uuid, uuid, text, uuid) from public;

grant execute on function public.write_quotation_content(uuid, uuid, jsonb, jsonb, jsonb) to authenticated;
grant execute on function public.import_quotation(uuid, text, uuid, text, text, jsonb, jsonb, jsonb) to authenticated;
grant execute on function public.reimport_quotation(uuid, text, text, jsonb, jsonb, jsonb) to authenticated;
grant execute on function public.add_quote_sheet(uuid, uuid, text, uuid) to authenticated;
