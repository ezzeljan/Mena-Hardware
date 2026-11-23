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
 * A comment that rules the item out ("No kick plate", "kick plate by builder",
 * "card reader not required") does not count. An item is added only when
 * every door in the group asks for it and the set doesn't already have it
 * (by legend or by what the line says it is); when only some doors ask, a note
 * says so instead.
 */
import { toPartIndex, type PartIndex, type SizingLine, type SizingPart } from './doorSizing'

export interface FlagDoor {
  qty: number
  /** Hardware columns as the parser writes them ("Closer · Lock · ES: ES RS"). */
  hardware: string
  /** Door schedule and Mena comments. */
  comments: string
}

/** Words that rule an item out when they're in the same part of the comment. */
const RULED_OUT = /\b(no|not\s+(required|needed|included)|without|excl(uded|\.)?|omit(ted)?|deleted?|n\/a)\b/i
/** "... by builder / by others": not ours (for items Mena would otherwise supply). */
const SUPPLIED_ELSEWHERE = /\bby\s+(the\s+)?(builder|others?|client)\b/i

interface CommentItem {
  label: string
  pattern: RegExp
  /**
   * True when "by others" means the item isn't wanted at all (a kick plate by
   * the builder). False when the line we add is itself "by others" (a card
   * reader by the security contractor, a Vingcard lock by others).
   */
  byOthersRulesOut: boolean
}

const ITEMS: CommentItem[] = [
  { label: 'Card reader', pattern: /card\s*reader|\bCR\b/i, byOthersRulesOut: false },
  { label: 'Kick plate', pattern: /kick\s*plate/i, byOthersRulesOut: true },
  { label: 'Vingcard', pattern: /ving\s*card/i, byOthersRulesOut: false },
  { label: 'Viewer', pattern: /peep\s*hole|door\s*viewer/i, byOthersRulesOut: true },
]

/** Items a door's comments ask for, by label (also part of the door's hardware). */
export const COMMENT_ITEMS: Array<[label: string, pattern: RegExp]> = ITEMS.map((i) => [
  i.label,
  i.pattern,
])

/** True when some part of the comments mentions the item without ruling it out. */
function asks(item: CommentItem, comments: string): boolean {
  return comments
    .split(/[.;|,\n]+/)
    .some(
      (part) =>
        item.pattern.test(part) &&
        !RULED_OUT.test(part) &&
        !(item.byOthersRulesOut && SUPPLIED_ELSEWHERE.test(part)),
    )
}

export function commentItems(comments: string): string[] {
  return ITEMS.filter((i) => asks(i, comments)).map((i) => i.label)
}

const commentAsks = (label: string, comments: string) =>
  ITEMS.some((i) => i.label === label && asks(i, comments))

interface FlagRule {
  label: string
  /** The part to add, found in the parts library. */
  part: { legend?: string; sku?: string }
  wants: (door: FlagDoor) => boolean
  perLeaf?: boolean
  /** Legends that count as already having the item (any kick plate size). */
  family?: RegExp
  /** A line whose description says this is the same item (parts without a legend). */
  same: RegExp
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
    same: /electric\s*strike/i,
  },
  {
    label: 'Card reader',
    part: { legend: 'CR' },
    wants: (d) => /\bES\b/i.test(strikeValue(d)) || commentAsks('Card reader', d.comments),
    same: /card\s*reader/i,
  },
  {
    label: 'Reed switch (ES column)',
    part: { legend: 'RS' },
    wants: (d) => /\bRS\b/i.test(strikeValue(d)),
    same: /reed\s*switch/i,
  },
  {
    label: 'Kick plate (comment)',
    part: { legend: 'KP1' },
    wants: (d) => commentAsks('Kick plate', d.comments),
    perLeaf: true,
    family: /^KP\d+$/,
    same: /kick\s*plate/i,
  },
  {
    label: 'Vingcard by others (comment)',
    part: { legend: 'L25' },
    wants: (d) => commentAsks('Vingcard', d.comments),
    same: /ving\s*card/i,
  },
  {
    label: 'Door viewer (comment)',
    part: { sku: 'PEEP' },
    wants: (d) => commentAsks('Viewer', d.comments),
    same: /door\s*viewer|peep\s*hole/i,
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
  parts: SizingPart[] | PartIndex,
  makeLine: (part: SizingPart, qty: number) => L,
): FlaggedLines<L> {
  const total = doors.reduce((s, d) => s + d.qty, 0)
  if (total === 0) return { lines, notes: [] }
  const { byId: partById, bySku: partBySku, active } = toPartIndex(parts)
  const partOf = (l: SizingLine) =>
    (l.part_id ? partById.get(l.part_id) : undefined) ?? partBySku.get(l.sku.trim().toUpperCase())
  const legendOf = (l: SizingLine) => partOf(l)?.legend.trim().toUpperCase() ?? ''

  const out = [...lines]
  const notes: string[] = []
  for (const rule of FLAG_RULES) {
    const wanting = doors.filter(rule.wants).reduce((s, d) => s + d.qty, 0)
    if (wanting === 0) continue
    const part =
      active.find((p) =>
        rule.part.sku
          ? p.sku.trim().toUpperCase() === rule.part.sku
          : p.legend.trim().toUpperCase() === rule.part.legend,
      ) ?? null
    const name = rule.part.legend ?? rule.part.sku ?? ''
    const already = out.some(
      (l) =>
        (rule.part.legend && legendOf(l) === rule.part.legend) ||
        (rule.family && rule.family.test(legendOf(l))) ||
        rule.same.test(l.description) ||
        rule.same.test(partOf(l)?.description ?? '') ||
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
