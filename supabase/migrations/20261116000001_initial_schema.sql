-- =============================================================================
-- Migration: 20261116000001_initial_schema.sql
-- Purpose: Core schema for Mena Hardware (profiles, manufacturers, parts,
--          part_price_history, standard_sets, standard_set_lines), triggers,
--          indexes, and Row Level Security policies.
-- =============================================================================

-- 1. Role Enum
do $$
begin
  if not exists (select 1 from pg_type where typname = 'user_role') then
    create type public.user_role as enum ('admin', 'estimator', 'pm', 'viewer');
  end if;
end $$;

-- 2. Profiles (references auth.users)
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null default '',
  role public.user_role not null default 'viewer',
  created_at timestamptz not null default now()
);

-- 3. Manufacturers
create table if not exists public.manufacturers (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  is_owner_supplied boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 4. Parts
-- Note: unit_cost is nullable intentionally; null means "no unit price".
create table if not exists public.parts (
  id uuid primary key default gen_random_uuid(),
  sku text not null unique,
  manufacturer_id uuid not null references public.manufacturers(id) on delete restrict,
  description text not null,
  unit_cost numeric(12, 3) null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 5. Part Price History
-- Written automatically by trigger on every unit_cost UPDATE on parts.
create table if not exists public.part_price_history (
  id uuid primary key default gen_random_uuid(),
  part_id uuid not null references public.parts(id) on delete cascade,
  unit_cost numeric(12, 3) null,
  effective_from timestamptz not null default now(),
  changed_by uuid null references public.profiles(id) on delete set null
);

-- 6. Standard Sets
create table if not exists public.standard_sets (
  id uuid primary key default gen_random_uuid(),
  room_name text not null,
  classification text not null default '',
  leaf text not null default '' check (leaf in ('SINGLE', 'DOUBLE', 'CAVITY SINGLE', '')),
  door_size text not null default '',
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 7. Standard Set Lines
-- Note: unit_price is nullable intentionally; null means blank on purpose, never default to 0.
create table if not exists public.standard_set_lines (
  id uuid primary key default gen_random_uuid(),
  set_id uuid not null references public.standard_sets(id) on delete cascade,
  position integer not null check (position >= 0),
  sku text not null,
  description text not null,
  qty numeric(12, 3) not null check (qty >= 0),
  unit_price numeric(12, 3) null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (set_id, position) deferrable initially deferred
);

-- =============================================================================
-- Indexes
-- =============================================================================
create index if not exists idx_parts_manufacturer_id on public.parts(manufacturer_id);
create index if not exists idx_parts_active on public.parts(active);
create index if not exists idx_parts_sku_trgm on public.parts(sku);
create index if not exists idx_part_price_history_part_id on public.part_price_history(part_id, effective_from desc);
create index if not exists idx_standard_sets_filters on public.standard_sets(classification, leaf, active);
create index if not exists idx_standard_set_lines_set_id on public.standard_set_lines(set_id, position);

-- =============================================================================
-- Triggers: updated_at
-- =============================================================================
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_manufacturers_updated_at on public.manufacturers;
create trigger trg_manufacturers_updated_at
  before update on public.manufacturers
  for each row execute function public.set_updated_at();

drop trigger if exists trg_parts_updated_at on public.parts;
create trigger trg_parts_updated_at
  before update on public.parts
  for each row execute function public.set_updated_at();

drop trigger if exists trg_standard_sets_updated_at on public.standard_sets;
create trigger trg_standard_sets_updated_at
  before update on public.standard_sets
  for each row execute function public.set_updated_at();

drop trigger if exists trg_standard_set_lines_updated_at on public.standard_set_lines;
create trigger trg_standard_set_lines_updated_at
  before update on public.standard_set_lines
  for each row execute function public.set_updated_at();

-- =============================================================================
-- Trigger: Automatic profile creation on auth.users sign-up (defaults to viewer)
-- =============================================================================
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, full_name, role)
  values (
    new.id,
    coalesce(new.raw_user_meta_data ->> 'full_name', split_part(coalesce(new.email, ''), '@', 1)),
    'viewer'
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- =============================================================================
-- Trigger: Write a row to part_price_history on every unit_cost UPDATE
-- =============================================================================
create or replace function public.log_part_price_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.unit_cost is distinct from new.unit_cost then
    insert into public.part_price_history (part_id, unit_cost, effective_from, changed_by)
    values (new.id, new.unit_cost, now(), auth.uid());
  end if;
  return new;
end;
$$;

drop trigger if exists trg_part_price_history on public.parts;
create trigger trg_part_price_history
  after update on public.parts
  for each row execute function public.log_part_price_change();

-- =============================================================================
-- Row Level Security (RLS)
-- =============================================================================
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.profiles
    where id = auth.uid()
      and role = 'admin'
  );
$$;

alter table public.profiles enable row level security;
alter table public.manufacturers enable row level security;
alter table public.parts enable row level security;
alter table public.part_price_history enable row level security;
alter table public.standard_sets enable row level security;
alter table public.standard_set_lines enable row level security;

-- Force RLS even for table owners unless bypassed by superuser/postgres
alter table public.profiles force row level security;
alter table public.manufacturers force row level security;
alter table public.parts force row level security;
alter table public.part_price_history force row level security;
alter table public.standard_sets force row level security;
alter table public.standard_set_lines force row level security;

-- 1. Profiles policies
drop policy if exists "profiles_select_self_or_admin" on public.profiles;
create policy "profiles_select_self_or_admin"
  on public.profiles for select
  to authenticated
  using (id = auth.uid() or public.is_admin());

drop policy if exists "profiles_update_admin_only" on public.profiles;
create policy "profiles_update_admin_only"
  on public.profiles for update
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

drop policy if exists "profiles_insert_admin_only" on public.profiles;
create policy "profiles_insert_admin_only"
  on public.profiles for insert
  to authenticated
  with check (public.is_admin());

drop policy if exists "profiles_delete_admin_only" on public.profiles;
create policy "profiles_delete_admin_only"
  on public.profiles for delete
  to authenticated
  using (public.is_admin());

-- 2. Manufacturers policies
drop policy if exists "manufacturers_select_authenticated" on public.manufacturers;
create policy "manufacturers_select_authenticated"
  on public.manufacturers for select
  to authenticated
  using (true);

drop policy if exists "manufacturers_write_admin_only" on public.manufacturers;
create policy "manufacturers_write_admin_only"
  on public.manufacturers for all
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- 3. Parts policies
drop policy if exists "parts_select_authenticated" on public.parts;
create policy "parts_select_authenticated"
  on public.parts for select
  to authenticated
  using (true);

drop policy if exists "parts_write_admin_only" on public.parts;
create policy "parts_write_admin_only"
  on public.parts for all
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- 4. Part Price History policies
drop policy if exists "part_price_history_select_authenticated" on public.part_price_history;
create policy "part_price_history_select_authenticated"
  on public.part_price_history for select
  to authenticated
  using (true);

drop policy if exists "part_price_history_write_admin_only" on public.part_price_history;
create policy "part_price_history_write_admin_only"
  on public.part_price_history for all
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- 5. Standard Sets policies
drop policy if exists "standard_sets_select_authenticated" on public.standard_sets;
create policy "standard_sets_select_authenticated"
  on public.standard_sets for select
  to authenticated
  using (true);

drop policy if exists "standard_sets_write_admin_only" on public.standard_sets;
create policy "standard_sets_write_admin_only"
  on public.standard_sets for all
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- 6. Standard Set Lines policies
drop policy if exists "standard_set_lines_select_authenticated" on public.standard_set_lines;
create policy "standard_set_lines_select_authenticated"
  on public.standard_set_lines for select
  to authenticated
  using (true);

drop policy if exists "standard_set_lines_write_admin_only" on public.standard_set_lines;
create policy "standard_set_lines_write_admin_only"
  on public.standard_set_lines for all
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());
