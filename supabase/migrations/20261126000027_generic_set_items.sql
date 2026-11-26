-- Migration: 20261126000027_generic_set_items.sql
-- Purpose: Standard sets list generic items again ("PASSAGE SET LEVER ROUND"),
--   as in DOOR HARDWARE SET_final.xlsx; a quotation import swaps each one for
--   the part best suited to the door from the quote's supplier.
--
--   generic_items        A generic hardware item: code, name and parts folder.
--                        Not a part (no supplier, no price).
--   generic_item_parts   The preferred part for a generic item, per supplier.
--   standard_set_lines.generic_id
--                        The generic item a set line stands for (null for a
--                        line that names a part, e.g. owner-supplied MMHINGE).
--
-- Data: the 46 generic parts the parts-library clean-up removed
-- (parts-folders-draft.xlsx, "Removed" sheet), each with the part it was
-- replaced by as that supplier's preferred part. Set lines the clean-up
-- changed to that part go back to the generic item (the 65 sets then match the
-- workbook line for line). Quote lines are not touched.

-- -----------------------------------------------------------------------------
-- 1. Generic items
-- -----------------------------------------------------------------------------
create table if not exists public.generic_items (
  id uuid primary key default gen_random_uuid(),
  code text not null,
  description text not null,
  folder_id uuid null references public.part_folders(id) on delete set null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint generic_items_code_length check (char_length(btrim(code)) between 1 and 60),
  constraint generic_items_description_length check (char_length(btrim(description)) between 1 and 300)
);

create unique index if not exists uq_generic_items_code on public.generic_items (upper(btrim(code)));

drop trigger if exists trg_generic_items_updated_at on public.generic_items;
create trigger trg_generic_items_updated_at
  before update on public.generic_items
  for each row execute function public.set_updated_at();

alter table public.generic_items enable row level security;
alter table public.generic_items force row level security;

drop policy if exists "generic_items_select_authenticated" on public.generic_items;
create policy "generic_items_select_authenticated"
  on public.generic_items for select to authenticated
  using (true);

drop policy if exists "generic_items_write_admin_only" on public.generic_items;
create policy "generic_items_write_admin_only"
  on public.generic_items for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

revoke all on public.generic_items from anon, authenticated;
grant select, insert, update, delete on public.generic_items to authenticated;

