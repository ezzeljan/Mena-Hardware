-- =============================================================================
-- Migration: 20261118000014_notifications.sql
-- Purpose: In-app notifications, created by the database when:
--   * an estimator is assigned to a project            -> that estimator
--   * a PM is set on a project (by someone else)        -> that PM
--   * a version is submitted                            -> the project's PM
--                                                         (all admins if no PM)
--   * a version is approved / changes are requested     -> the project's
--                                                         estimators and the
--                                                         version's creator
-- Nobody is notified about their own action. Users see and manage only their
-- own notifications; clients cannot create or rewrite them (only mark read or
-- delete). An email sender can later read this table (e.g. a Supabase
-- database webhook on insert).
-- =============================================================================

create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  project_id uuid null references public.projects(id) on delete cascade,
  version_id uuid null references public.project_versions(id) on delete cascade,
  kind text not null check (
    kind in ('assigned_estimator', 'assigned_pm', 'submitted', 'approved', 'changes_requested')
  ),
  title text not null,
  body text not null default '',
  actor_id uuid null references public.profiles(id) on delete set null,
  read_at timestamptz null,
  created_at timestamptz not null default now()
);

create index if not exists idx_notifications_user_created
  on public.notifications (user_id, created_at desc);
create index if not exists idx_notifications_user_unread
  on public.notifications (user_id) where read_at is null;

alter table public.notifications enable row level security;
alter table public.notifications force row level security;

drop policy if exists "notifications_select_own" on public.notifications;
create policy "notifications_select_own"
  on public.notifications for select to authenticated
  using (user_id = (select auth.uid()));

drop policy if exists "notifications_update_own" on public.notifications;
create policy "notifications_update_own"
  on public.notifications for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

drop policy if exists "notifications_delete_own" on public.notifications;
create policy "notifications_delete_own"
  on public.notifications for delete to authenticated
  using (user_id = (select auth.uid()));

-- Clients may only read, mark read (read_at) and delete. Rows are created by
-- the SECURITY DEFINER triggers below.
revoke all on public.notifications from anon, authenticated;
grant select, delete on public.notifications to authenticated;
grant update (read_at) on public.notifications to authenticated;

-- -----------------------------------------------------------------------------
-- Helpers
-- -----------------------------------------------------------------------------
create or replace function public.project_label(p_project_id uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select case when coalesce(btrim(reference_no), '') <> ''
              then reference_no || ' — ' || name
              else name end
  from public.projects where id = p_project_id;
$$;

create or replace function public.notify_user(
  p_user_id uuid,
  p_project_id uuid,
  p_version_id uuid,
  p_kind text,
  p_title text,
  p_body text default ''
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Never notify people about their own actions.
  if p_user_id is null or p_user_id is not distinct from auth.uid() then
    return;
  end if;
  insert into public.notifications (user_id, project_id, version_id, kind, title, body, actor_id)
  values (p_user_id, p_project_id, p_version_id, p_kind, p_title, coalesce(p_body, ''), auth.uid());
end;
$$;

revoke all on function public.notify_user(uuid, uuid, uuid, text, text, text) from public, anon, authenticated;

create or replace function public.actor_name()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(nullif(btrim(full_name), ''), 'Someone')
  from public.profiles where id = auth.uid();
$$;

-- -----------------------------------------------------------------------------
-- Triggers
-- -----------------------------------------------------------------------------
create or replace function public.notify_estimator_assigned()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.notify_user(
    new.estimator_id, new.project_id, null, 'assigned_estimator',
    'You were added to ' || public.project_label(new.project_id),
    coalesce(public.actor_name(), 'Someone') || ' assigned you as an estimator.'
  );
  return new;
end;
$$;

drop trigger if exists trg_notify_estimator_assigned on public.project_estimators;
create trigger trg_notify_estimator_assigned
  after insert on public.project_estimators
  for each row execute function public.notify_estimator_assigned();

create or replace function public.notify_pm_assigned()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.assigned_pm is not null
     and (tg_op = 'INSERT' or new.assigned_pm is distinct from old.assigned_pm) then
    perform public.notify_user(
      new.assigned_pm, new.id, null, 'assigned_pm',
      'You are the PM for ' || public.project_label(new.id),
      coalesce(public.actor_name(), 'Someone') || ' made you the project''s PM.'
    );
  end if;
  return new;
end;
$$;

drop trigger if exists trg_notify_pm_assigned on public.projects;
create trigger trg_notify_pm_assigned
  after insert or update of assigned_pm on public.projects
  for each row execute function public.notify_pm_assigned();

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
  v_title text;
  v_kind text;
  v_recipient uuid;
begin
  select * into v_version from public.project_versions where id = new.version_id;
  if v_version.id is null then
    return new;
  end if;
  v_label := public.project_label(v_version.project_id);

  if new.action = 'submit' then
    select assigned_pm into v_pm from public.projects where id = v_version.project_id;
    v_title := 'v' || v_version.version_no || ' of ' || v_label || ' is waiting for your review';
    if v_pm is not null then
      perform public.notify_user(v_pm, v_version.project_id, v_version.id, 'submitted', v_title,
        coalesce(public.actor_name(), 'Someone') || ' submitted it.'
        || case when new.comment <> '' then ' "' || new.comment || '"' else '' end);
    else
      -- No PM on the project: tell the admins.
      for v_recipient in select id from public.profiles where role = 'admin' loop
        perform public.notify_user(v_recipient, v_version.project_id, v_version.id, 'submitted',
          v_title || ' (no PM assigned)',
          coalesce(public.actor_name(), 'Someone') || ' submitted it.');
      end loop;
    end if;
  else
    if new.action = 'approve' then
      v_kind := 'approved';
      v_title := 'v' || v_version.version_no || ' of ' || v_label || ' was approved';
    else
      v_kind := 'changes_requested';
      v_title := 'Changes requested on v' || v_version.version_no || ' of ' || v_label;
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

drop trigger if exists trg_notify_version_event on public.approval_events;
create trigger trg_notify_version_event
  after insert on public.approval_events
  for each row execute function public.notify_version_event();

-- Internal helpers: not callable by clients (project_label would reveal names
-- of projects the caller cannot see).
revoke all on function public.project_label(uuid) from public, anon, authenticated;
revoke all on function public.actor_name() from public, anon, authenticated;
