-- =============================================================================
-- Migration: 20261118000009_fix_pm_remarks_and_profile_directory.sql
-- Purpose:
--   1. Fix PM remarks (B1). update_door_group_pm_remark() only runs on
--      "submitted" versions, but the BEFORE UPDATE trigger on door_groups
--      rejected every change to a non-draft version, so the RPC always failed.
--      The trigger now lets through an UPDATE on a submitted version only when
--      (a) the RPC set the transaction-local flag app.pm_remark_update = 'on' and
--      (b) nothing other than pm_remarks / updated_at changed.
--      Direct table updates (e.g. by an estimator) on locked versions stay blocked.
--   2. Add public.profile_directory (B3): id, full_name, role for every user,
--      readable by any signed-in user, so estimators can pick a PM and names can
--      be shown. Email and other profile columns stay admin/self-only.
-- =============================================================================

-- 1a. Door group draft-lock trigger with a narrow PM-remarks exemption.
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

  select status into v_status
  from public.project_versions
  where id = v_version_id;

  -- During ON DELETE CASCADE from project_versions/projects, the parent row is already gone.
  if tg_op = 'DELETE' and not found then
    return old;
  end if;

  -- PM remarks written through update_door_group_pm_remark() on a submitted version.
  if tg_op = 'UPDATE'
     and v_status = 'submitted'
     and coalesce(current_setting('app.pm_remark_update', true), '') = 'on'
     and (to_jsonb(new) - array['pm_remarks', 'updated_at'])
         = (to_jsonb(old) - array['pm_remarks', 'updated_at'])
  then
    return new;
  end if;

  if v_status is distinct from 'draft' then
    raise exception 'Cannot modify door groups: version status is "%" (must be draft)', v_status
      using errcode = '42501';
  end if;

  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

-- 1b. PM remarks RPC: same rules as migration 007, plus the trigger flag.
create or replace function public.update_door_group_pm_remark(
  p_group_id uuid,
  p_remarks text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status public.version_status;
begin
  if not public.has_role('pm') then
    raise exception 'Only PMs can update PM remarks'
      using errcode = '42501';
  end if;

  select pv.status into v_status
  from public.door_groups dg
  join public.project_versions pv on pv.id = dg.version_id
  where dg.id = p_group_id;

  if not found then
    raise exception 'Door group not found'
      using errcode = 'P0002';
  end if;

  if v_status is distinct from 'submitted' then
    raise exception 'PM remarks can only be edited when version status is "submitted" (current: "%")', v_status
      using errcode = '42501';
  end if;

  -- Transaction-local: cleared automatically when this call's transaction ends.
  perform set_config('app.pm_remark_update', 'on', true);

  update public.door_groups
  set pm_remarks = coalesce(p_remarks, ''),
      updated_at = now()
  where id = p_group_id;

  perform set_config('app.pm_remark_update', 'off', true);
end;
$$;

revoke all on function public.update_door_group_pm_remark(uuid, text) from public;
grant execute on function public.update_door_group_pm_remark(uuid, text) to authenticated;

-- 2. Directory of users (no email) for PM pickers and name display.
-- Runs with the view owner's rights so it is not limited by the profiles
-- "self or admin" policy; it only exposes non-sensitive columns.
create or replace view public.profile_directory
with (security_invoker = false)
as
  select id, full_name, role
  from public.profiles;

revoke all on public.profile_directory from public, anon;
grant select on public.profile_directory to authenticated;