-- -----------------------------------------------------------------------------
-- 2. Preferred part per supplier
-- -----------------------------------------------------------------------------
create table if not exists public.generic_item_parts (
  generic_id uuid not null references public.generic_items(id) on delete cascade,
  supplier_id uuid not null references public.suppliers(id) on delete cascade,
  part_id uuid not null references public.parts(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (generic_id, supplier_id)
);

create index if not exists idx_generic_item_parts_part on public.generic_item_parts (part_id);

drop trigger if exists trg_generic_item_parts_updated_at on public.generic_item_parts;
create trigger trg_generic_item_parts_updated_at
  before update on public.generic_item_parts
  for each row execute function public.set_updated_at();

-- The part must belong to that supplier.
create or replace function public.generic_item_parts_check_supplier()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if not exists (select 1 from public.parts p where p.id = new.part_id and p.supplier_id = new.supplier_id) then
    raise exception 'The preferred part must be one of that supplier''s parts' using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_generic_item_parts_check_supplier on public.generic_item_parts;
create trigger trg_generic_item_parts_check_supplier
  before insert or update on public.generic_item_parts
  for each row execute function public.generic_item_parts_check_supplier();

alter table public.generic_item_parts enable row level security;
alter table public.generic_item_parts force row level security;

drop policy if exists "generic_item_parts_select_authenticated" on public.generic_item_parts;
create policy "generic_item_parts_select_authenticated"
  on public.generic_item_parts for select to authenticated
  using (true);

drop policy if exists "generic_item_parts_write_admin_only" on public.generic_item_parts;
create policy "generic_item_parts_write_admin_only"
  on public.generic_item_parts for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

revoke all on public.generic_item_parts from anon, authenticated;
grant select, insert, update, delete on public.generic_item_parts to authenticated;

-- -----------------------------------------------------------------------------
-- 3. Set lines: which generic item
-- -----------------------------------------------------------------------------
alter table public.standard_set_lines
  add column if not exists generic_id uuid null references public.generic_items(id) on delete set null;

create index if not exists idx_standard_set_lines_generic on public.standard_set_lines (generic_id);

-- -----------------------------------------------------------------------------
-- 4. Data
-- -----------------------------------------------------------------------------
-- code, name, folder, the part the clean-up replaced it with, and whether set
-- lines using that part go back to this item.
create temporary table tmp_generic (code text, description text, folder text, replaced_by text, revert boolean);
insert into tmp_generic (code, description, folder, replaced_by, revert) values
  ('PASSSETLEVR', 'PASSAGE SET LEVER ROUND', 'Lever furniture - round rose', 'B0163SSS', true),
  ('PERIMSEAL', 'PERIMETER SEAL', 'Seals', 'NHBWSSDS', true),
  ('N1ARESOVALCYL', 'N1A RESTRICTED OVAL CYLINDER', 'Cylinders & keys', '610N1ASCA', true),
  ('CYLESCUTCHEONR', 'CYLINDER ESCUTCHEON ROUND', 'Lever furniture - round rose', 'B08SSS', true),
  ('STDARMDC', 'STANDARD ARM DOOR CLOSER', 'Door closers', '1500BCSIL', true),
  ('MORTDBSEAL', 'MORTICE TYPE DOOR BOTTOM SEAL', 'Seals', 'NHMDBS920CA', true),
  ('STORERMLOCKBK', 'STOREROOM LOCK WITH BACKSET', 'Locks & latches', '6115SSS', true),
  ('FFDBSEAL', 'FACE FIXED DOOR BOTTOM SEAL', 'Seals', 'NHFFDBS920CA', true),
  ('SEQSELECT', 'SEQUENCE SELECTOR', 'Bolts & door coordinators', 'SB250SSSS', true),
  ('AUTOFLUSHB', 'AUTO FLUSH BOLT', 'Bolts & door coordinators', 'AF0149', true),
  ('BEVLLATSTRIKEP', 'BEVELLED LATCH STRIKE PLATE', 'Lock accessories (strikes & snibs)', 'SP8530-353SC', true),
  ('DOUBEVLLATFR', 'DOUBLE BEVELLED LATCH FIRE RATED', 'Locks & latches', '8530-305SC', true),
  ('SLIDEARMDC', 'SLIDE ARM DOOR CLOSER', 'Door closers', '1500VTRBSIL', true),
  ('RIMNLREVWOCYL', 'RIM NIGHT LATCH REVERSIBLE WITHOUT CYLINDER', 'Locks & latches', 'NL500SSS', true),
  ('PERIMSEALDD', 'PERIMETER SEAL DOUBLE DOOR', 'Seals', 'NHBWSDDS', true),
  ('FIXHALFSET63LR', 'FIXED HALF SET 63 LEVER ROUND B ROSE', 'Lever furniture - round rose', 'B02F63SSS', true),
  ('VISFIXBLANKR', 'VISIBLE FIX BLANK ROUND', 'Lever furniture - round rose', 'E05SSS', true),
  ('PASSLATCHBK', 'PASSAGE LATCH WITH BACKSET', 'Locks & latches', '6250SSS', true),
  ('ROLLERBOLT', 'ROLLER BOLT', 'Bolts & door coordinators', 'RB520SC', true),
  ('NECKBARRELBOLT', 'NECKED BARREL BOLT', 'Bolts & door coordinators', 'BB03.300SC.B', true),
  ('TUBPASSLATCH', 'TUBULAR PASSAGE LATCH', 'Locks & latches', '12905SSS', true),
  ('PROTUTILYRIMCYL', 'PROTEC UTILITY RIM/ROUND CYLINDER', 'Cylinders & keys', 'EMCY414NSC', true),
  ('VISFIXBLANKRE', 'N1A RESTRICTED ROUND CYLINDER SC', 'Cylinders & keys', '620N1ASC', true),
  ('DISTURNSNIBR', 'DISABLED TURNSNIB ROUND', 'Lever furniture - round rose', 'B06DSSS', true),
  ('STRIKESHIELD', 'STRIKE SHIELD TO SUIT NARROW STILE LOCK', 'Lock accessories (strikes & snibs)', 'NH097SSS', true),
  ('VESTLOCKBK', 'VESTIBULE LOCK WITH BACKSET', 'Locks & latches', '6125SSS', true),
  ('SLIDEARMDCDDA', 'SLIDE ARM DOOR CLOSER FOR DDA', 'Door closers', 'TS2000SNVBCSIL', true),
  ('BYOREEDSWITCH', 'REED SWITCH BY SECURITY CONTRACTOR', 'Electronic & security (by others)', 'REEDSWITCH', true),
  ('TURNSNIB', 'TURN SNIB', 'Lock accessories (strikes & snibs)', 'SP8530-57SC', true),
  ('KICKPLATE', 'KICK PLATE', 'Pulls, push & kick plates', 'KP1.2MM-CSK1', true),
  ('BARRELBOLT', 'BARREL BOLT', 'Bolts & door coordinators', 'BB01.300SC.B', true),
  ('CAVSLIDPRIVLOCK', 'CAVITY SLIDING ROUND PRIVACY LOCK', 'Cavity sliding', 'SL960SSS', true),
  ('N1AREOVCYLBTM', 'N1A RESTRICTED OVAL CYLINDER SC TO SUIT BOTTOM CYLINDER', 'Cylinders & keys', '610N1ASC/577', true),
  ('OVALCYLKEYFIRE', 'OVAL CYLINDER KEYED TO CL003 FIRE DEPARTMENT KEY', 'Cylinders & keys', '570003SC', true),
  ('BYOVINGCARDLOCK', 'VINGCARD RFID LOCK TO BE SUPPLIED BY OTHERS', 'Electronic & security (by others)', 'VINGCARD', true),
  ('COMVFIXRECPLNLEV', 'COMMERCIAL VISIBLE FIX RECTANGULAR PLATE PLAIN LEVER', 'Lever furniture - plate', 'R0650SSS', true),
  ('CONFIXRECTODH', 'CONCEALED FIX RECTANGULAR PLATE WITH OFFSET D HANDLE DUAL CYLINDER HOLE', 'Lever furniture - plate', 'R181353SSS', true),
  ('INDICEMERRELBR', 'INDICATING EMERGENCY RELEASE ROUND B ROSE', 'Lever furniture - round rose', 'B09ISSS', true),
  ('PRIVSET35LRBR', 'PRIVACY SET 35 LEVER ROUND B ROSE', 'Lever furniture - round rose', 'B0435SSS', true),
  ('TURNSNIBR', 'TURNSNIB ROUND', 'Lever furniture - round rose', 'B06SSS', true),
  ('PRIVLATCHBK', 'PRIVACY LATCH WITH BACKSET', 'Locks & latches', '6235SSS', true),
  ('MTGSTILESEAL', 'MEETING STILE SEAL', 'Seals', 'NHMSS2250SIL', true),
  ('DOORVIEWER', 'DOOR VIEWER', 'Viewers & grilles', 'PEEP', true),
  ('FLRSPRGNHODC', 'FLOOR SPRING NHO HO & DA COMPLETE', 'Door closers', null, false),
  ('BREAKGLASS', 'BREAK GLASS BY SECURITY CONTRACTOR', 'Electronic & security (by others)', null, false),
  ('STRAIGHTPULL', 'STRAIGHT PULL', 'Pulls, push & kick plates', null, false)
;

insert into public.generic_items (code, description, folder_id)
select t.code, t.description, f.id
from tmp_generic t
left join public.part_folders f on lower(btrim(f.name)) = lower(btrim(t.folder))
on conflict (upper(btrim(code))) do nothing;

-- The replacement becomes that supplier's preferred part.
insert into public.generic_item_parts (generic_id, supplier_id, part_id)
select g.id, p.supplier_id, p.id
from tmp_generic t
join public.generic_items g on upper(btrim(g.code)) = upper(btrim(t.code))
join public.parts p on upper(btrim(p.sku)) = upper(btrim(t.replaced_by))
where t.replaced_by is not null
on conflict (generic_id, supplier_id) do nothing;

-- Set lines back to the generic item (code, name and link).
update public.standard_set_lines l
set sku = g.code, description = g.description, generic_id = g.id
from tmp_generic t
join public.generic_items g on upper(btrim(g.code)) = upper(btrim(t.code))
where t.revert and upper(btrim(l.sku)) = upper(btrim(t.replaced_by));

-- Lines still named by a generic code (no replacement: floor spring, break glass, straight pull).
update public.standard_set_lines l
set generic_id = g.id
from public.generic_items g
where l.generic_id is null and upper(btrim(l.sku)) = upper(btrim(g.code));

drop table tmp_generic;

-- -----------------------------------------------------------------------------
-- 5. Swapping between supplier sheets: preferred parts first
-- -----------------------------------------------------------------------------
-- A part that is a generic item's preferred part for its supplier swaps to the
-- same item's preferred part for the other supplier. Otherwise as before: the
-- other supplier's only active part in the same folder.
create or replace function public.supplier_equivalent_part(
  p_part_id uuid,
  p_sku text,
  p_supplier_id uuid
)
returns uuid
language sql
stable
security invoker
set search_path = public
as $$
  with src as (
    select p.id, p.folder_id, p.supplier_id, s.is_owner_supplied
    from public.parts p
    join public.suppliers s on s.id = p.supplier_id
    where (p_part_id is not null and p.id = p_part_id)
       or (p_part_id is null and upper(btrim(p.sku)) = upper(btrim(coalesce(p_sku, ''))))
    limit 1
  ),
  preferred as (
    select tp.part_id
    from src
    join public.generic_item_parts sp on sp.part_id = src.id and sp.supplier_id = src.supplier_id
    join public.generic_item_parts tp on tp.generic_id = sp.generic_id and tp.supplier_id = p_supplier_id
    join public.parts t on t.id = tp.part_id and t.active
    where not src.is_owner_supplied and src.supplier_id <> p_supplier_id
    limit 1
  ),
  candidates as (
    select p.id
    from public.parts p, src
    where src.folder_id is not null
      and not src.is_owner_supplied
      and src.supplier_id <> p_supplier_id
      and p.folder_id = src.folder_id
      and p.supplier_id = p_supplier_id
      and p.active
  )
  select coalesce(
    (select part_id from preferred),
    case when (select count(*) from candidates) = 1 then (select id from candidates) end
  );
$$;
