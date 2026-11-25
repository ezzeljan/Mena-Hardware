/**
 * Hinge type from the Hinge column (door schedule, under HW):
 *
 *   - LO -> Lift Off hinge
 *   - BH -> Ball Bearing hinge
 *
 * There's no cost column for the hinge type, so the Hinge column decides: a
 * set hinge of another type is swapped for one of this type (the same number
 * of hinges), preferring the set's supplier and the same size (100X100 …).
 * Runs before sizing, so extra hinges then go on the swapped line.
 */
import { toPartIndex, type PartIndex, type SizingLine, type SizingPart } from './doorSizing'

export interface HingeType {
  code: string
  name: string
  /** Does a part's description say it's this type? */
  is: RegExp
}

export const HINGE_TYPES: HingeType[] = [
  { code: 'LO', name: 'Lift Off', is: /lift\s*-?\s*off|\bLOL\b/i },
  { code: 'BH', name: 'Ball Bearing', is: /ball\s*bearing|\b\d*\s*BB\b/i },
]

const isHinge = (text: string) =>
  /\bHINGES?\b/i.test(text) && !/PIVOT|SOSS|CONCEALED|CONTINUOUS|PIANO/i.test(text)

/** The Hinge column's type ("Hinge: LO"), or undefined. */
export function hingeTypeOf(hardware: string): HingeType | undefined {
  const token = hardware.split(' · ').find((t) => t.startsWith('Hinge: '))
  const value = token?.slice(7).trim().toUpperCase() ?? ''
  return HINGE_TYPES.find((h) => new RegExp(`\\b${h.code}\\b`).test(value))
}

const sizeOf = (text: string) => /\b(\d{2,3})\s*X\s*(\d{2,3})\b/i.exec(text)?.slice(1, 3).join('X') ?? ''

export function applyHingeType<L extends SizingLine>(
  lines: L[],
  hardware: string,
  parts: SizingPart[] | PartIndex,
  makeLine: (part: SizingPart, qty: number) => L,
): { lines: L[]; notes: string[] } {
  const type = hingeTypeOf(hardware)
  if (!type) return { lines, notes: [] }
  const { byId, bySku, active } = toPartIndex(parts)
  const partOf = (l: SizingLine) =>
    (l.part_id ? byId.get(l.part_id) : undefined) ?? bySku.get(l.sku.trim().toUpperCase())
  const textOf = (l: SizingLine) => `${l.description} ${partOf(l)?.description ?? ''}`

  const label = `Hinge: ${type.code} (${type.name})`
  const i = lines.findIndex((l) => isHinge(textOf(l)))
  if (i < 0) return { lines, notes: [`${label}: the set has no hinges — add them by hand`] }
  const line = lines[i]
  if (type.is.test(textOf(line))) return { lines, notes: [] }

  const current = partOf(line)
  const size = sizeOf(textOf(line))
  const candidates = active.filter((p) => isHinge(p.description) && type.is.test(p.description))
  const score = (p: SizingPart) =>
    Number(!!current && p.supplier_id === current.supplier_id) * 2 + Number(!!size && sizeOf(p.description) === size)
  const part = [...candidates].sort((a, b) => score(b) - score(a))[0]
  if (!part) return { lines, notes: [`${label}: no ${type.name} hinge in the parts library — not changed`] }

  const out = [...lines]
  // Still the set's hinge line (origin, place): only the part changes; the
  // set's price stays when the new part has none.
  const swapped = makeLine(part, Number(line.qty_per_door))
  out[i] = { ...line, ...swapped, ...('origin' in line ? { origin: (line as { origin?: unknown }).origin } : {}), unit_price: swapped.unit_price ?? line.unit_price }
  return { lines: out, notes: [`${label}: ${line.sku} → ${part.sku}`] }
}
