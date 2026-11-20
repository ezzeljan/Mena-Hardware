/**
 * Flag rules: items the door schedule asks for that a standard set doesn't
 * have, added to a new door group's lines (before sizing, so a kick plate is
 * then sized to the leaf):
 *
 *   - Electric Strike column "ES"    -> ES  electric strike by security contractor
 *                                        + CR card reader by security contractor
 *   - Electric Strike column "RS"    -> RS  reed switch by security contractor
 *   - Comment "card reader" / "CR"   -> CR
 *   - Comment "kick plate"           -> KP1 kick plate, one per leaf
 *   - Comment "Vingcard"             -> L25 Vingcard lock supplied by others
 *   - Comment "peep hole" / "viewer" -> PEEP door viewer
 *
 * An item is added only when every door in the group asks for it and the set
 * doesn't already have it; when only some do, a note says so instead.
 */
import type { SizingLine, SizingPart } from './doorSizing'

export interface FlagDoor {
  qty: number
  /** Hardware columns as the parser writes them ("Closer · Lock · ES: ES RS"). */
  hardware: string
  /** Door schedule and Mena comments. */
  comments: string
}

/** Items a door's comments ask for, by label (also part of the door's hardware). */
export const COMMENT_ITEMS: Array<[label: string, pattern: RegExp]> = [
  ['Card reader', /card\s*reader|\bCR\b/i],
  ['Kick plate', /kick\s*plate/i],
  ['Vingcard', /ving\s*card/i],
  ['Viewer', /peep\s*hole|door\s*viewer/i],
]

export function commentItems(comments: string): string[] {
  return COMMENT_ITEMS.filter(([, re]) => re.test(comments)).map(([label]) => label)
}

const commentAsks = (label: string, comments: string) =>
  COMMENT_ITEMS.some(([l, re]) => l === label && re.test(comments))

interface FlagRule {
  label: string
  /** The part to add, found in the parts library. */
  part: { legend?: string; sku?: string }
  wants: (door: FlagDoor) => boolean
  perLeaf?: boolean
  /** Legends that count as already having the item (any kick plate size). */
  family?: RegExp
}

/** The Electric Strike column's value ("ES RS", "RS"), or ''. */
function strikeValue(door: FlagDoor): string {
  const token = door.hardware.split(' · ').find((t) => t.startsWith('ES: '))
  return token ? token.slice(4) : ''
}

export const FLAG_RULES: FlagRule[] = [
  {
    label: 'Electric strike (ES column)',
    part: { legend: 'ES' },
    wants: (d) => /\bES\b/i.test(strikeValue(d)),
  },
  {
    label: 'Card reader',
    part: { legend: 'CR' },
    wants: (d) => /\bES\b/i.test(strikeValue(d)) || commentAsks('Card reader', d.comments),
  },
  {
    label: 'Reed switch (ES column)',
    part: { legend: 'RS' },
    wants: (d) => /\bRS\b/i.test(strikeValue(d)),
  },
  {
    label: 'Kick plate (comment)',
    part: { legend: 'KP1' },
    wants: (d) => commentAsks('Kick plate', d.comments),
    perLeaf: true,
    family: /^KP\d+$/,
  },
  {
    label: 'Vingcard by others (comment)',
    part: { legend: 'L25' },
    wants: (d) => commentAsks('Vingcard', d.comments),
  },
  {
    label: 'Door viewer (comment)',
    part: { sku: 'PEEP' },
    wants: (d) => commentAsks('Viewer', d.comments),
  },
]

export interface FlaggedLines<L> {
  lines: L[]
  notes: string[]
}

export function applyFlagRules<L extends SizingLine>(
  lines: L[],
  doors: FlagDoor[],
  leaves: number,
  parts: SizingPart[],
  makeLine: (part: SizingPart, qty: number) => L,
): FlaggedLines<L> {
  const total = doors.reduce((s, d) => s + d.qty, 0)
  if (total === 0) return { lines, notes: [] }
  const partById = new Map(parts.map((p) => [p.id, p]))
  const partBySku = new Map(parts.map((p) => [p.sku.trim().toUpperCase(), p]))
  const legendOf = (l: SizingLine) =>
    (
      (l.part_id ? partById.get(l.part_id) : undefined) ?? partBySku.get(l.sku.trim().toUpperCase())
    )?.legend
      .trim()
      .toUpperCase() ?? ''

  const out = [...lines]
  const notes: string[] = []
  for (const rule of FLAG_RULES) {
    const wanting = doors.filter(rule.wants).reduce((s, d) => s + d.qty, 0)
    if (wanting === 0) continue
    const part =
      parts.find(
        (p) =>
          p.active &&
          (rule.part.sku
            ? p.sku.trim().toUpperCase() === rule.part.sku
            : p.legend.trim().toUpperCase() === rule.part.legend),
      ) ?? null
    const name = rule.part.legend ?? rule.part.sku ?? ''
    const already = out.some(
      (l) =>
        (rule.part.legend && legendOf(l) === rule.part.legend) ||
        (rule.family && rule.family.test(legendOf(l))) ||
        (part &&
          (l.part_id === part.id || l.sku.trim().toUpperCase() === part.sku.trim().toUpperCase())),
    )
    if (already) continue
    if (wanting < total) {
      notes.push(
        `${rule.label} on ${wanting} of ${total} doors — not added; add it by hand if needed`,
      )
      continue
    }
    if (!part) {
      notes.push(`${rule.label}: no active ${name} part in the parts library — not added`)
      continue
    }
    const qty = rule.perLeaf ? Math.max(1, leaves) : 1
    out.push(makeLine(part, qty))
    notes.push(`${rule.label}: added ${name}${qty > 1 ? ` ×${qty}` : ''}`)
  }
  return { lines: out, notes }
}
