-- What the quotation said about each door group, kept with the upload so the
-- Hardware grid can show it (the door group popover): the doors, their
-- hardware (Builder HW columns, prep / install values), their comments and the
-- import rules' notes.
--
-- One row per upload and group key. Revisions share their upload, merged
-- groups keep the first group's key, and unmerged groups get their keys back,
-- so no other function has to copy it.
--
-- write_quotation_content (from 024) also saves each group's "quote_info".

create table if not exists public.quotation_group_info (
  upload_id uuid not null references public.quotation_uploads(id) on delete cascade,
  group_key text not null,
  info jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  primary key (upload_id, group_key)
);

comment on table public.quotation_group_info is
  'Per upload and door group key: {doors, hardware, headers, prep_values, comments, notes} from the quotation and the import rules.';

alter table public.quotation_group_info enable row level security;
alter table public.quotation_group_info force row level security;

drop policy if exists "quotation_group_info_select_team" on public.quotation_group_info;
create policy "quotation_group_info_select_team"
  on public.quotation_group_info for select to authenticated
  using (public.can_view_project(public.project_of_upload(upload_id)));

drop policy if exists "quotation_group_info_insert_team" on public.quotation_group_info;
create policy "quotation_group_info_insert_team"
  on public.quotation_group_info for insert to authenticated
  with check (public.can_edit_project_content(public.project_of_upload(upload_id)));

-- The import's upsert (same group key twice in one upload).
drop policy if exists "quotation_group_info_update_team" on public.quotation_group_info;
create policy "quotation_group_info_update_team"
  on public.quotation_group_info for update to authenticated
  using (public.can_edit_project_content(public.project_of_upload(upload_id)))
  with check (public.can_edit_project_content(public.project_of_upload(upload_id)));

drop policy if exists "quotation_group_info_delete_admin" on public.quotation_group_info;
create policy "quotation_group_info_delete_admin"
  on public.quotation_group_info for delete to authenticated
  using (public.is_admin());

grant select, insert, update, delete on public.quotation_group_info to authenticated;

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

    -- What the quotation said about the group (one row per upload and group).
    if v_group ? 'quote_info' then
      insert into public.quotation_group_info (upload_id, group_key, info)
      values (p_upload_id, v_group->>'group_key', coalesce(v_group->'quote_info', '{}'::jsonb))
      on conflict (upload_id, group_key) do update set info = excluded.info;
    end if;

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

