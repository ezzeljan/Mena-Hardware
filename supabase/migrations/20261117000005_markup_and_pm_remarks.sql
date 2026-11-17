-- Persist version markup percentage (default 15.00%) and per-group PM remarks in Supabase.

alter table public.project_versions
  add column if not exists markup_pct numeric(6, 2) not null default 15.00
  check (markup_pct >= 0);

alter table public.door_groups
  add column if not exists pm_remarks text not null default '';
