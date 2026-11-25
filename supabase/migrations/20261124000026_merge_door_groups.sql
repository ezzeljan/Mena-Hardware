-- Merge and unmerge door groups in a draft version.
--
-- Merge: several door groups become one (the first, "target"). Its door qty is
-- the sum, its room name is the one given (the rooms joined), and its lines
-- are its own lines the estimator kept plus copies of the other groups' lines
-- they chose to include (hardware not in every group). PM comments on the
-- other groups move to it. The groups it was made from are remembered in
-- merged_from so it can be unmerged.
--
-- Unmerge: the group goes back to the groups it was made from, each with its
-- own room, door qty and key, and the merged group's current specs, set and
-- hardware lines (on every supplier sheet).
--
-- Only the project's team can do this, and only on a draft version of an open
-- quote (the draft-lock triggers on door_groups and project_lines). Unmerge
-- runs as the caller; merge runs as owner so it can move the PM comments
-- (estimators can't edit those), after checking the caller can edit the
-- project's content.

alter table public.door_groups
  add column if not exists merged_from jsonb not null default '[]'::jsonb;

comment on column public.door_groups.merged_from is
  'Groups this one was merged from: [{group_key, room_name, door_qty, door_tag}] (empty when not merged).';

create or replace function public.merge_door_groups(
  p_target uuid,
  p_others uuid[],
  p_room_name text,
  p_keep_line_ids uuid[],
  p_copy_line_ids uuid[]
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_target public.door_groups;
  v_count int;
  v_from jsonb;
  v_qty numeric;
  v_max_pos int;
begin
  select * into v_target from public.door_groups where id = p_target;
  if not found then
    raise exception 'Door group not found' using errcode = 'P0002';
  end if;
  if not public.can_edit_project_content(public.project_of_version(v_target.version_id)) then
    raise exception 'Only the project team can merge door groups' using errcode = '42501';
  end if;
  if p_others is null or cardinality(p_others) = 0 then
    raise exception 'Pick at least two door groups to merge' using errcode = '22023';
  end if;
  if p_target = any(p_others) then
    raise exception 'A door group cannot be merged with itself' using errcode = '22023';
  end if;
  select count(*) into v_count from public.door_groups
  where id = any(p_others) and version_id = v_target.version_id;
  if v_count <> cardinality(p_others) then
    raise exception 'All door groups must be in the same version' using errcode = '22023';
  end if;
  if coalesce(btrim(p_room_name), '') = '' then
    raise exception 'The merged door group needs a room name' using errcode = '22023';
  end if;

  -- What it was made from: each group's own merged_from, or the group itself.
  select coalesce(jsonb_agg(part order by ord, sub), '[]'::jsonb) into v_from
  from (
    select case when g.id = p_target then 0 else 1 end as ord, g.position * 1000 + coalesce(e.idx, 0) as sub,
           coalesce(e.part, jsonb_build_object('group_key', g.group_key, 'room_name', g.room_name,
                                               'door_qty', g.door_qty, 'door_tag', g.door_tag)) as part
    from public.door_groups g
    left join lateral (
      select value as part, ordinality as idx
      from jsonb_array_elements(g.merged_from) with ordinality
    ) e on jsonb_array_length(g.merged_from) > 0
    where g.id = p_target or g.id = any(p_others)
  ) s;

  select sum(door_qty) into v_qty from public.door_groups where id = p_target or id = any(p_others);

  -- Lines: the target's lines the estimator kept, then copies of the chosen lines.
  delete from public.project_lines
  where group_id = p_target and not (id = any(coalesce(p_keep_line_ids, '{}')));

  select coalesce(max(position), 0) into v_max_pos from public.project_lines where group_id = p_target;
  insert into public.project_lines
    (group_id, position, sku, description, qty_per_door, unit_price, origin, part_id, mhqt_remarks, sheet_id, review_flag)
  select p_target, v_max_pos + row_number() over (order by g.position, l.position),
         l.sku, l.description, l.qty_per_door, l.unit_price, l.origin, l.part_id, l.mhqt_remarks, l.sheet_id, l.review_flag
  from public.project_lines l
  join public.door_groups g on g.id = l.group_id
  where l.id = any(coalesce(p_copy_line_ids, '{}')) and l.group_id = any(p_others);

  -- PM comments follow the doors.
  update public.version_comments set door_group_id = p_target where door_group_id = any(p_others);

  update public.door_groups
  set door_qty = v_qty, room_name = btrim(p_room_name), merged_from = v_from
  where id = p_target;

  delete from public.door_groups where id = any(p_others);
end;
$$;

create or replace function public.unmerge_door_group(p_group uuid)
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_group public.door_groups;
  v_parts jsonb;
  v_n int;
  v_first jsonb;
  v_part jsonb;
  v_new uuid;
  i int;
begin
  select * into v_group from public.door_groups where id = p_group;
  if not found then
    raise exception 'Door group not found' using errcode = 'P0002';
  end if;
  v_parts := v_group.merged_from;
  v_n := jsonb_array_length(v_parts);
  if v_n < 2 then
    raise exception 'This door group was not merged' using errcode = '22023';
  end if;

  -- Make room right after it for the groups it splits back into.
  update public.door_groups set position = position + (v_n - 1)
  where version_id = v_group.version_id and position > v_group.position;

  -- The first part keeps this group's id (its lines, comments).
  v_first := v_parts -> 0;
  update public.door_groups
  set group_key = v_first ->> 'group_key',
      room_name = v_first ->> 'room_name',
      door_qty = (v_first ->> 'door_qty')::numeric,
      door_tag = coalesce(v_first ->> 'door_tag', ''),
      merged_from = '[]'::jsonb
  where id = p_group;

  for i in 1 .. v_n - 1 loop
    v_part := v_parts -> i;
    begin
      insert into public.door_groups
        (version_id, position, group_key, room_name, classification, leaf, door_size, door_qty,
         matched_set_id, match_status, match_score, match_reason, pm_remarks, door_tag)
      values
        (v_group.version_id, v_group.position + i, v_part ->> 'group_key', v_part ->> 'room_name',
         v_group.classification, v_group.leaf, v_group.door_size, (v_part ->> 'door_qty')::numeric,
         v_group.matched_set_id, v_group.match_status, v_group.match_score, v_group.match_reason,
         '', coalesce(v_part ->> 'door_tag', ''))
      returning id into v_new;
    exception when unique_violation then
      raise exception 'Cannot unmerge: another door group already uses the key of "%"', v_part ->> 'room_name'
        using errcode = '23505';
    end;

    -- Same hardware on every supplier sheet.
    insert into public.project_lines
      (group_id, position, sku, description, qty_per_door, unit_price, origin, part_id, mhqt_remarks, sheet_id, review_flag)
    select v_new, l.position, l.sku, l.description, l.qty_per_door, l.unit_price, l.origin, l.part_id,
           l.mhqt_remarks, l.sheet_id, l.review_flag
    from public.project_lines l
    where l.group_id = p_group;
  end loop;
end;
$$;

revoke all on function public.merge_door_groups(uuid, uuid[], text, uuid[], uuid[]) from public, anon;
revoke all on function public.unmerge_door_group(uuid) from public, anon;
grant execute on function public.merge_door_groups(uuid, uuid[], text, uuid[], uuid[]) to authenticated;
grant execute on function public.unmerge_door_group(uuid) to authenticated;
