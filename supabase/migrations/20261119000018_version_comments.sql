-- =============================================================================
-- Migration: 20261119000018_version_comments.sql
-- Purpose: PM comments on a hardware schedule version, shown in a drawer on
--   the hardware page. They replace the "PM REMARKS" grid column.
--   - Written by the project's assigned PM or an admin (can_review_project),
--     in any version status. A comment may point at one door group of that
--     version or be about the whole schedule.
--   - Read by everyone who can view the project.
--   - Authors can delete their own comments; admins can delete any.
--   - Each new comment is logged in the project activity and notifies the
--     project's estimators.
--   - Existing PM remarks are copied in as comments (door_groups.pm_remarks is
--     kept, unused by the app).
-- =============================================================================

create table if not exists public.version_comments (
  id uuid primary key default gen_random_uuid(),
  version_id uuid not null references public.project_versions(id) on delete cascade,
  door_group_id uuid null references public.door_groups(id) on delete set null,
  author_id uuid null references public.profiles(id) on delete set null,
  body text not null check (char_length(btrim(body)) between 1 and 2000),
  created_at timestamptz not null default now()
);

create index if not exists idx_version_comments_version
  on public.version_comments (version_id, created_at);
create index if not exists idx_version_comments_group
  on public.version_comments (door_group_id);

alter table public.version_comments enable row level security;
alter table public.version_comments force row level security;

drop policy if exists "version_comments_select_viewers" on public.version_comments;
create policy "version_comments_select_viewers"
  on public.version_comments for select to authenticated
  using (public.can_view_project(public.project_of_version(version_id)));

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
  );

drop policy if exists "version_comments_delete_own_or_admin" on public.version_comments;
create policy "version_comments_delete_own_or_admin"
  on public.version_comments for delete to authenticated
  using (author_id = (select auth.uid()) or public.is_admin());

revoke all on public.version_comments from anon, authenticated;
grant select, insert, delete on public.version_comments to authenticated;

-- -----------------------------------------------------------------------------
-- Notifications: allow the new kind
-- -----------------------------------------------------------------------------
alter table public.notifications drop constraint if exists notifications_kind_check;
alter table public.notifications
  add constraint notifications_kind_check check (
    kind in ('assigned_estimator', 'assigned_pm', 'submitted', 'approved', 'changes_requested', 'comment')
  );

-- -----------------------------------------------------------------------------
-- New comment → activity log + notify the project's estimators
-- -----------------------------------------------------------------------------
create or replace function public.on_version_comment_added()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_version public.project_versions;
  v_room text;
  v_excerpt text := left(regexp_replace(btrim(new.body), '\s+', ' ', 'g'), 140);
  v_estimator uuid;
begin
  select * into v_version from public.project_versions where id = new.version_id;
  if new.door_group_id is not null then
    select nullif(btrim(room_name), '') into v_room from public.door_groups where id = new.door_group_id;
  end if;

  perform public.log_project_activity(v_version.project_id, v_version.id, 'version', 'comment_added',
    'commented on ' || coalesce(v_room || ' in ', '') || 'v' || v_version.version_no,
    jsonb_build_object('version_no', v_version.version_no, 'room', v_room, 'comment', v_excerpt),
    new.author_id);

  for v_estimator in
    select estimator_id from public.project_estimators where project_id = v_version.project_id
  loop
    perform public.notify_user(v_estimator, v_version.project_id, v_version.id, 'comment',
      public.actor_name() || ' commented on ' || public.project_label(v_version.project_id)
        || ' v' || v_version.version_no,
      coalesce(v_room || ': ', '') || v_excerpt);
  end loop;
  return new;
end;
$$;

drop trigger if exists trg_version_comment_added on public.version_comments;
create trigger trg_version_comment_added
  after insert on public.version_comments
  for each row execute function public.on_version_comment_added();

-- -----------------------------------------------------------------------------
-- Copy existing PM remarks in as comments (once)
-- -----------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from public.version_comments) then
    return;
  end if;
  -- Inserted directly by the migration, so the trigger above would log and
  -- notify; switch it off for the copy.
  alter table public.version_comments disable trigger trg_version_comment_added;
  insert into public.version_comments (version_id, door_group_id, author_id, body, created_at)
  select g.version_id, g.id, p.assigned_pm, btrim(g.pm_remarks), g.updated_at
  from public.door_groups g
  join public.project_versions v on v.id = g.version_id
  join public.projects p on p.id = v.project_id
  where btrim(coalesce(g.pm_remarks, '')) <> '';
  alter table public.version_comments enable trigger trg_version_comment_added;
end $$;
