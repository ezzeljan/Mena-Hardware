-- =============================================================================
-- Migration: 20261117000002_harden_rls_and_history.sql
-- Purpose:
--   1. Make part_price_history strictly read-only for all users (including admins);
--      only the security-definer trigger trg_part_price_history writes to it.
--   2. Prevent admins from changing their own role via RLS.
--   3. Add email column to profiles + backfill from auth.users for Users UI.
--   4. Add seed_key columns so seed --prune never touches admin-created rows.
--   5. Add atomic swap_standard_set_lines RPC for reordering lines safely.
--   6. Drop redundant idx_parts_sku_trgm index (parts.sku already has a unique index).
-- =============================================================================

-- 1. Remove admin write access from part_price_history (audit log is trigger-only)
drop policy if exists "part_price_history_write_admin_only" on public.part_price_history;

-- 2. Prevent an admin from updating their own profile/role
drop policy if exists "profiles_update_admin_only" on public.profiles;
create policy "profiles_update_admin_only"
  on public.profiles for update
  to authenticated
  using (public.is_admin() and id <> (select auth.uid()))
  with check (public.is_admin() and id <> (select auth.uid()));

-- 3. Add email to profiles and sync in handle_new_user()
alter table public.profiles
  add column if not exists email text not null default '';

update public.profiles p
set email = coalesce(u.email, '')
from auth.users u
where p.id = u.id
  and p.email = '';

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, full_name, email, role)
  values (
    new.id,
    coalesce(new.raw_user_meta_data ->> 'full_name', split_part(coalesce(new.email, ''), '@', 1)),
    coalesce(new.email, ''),
    'viewer'
  )
  on conflict (id) do update
    set email = excluded.email;
  return new;
end;
$$;

-- 4. Track seed-originated rows with seed_key (NULL = created via UI)
alter table public.parts
  add column if not exists seed_key text null unique;

alter table public.standard_sets
  add column if not exists seed_key text null unique;

alter table public.standard_set_lines
  add column if not exists seed_key text null unique;

-- 5. Atomic line reordering RPC (uses deferrable unique constraint on set_id, position)
create or replace function public.swap_standard_set_lines(p_line_a uuid, p_line_b uuid)
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_pos_a integer;
  v_pos_b integer;
  v_set_a uuid;
  v_set_b uuid;
begin
  if not public.is_admin() then
    raise exception 'Only administrators can reorder standard set lines'
      using errcode = '42501';
  end if;

  select set_id, position into v_set_a, v_pos_a
  from public.standard_set_lines
  where id = p_line_a
  for update;

  select set_id, position into v_set_b, v_pos_b
  from public.standard_set_lines
  where id = p_line_b
  for update;

  if v_set_a is null or v_set_b is null or v_set_a <> v_set_b then
    raise exception 'Both lines must exist in the same standard set';
  end if;

  update public.standard_set_lines set position = v_pos_b where id = p_line_a;
  update public.standard_set_lines set position = v_pos_a where id = p_line_b;
end;
$$;

-- 6. Drop redundant index (parts.sku already has unique constraint index)
drop index if exists public.idx_parts_sku_trgm;
