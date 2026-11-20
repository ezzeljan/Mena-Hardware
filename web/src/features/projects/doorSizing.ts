/**
 * Door sizing rules: a standard set is drawn up for a 2040 x 920 door, so when
 * its lines are copied onto a door group, size-dependent items are adjusted to
 * the group's actual door (taken from how suppliers price the Mena schedules):
 *
 *   - Hinges: fire-rated doors taller than 2100 mm get 4 hinges per leaf
 *     instead of 3 (only when the set has the standard 3 per leaf).
 *   - Perimeter seals: short set (BWS / BWD) up to 2100 mm high, long set
 *     (BWLS / BWLD) above.
 *   - Drop seals and kick plates (MB, FB, KP legends): the smallest size from
 *     the same supplier that covers the widest leaf (720 / 820 / 920 ...).
 *
 * Replacement parts come from the parts library (same supplier as the set's
 * part). When none fits, the line is kept and a note says why.
 */

export const TALL_DOOR_MM = 2100;
const HINGES_PER_LEAF_STANDARD = 3;
const HINGES_PER_LEAF_TALL_FIRE = 4;

/** Short / long perimeter seal pairs, by legend. */
const HEIGHT_PAIRS: Array<[short: string, long: string]> = [
  ['BWS', 'BWLS'],
  ['BWD', 'BWLD'],
];

/** Legend families sized by leaf width: letters + a number (MB9, FB6, KP1). */
const WIDTH_FAMILIES = ['MB', 'FB', 'KP'];

export interface SizingPart {
  id: string;
  sku: string;
  legend: string;
  description: string;
  supplier_id: string;
  unit_cost: number | null;
  active: boolean;
}

export interface SizingLine {
  sku: string;
  description: string;
  qty_per_door: number;
  unit_price: number | null;
  part_id: string | null;
}

export interface SizingDoor {
  classification: string | null;
  leaf: string | null;
  door_size: string | null;
}

export interface SizedLines<L extends SizingLine> {
  lines: L[];
  /** One short note per adjustment (or per adjustment that couldn't be made). */
  notes: string[];
}

/** "2340x920+920" -> { height: 2340, widths: [920, 920] }. */
export function parseDoorSize(size: string | null): { height: number; widths: number[] } | null {
  const m = /^\s*(\d+(?:\.\d+)?)\s*x\s*([\d.+\s]+)$/i.exec(size ?? '');
  if (!m) return null;
  const height = Number(m[1]);
  const widths = m[2]
    .split('+')
    .map((w) => Number(w.trim()))
    .filter((w) => Number.isFinite(w) && w > 0);
  if (!Number.isFinite(height) || height <= 0 || widths.length === 0) return null;
  return { height, widths };
}

/** A part's width in mm from its description: "300(H)X920(W)" or "920MM". */
export function partWidthMm(description: string): number | null {
  const w = /(\d{3,4})\s*\(\s*W\s*\)/i.exec(description) ?? /(\d{3,4})\s*MM\b/i.exec(description);
  return w ? Number(w[1]) : null;
}

const isHinge = (text: string) =>
  /\bHINGES?\b/i.test(text) && !/PIVOT|SOSS|CONCEALED|CONTINUOUS|PIANO/i.test(text);

function widthFamily(legend: string): string | null {
  const m = /^([A-Z]+)(\d+)$/i.exec(legend.trim());
  if (!m) return null;
  const prefix = m[1].toUpperCase();
  return WIDTH_FAMILIES.includes(prefix) ? prefix : null;
}

export function sizeSetLines<L extends SizingLine>(
  lines: L[],
  door: SizingDoor,
  parts: SizingPart[]
): SizedLines<L> {
  const size = parseDoorSize(door.door_size);
  if (!size || lines.length === 0) return { lines, notes: [] };

  const partById = new Map(parts.map((p) => [p.id, p]));
  const partBySku = new Map(parts.map((p) => [p.sku.trim().toUpperCase(), p]));
  const active = parts.filter((p) => p.active);
  const leaves = size.widths.length;
  const leafWidth = Math.max(...size.widths);
  const tall = size.height > TALL_DOOR_MM;
  const fireRated = door.classification === 'FIRE RATED';
  const notes: string[] = [];

  const swapTo = (line: L, part: SizingPart): L => ({
    ...line,
    sku: part.sku,
    description: part.description,
    part_id: part.id,
    unit_price: part.unit_cost,
  });

  const out = lines.map((line) => {
    const part = (line.part_id ? partById.get(line.part_id) : undefined) ?? partBySku.get(line.sku.trim().toUpperCase());
    const legend = (part?.legend ?? '').trim().toUpperCase();

    // Hinges: 4 per leaf on tall fire-rated doors.
    if (fireRated && tall && isHinge(`${line.description} ${part?.description ?? ''}`)) {
      const standard = HINGES_PER_LEAF_STANDARD * leaves;
      const target = HINGES_PER_LEAF_TALL_FIRE * leaves;
      if (Number(line.qty_per_door) === standard) {
        notes.push(`Hinges ${standard} → ${target} (fire rated, ${size.height} high)`);
        return { ...line, qty_per_door: target };
      }
      return line;
    }

    if (!part) return line;

    // Perimeter seals: short / long set by door height.
    const pair = HEIGHT_PAIRS.find(([s, l]) => s === legend || l === legend);
    if (pair) {
      const want = tall ? pair[1] : pair[0];
      if (want === legend) return line;
      const repl =
        active.find((p) => p.legend.trim().toUpperCase() === want && p.supplier_id === part.supplier_id) ??
        active.find((p) => p.legend.trim().toUpperCase() === want);
      if (!repl) {
        notes.push(`No ${want} seal in the parts library for a ${size.height} high door — kept ${legend}`);
        return line;
      }
      notes.push(`${legend} → ${want} (${size.height} high)`);
      return swapTo(line, repl);
    }

    // Drop seals and kick plates: smallest size covering the leaf width.
    const family = widthFamily(legend);
    if (family) {
      const options = active
        .filter((p) => p.supplier_id === part.supplier_id && widthFamily(p.legend) === family)
        .map((p) => ({ p, w: partWidthMm(p.description) }))
        .filter((o): o is { p: SizingPart; w: number } => o.w !== null)
        .sort((a, b) => a.w - b.w);
      const current = partWidthMm(part.description);
      if (options.length === 0 || current === null) return line;
      const fit = options.find((o) => o.w >= leafWidth);
      if (!fit) {
        const largest = options[options.length - 1];
        notes.push(
          `No ${family} part of ${leafWidth} mm or more from this supplier — ${
            largest.p.id === part.id ? `kept ${legend}` : `using ${largest.p.legend}`
          } (${largest.w} mm), check it`
        );
        return largest.p.id === part.id ? line : swapTo(line, largest.p);
      }
      if (fit.p.id === part.id || fit.w === current) return line;
      notes.push(`${legend} → ${fit.p.legend.trim().toUpperCase()} (${fit.w} mm for a ${leafWidth} leaf)`);
      return swapTo(line, fit.p);
    }

    return line;
  });

  return { lines: out, notes };
}
