-- Store Door Tag (from quotation Door Type column, e.g. DR-022, D63) on door_groups.

alter table public.door_groups
  add column if not exists door_tag text not null default '';
