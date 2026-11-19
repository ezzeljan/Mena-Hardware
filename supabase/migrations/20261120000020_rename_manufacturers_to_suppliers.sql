-- =============================================================================
-- Migration: 20261120000020_rename_manufacturers_to_suppliers.sql
-- Purpose: "Manufacturer" is now "Supplier".
--   public.manufacturers      -> public.suppliers
--   public.parts.manufacturer_id -> public.parts.supplier_id
--   A SKU stays unique across the library, so each part belongs to exactly
--   one supplier. Policies, triggers and the index are renamed to match;
--   their rules are unchanged (everyone signed in reads, admins write).
-- =============================================================================

do $$
begin
  if to_regclass('public.manufacturers') is not null and to_regclass('public.suppliers') is null then
    alter table public.manufacturers rename to suppliers;
  end if;

  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'parts' and column_name = 'manufacturer_id'
  ) then
    alter table public.parts rename column manufacturer_id to supplier_id;
  end if;

  if to_regclass('public.idx_parts_manufacturer_id') is not null then
    alter index public.idx_parts_manufacturer_id rename to idx_parts_supplier_id;
  end if;

  if exists (select 1 from pg_trigger where tgname = 'trg_manufacturers_updated_at') then
    alter trigger trg_manufacturers_updated_at on public.suppliers rename to trg_suppliers_updated_at;
  end if;

  if exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'suppliers'
             and policyname = 'manufacturers_select_authenticated') then
    alter policy "manufacturers_select_authenticated" on public.suppliers
      rename to "suppliers_select_authenticated";
  end if;

  if exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'suppliers'
             and policyname = 'manufacturers_write_admin_only') then
    alter policy "manufacturers_write_admin_only" on public.suppliers
      rename to "suppliers_write_admin_only";
  end if;
end $$;

-- Constraint names follow the table (cosmetic, keeps error messages readable).
do $$
declare
  r record;
begin
  for r in
    select conname, conrelid::regclass as tbl
    from pg_constraint
    where conrelid in ('public.suppliers'::regclass, 'public.parts'::regclass)
      and conname like '%manufacturer%'
  loop
    execute format('alter table %s rename constraint %I to %I',
      r.tbl, r.conname, replace(replace(r.conname, 'manufacturers', 'suppliers'), 'manufacturer', 'supplier'));
  end loop;
end $$;
