-- =============================================================================
-- Migration: 20261117000003_phase2_projects_and_approvals.sql
-- Purpose: Phase 2 schema for projects, quotation uploads & doors, project
--          versions, door groups, project lines, approval events, version
--          locking triggers, Storage bucket ('quotations'), and RLS policies.
-- =============================================================================

-- 1. Enums
do $$
begin
  if not exists (select 1 from pg_type where typname = 'project_status') then
    create type public.project_status as enum ('active', 'archived');
  end if;
  if not exists (select 1 from pg_type where typname = 'version_status') then
    create type public.version_status as enum ('draft', 'submitted', 'approved', 'changes_requested', 'superseded');
  end if;
  if not exists (select 1 from pg_type where typname = 'match_status') then
    create type public.match_status as enum ('auto', 'confirmed', 'manual', 'unmatched');
  end if;
  if not exists (select 1 from pg_type where typname = 'line_origin') then
    create type public.line_origin as enum ('set', 'added', 'edited');
  end if;
  if not exists (select 1 from pg_type where typname = 'approval_action') then
    create type public.approval_action as enum ('submit', 'approve', 'reject');
  end if;
end $$;

-- 2. Projects
create table if not exists public.projects (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  client text not null default '',
  site text not null default '',
  status public.project_status not null default 'active',
  created_by uuid not null references public.profiles(id) on delete restrict,
  assigned_pm uuid null references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 3. Quotation Uploads
create table if not exists public.quotation_uploads (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  storage_path text not null,
  original_filename text not null,
  uploaded_by uuid not null references public.profiles(id) on delete restrict,
  parse_report jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

-- 4. Quotation Doors (raw parsed rows from uploaded Excel quotation)
create table if not exists public.quotation_doors (
  id uuid primary key default gen_random_uuid(),
  upload_id uuid not null references public.quotation_uploads(id) on delete cascade,
  door_ref text not null default '',
  room_name text not null,
  classification text not null default '',
  leaf text not null default '',
  door_size text not null default '',
  qty numeric(12, 3) not null check (qty > 0),
  source_row integer not null check (source_row > 0),
  created_at timestamptz not null default now()
);

-- 5. Project Versions
create table if not exists public.project_versions (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  version_no integer not null check (version_no >= 1),
  status public.version_status not null default 'draft',
  upload_id uuid null references public.quotation_uploads(id) on delete set null,
  created_by uuid not null references public.profiles(id) on delete restrict,
  submitted_at timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (project_id, version_no)
);

-- 6. Door Groups (grouped doors within a project version)
create table if not exists public.door_groups (
  id uuid primary key default gen_random_uuid(),
  version_id uuid not null references public.project_versions(id) on delete cascade,
  position integer not null check (position >= 0),
  group_key text not null,
  room_name text not null,
  classification text not null default '',
  leaf text not null default '',
  door_size text not null default '',
  door_qty numeric(12, 3) not null check (door_qty > 0),
  matched_set_id uuid null references public.standard_sets(id) on delete set null,
  match_status public.match_status not null default 'unmatched',
  match_score numeric(5, 4) null,
  match_reason text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (version_id, group_key),
  unique (version_id, position) deferrable initially deferred
);

-- 7. Project Lines (editable hardware lines per door group in a draft version)
-- Note: unit_price is nullable intentionally; null means blank on purpose, never defaults to 0.
create table if not exists public.project_lines (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.door_groups(id) on delete cascade,
  position integer not null check (position >= 0),
  sku text not null,
  description text not null,
  qty_per_door numeric(12, 3) not null check (qty_per_door >= 0),
  unit_price numeric(12, 3) null,
  origin public.line_origin not null default 'set',
  part_id uuid null references public.parts(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (group_id, position) deferrable initially deferred
);

-- 8. Approval Events (append-only audit log of submit / approve / reject)
create table if not exists public.approval_events (
  id uuid primary key default gen_random_uuid(),
  version_id uuid not null references public.project_versions(id) on delete cascade,
  action public.approval_action not null,
  actor uuid not null references public.profiles(id) on delete restrict,
  comment text not null default '',
  created_at timestamptz not null default now()
);

-- =============================================================================
-- Indexes
-- =============================================================================
create index if not exists idx_projects_status_pm on public.projects(status, assigned_pm);
create index if not exists idx_quotation_uploads_project on public.quotation_uploads(project_id, created_at desc);
create index if not exists idx_quotation_doors_upload on public.quotation_doors(upload_id, source_row);
create index if not exists idx_project_versions_project on public.project_versions(project_id, version_no desc);
create index if not exists idx_door_groups_version on public.door_groups(version_id, position);
create index if not exists idx_project_lines_group on public.project_lines(group_id, position);
create index if not exists idx_approval_events_version on public.approval_events(version_id, created_at desc);

-- =============================================================================
-- Triggers: updated_at
-- =============================================================================
drop trigger if exists trg_projects_updated_at on public.projects;
create trigger trg_projects_updated_at
  before update on public.projects
  for each row execute function public.set_updated_at();

drop trigger if exists trg_project_versions_updated_at on public.project_versions;
create trigger trg_project_versions_updated_at
  before update on public.project_versions
  for each row execute function public.set_updated_at();

drop trigger if exists trg_door_groups_updated_at on public.door_groups;
create trigger trg_door_groups_updated_at
  before update on public.door_groups
  for each row execute function public.set_updated_at();

drop trigger if exists trg_project_lines_updated_at on public.project_lines;
create trigger trg_project_lines_updated_at
  before update on public.project_lines
  for each row execute function public.set_updated_at();

-- =============================================================================
-- Triggers: Version Locking (blocks edits to non-draft versions at DB level)
-- =============================================================================
create or replace function public.enforce_draft_version_for_groups()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_version_id uuid;
  v_status public.version_status;
begin
  v_version_id := case when tg_op = 'DELETE' then old.version_id else new.version_id end;

  select status into v_status from public.project_versions where id = v_version_id;
  if v_status is distinct from 'draft' then
    raise exception 'Cannot modify door groups: version status is "%" (must be draft)', v_status
      using errcode = '42501';
  end if;

  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

drop trigger if exists trg_door_groups_require_draft on public.door_groups;
create trigger trg_door_groups_require_draft
  before insert or update or delete on public.door_groups
  for each row execute function public.enforce_draft_version_for_groups();

create or replace function public.enforce_draft_version_for_lines()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_group_id uuid;
  v_status public.version_status;
begin
  v_group_id := case when tg_op = 'DELETE' then old.group_id else new.group_id end;

  select pv.status into v_status
  from public.door_groups dg
  join public.project_versions pv on pv.id = dg.version_id
  where dg.id = v_group_id;

  if v_status is distinct from 'draft' then
    raise exception 'Cannot modify project lines: version status is "%" (must be draft)', v_status
      using errcode = '42501';
  end if;

  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

drop trigger if exists trg_project_lines_require_draft on public.project_lines;
create trigger trg_project_lines_require_draft
  before insert or update or delete on public.project_lines
  for each row execute function public.enforce_draft_version_for_lines();

create or replace function public.enforce_version_status_transition()
returns trigger
language plpgsql
as $$
begin
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

drop trigger if exists trg_project_versions_transition on public.project_versions;
create trigger trg_project_versions_transition
  before update on public.project_versions
  for each row execute function public.enforce_version_status_transition();

-- =============================================================================
-- Role Helpers
-- =============================================================================
create or replace function public.has_role(variadic p_roles public.user_role[])
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.profiles
    where id = (select auth.uid())
      and role = any(p_roles)
  );
$$;

-- =============================================================================
-- Row Level Security (RLS)
-- =============================================================================
alter table public.projects enable row level security;
alter table public.quotation_uploads enable row level security;
alter table public.quotation_doors enable row level security;
alter table public.project_versions enable row level security;
alter table public.door_groups enable row level security;
alter table public.project_lines enable row level security;
alter table public.approval_events enable row level security;

alter table public.projects force row level security;
alter table public.quotation_uploads force row level security;
alter table public.quotation_doors force row level security;
alter table public.project_versions force row level security;
alter table public.door_groups force row level security;
alter table public.project_lines force row level security;
alter table public.approval_events force row level security;

-- Read policies: all authenticated users can read project records
create policy "projects_select_authenticated" on public.projects for select to authenticated using (true);
create policy "quotation_uploads_select_authenticated" on public.quotation_uploads for select to authenticated using (true);
create policy "quotation_doors_select_authenticated" on public.quotation_doors for select to authenticated using (true);
create policy "project_versions_select_authenticated" on public.project_versions for select to authenticated using (true);
create policy "door_groups_select_authenticated" on public.door_groups for select to authenticated using (true);
create policy "project_lines_select_authenticated" on public.project_lines for select to authenticated using (true);
create policy "approval_events_select_authenticated" on public.approval_events for select to authenticated using (true);

-- Projects write policies: admin & estimator create/update; admin only delete
create policy "projects_insert_estimator_admin"
  on public.projects for insert to authenticated
  with check (public.has_role('admin', 'estimator') and created_by = (select auth.uid()));

create policy "projects_update_estimator_admin"
  on public.projects for update to authenticated
  using (public.has_role('admin', 'estimator'))
  with check (public.has_role('admin', 'estimator'));

create policy "projects_delete_admin"
  on public.projects for delete to authenticated
  using (public.is_admin());

-- Quotation uploads & doors: admin & estimator insert; admin delete
create policy "quotation_uploads_insert_estimator_admin"
  on public.quotation_uploads for insert to authenticated
  with check (public.has_role('admin', 'estimator') and uploaded_by = (select auth.uid()));

create policy "quotation_uploads_delete_admin"
  on public.quotation_uploads for delete to authenticated
  using (public.is_admin());

create policy "quotation_doors_insert_estimator_admin"
  on public.quotation_doors for insert to authenticated
  with check (public.has_role('admin', 'estimator'));

create policy "quotation_doors_delete_admin"
  on public.quotation_doors for delete to authenticated
  using (public.is_admin());

-- Project versions:
--   - admin & estimator can insert new drafts and update drafts (e.g. submit)
--   - admin & pm can update submitted versions (approve / reject)
create policy "project_versions_insert_estimator_admin"
  on public.project_versions for insert to authenticated
  with check (public.has_role('admin', 'estimator') and created_by = (select auth.uid()));

create policy "project_versions_update_estimator_admin_draft"
  on public.project_versions for update to authenticated
  using (public.has_role('admin', 'estimator') and status = 'draft')
  with check (public.has_role('admin', 'estimator') and status in ('draft', 'submitted'));

create policy "project_versions_update_pm_admin_review"
  on public.project_versions for update to authenticated
  using (public.has_role('admin', 'pm') and status = 'submitted')
  with check (public.has_role('admin', 'pm') and status in ('approved', 'changes_requested', 'superseded'));

create policy "project_versions_delete_admin"
  on public.project_versions for delete to authenticated
  using (public.is_admin());

-- Door groups & project lines: admin & estimator manage (DB trigger enforces draft-only)
create policy "door_groups_write_estimator_admin"
  on public.door_groups for all to authenticated
  using (public.has_role('admin', 'estimator'))
  with check (public.has_role('admin', 'estimator'));

create policy "project_lines_write_estimator_admin"
  on public.project_lines for all to authenticated
  using (public.has_role('admin', 'estimator'))
  with check (public.has_role('admin', 'estimator'));

-- Approval events: append-only (no update/delete by anyone)
create policy "approval_events_insert_submit"
  on public.approval_events for insert to authenticated
  with check (
    actor = (select auth.uid())
    and (
      (action = 'submit' and public.has_role('admin', 'estimator'))
      or (action in ('approve', 'reject') and public.has_role('admin', 'pm'))
    )
  );

-- =============================================================================
-- Storage Bucket: 'quotations' (private)
-- =============================================================================
insert into storage.buckets (id, name, public)
values ('quotations', 'quotations', false)
on conflict (id) do nothing;

drop policy if exists "quotations_bucket_select_authenticated" on storage.objects;
create policy "quotations_bucket_select_authenticated"
  on storage.objects for select to authenticated
  using (bucket_id = 'quotations');

drop policy if exists "quotations_bucket_insert_estimator_admin" on storage.objects;
create policy "quotations_bucket_insert_estimator_admin"
  on storage.objects for insert to authenticated
  with check (bucket_id = 'quotations' and public.has_role('admin', 'estimator'));

drop policy if exists "quotations_bucket_delete_admin" on storage.objects;
create policy "quotations_bucket_delete_admin"
  on storage.objects for delete to authenticated
  using (bucket_id = 'quotations' and public.is_admin());
