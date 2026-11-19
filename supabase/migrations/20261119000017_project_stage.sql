-- =============================================================================
-- Migration: 20261119000017_project_stage.sql
-- Purpose: Project stage: Tender (default) or Awarded.
--   Who can change it follows the existing project edit rules: the project's
--   assigned PM and admins (policies projects_update_own_pm / projects_update_admin).
--   Every change is recorded in the project activity log (migration 016).
-- =============================================================================

alter table public.projects
  add column if not exists stage text not null default 'tender';

alter table public.projects drop constraint if exists projects_stage_check;
alter table public.projects
  add constraint projects_stage_check check (stage in ('tender', 'awarded'));

create or replace function public.activity_project_stage()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.stage is distinct from old.stage then
    perform public.log_project_activity(new.id, null, 'project', 'stage_changed',
      'moved the project to ' || case new.stage when 'awarded' then 'Awarded' else 'Tender' end,
      jsonb_build_object('from', old.stage, 'to', new.stage));
  end if;
  return new;
end;
$$;

drop trigger if exists trg_activity_project_stage on public.projects;
create trigger trg_activity_project_stage
  after update of stage on public.projects
  for each row execute function public.activity_project_stage();
