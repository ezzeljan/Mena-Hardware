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
 *
 * The PREPARATION / INSTALLATION cost columns always decide: an HW column
 * (Self Closing, Stop, Bolt) without a cost is only a note (an option for the
 * estimator), never a part. Electrical items aren't Mena's scope: they stay on
 * the door with no price and "BY OTHERS" (markByOthers). A comment that needs
 * confirmation flags the door for review (it's still counted).
 */
import type { ActivityKey, DoorActivities } from './doorActivities'
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
  /** The cost column that decides instead, when the quotation has it. */
  costKey?: ActivityKey
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
    // "RS" in the Electric Strike column, or the Reed Switch column under HW.
    wants: (d) =>
      /\bRS\b/i.test(strikeValue(d)) ||
      d.hardware.split(' · ').some((t) => t === 'Reed switch' || t.startsWith('Reed switch: ')),
    same: /reed\s*switch/i,
  },
  {
    // The Stop column under HW: "YES" (token "Stop") or a value ("Stop: WM").
    // The standard sets' floor stop, one per leaf.
    label: 'Door stop (Stop column)',
    part: { sku: 'MMDOORSTOP' },
    wants: (d) => d.hardware.split(' · ').some((t) => t === 'Stop' || t.startsWith('Stop: ')),
    perLeaf: true,
    costKey: 'stop',
    same: /door\s*stop/i,
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

/** HW columns that have a cost column: the cost decides, the HW column is an option. */
const HW_WITH_COST: Array<{ label: string; column: string; key: ActivityKey; cost: string }> = [
  { label: 'Closer', column: 'Self Closing', key: 'closer', cost: 'CLOSER' },
  { label: 'Stop', column: 'Stop', key: 'stop', cost: 'STOP' },
  { label: 'Bolt', column: 'Bolt', key: 'bolt', cost: 'BARREL BOLTS / AUTO FLUSH BOLTS' },
]

/** The HW column's value on a door ("YES" for a bare token), or ''. */
function hwValue(hardware: string, label: string): string {
  const t = hardware.split(' · ').find((x) => x === label || x.startsWith(`${label}: `))
  return t === undefined ? '' : t === label ? 'YES' : t.slice(label.length + 2)
}

/** A comment that needs someone to confirm the door ("NEED CONFIRMATION IF DOOR IS INCLUDED", "TBC"). */
export const NEEDS_CONFIRMATION =
  /\bneeds?\s+(to\s+)?confirm(ation|ed)?\b|\bto\s+be\s+confirmed\b|\bTBC\b|\bTBA\b|\bconfirm\s+(if|whether)\b|\bplease\s+confirm\b/i

/**
 * Electrical items: not Mena's scope (on the door with no price, BY OTHERS).
 * "NON-ELECTRIC" doesn't count.
 */
export const ELECTRICAL =
  /(?<!\bnon[\s-]?)\belectric(al)?\b|\belectro\s*-?\s*magnet|card\s*reader|reed\s*switch|ving\s*card|access\s*control|mag(netic)?\s*lock|exit\s*button|\bREX\b|intercom|door\s*contact|security\s*contractor|cable\s*transfer|power\s*transfer/i

/** The parts library folder for electrical items supplied by others. */
export const BY_OTHERS_FOLDER = /electronic|by\s+others/i

/**
 * Electrical lines (electric strike, card reader, reed switch, Vingcard…):
 * no price and "BY OTHERS" in the remarks. Returns the lines and a note per item.
 */
export function markByOthers<L extends SizingLine & { mhqt_remarks?: string }>(
  lines: L[],
  parts: SizingPart[] | PartIndex,
): { lines: L[]; notes: string[] } {
  const { byId, bySku } = toPartIndex(parts)
  const notes: string[] = []
  const out = lines.map((l) => {
    const part = (l.part_id ? byId.get(l.part_id) : undefined) ?? bySku.get(l.sku.trim().toUpperCase())
    const inFolder = BY_OTHERS_FOLDER.test(part?.folder ?? '')
    if (!inFolder && !ELECTRICAL.test(`${l.description} ${part?.description ?? ''}`)) return l
    notes.push(`${l.sku}: electrical — no price, BY OTHERS`)
    return { ...l, unit_price: 0, mhqt_remarks: l.mhqt_remarks?.trim() ? l.mhqt_remarks : 'BY OTHERS' }
  })
  return { lines: out, notes }
}

export interface FlagOptions {
  /** Cost columns the quotation has (they decide over the HW columns). */
  costColumns?: ActivityKey[]
  /** The group's priced activities. */
  activities?: DoorActivities
}

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
  options: FlagOptions = {},
): FlaggedLines<L> {
  const total = doors.reduce((s, d) => s + d.qty, 0)
  if (total === 0) return { lines, notes: [] }
  const costColumns = options.costColumns ?? []
  const activities = options.activities ?? {}
  const { byId: partById, bySku: partBySku, active } = toPartIndex(parts)
  const partOf = (l: SizingLine) =>
    (l.part_id ? partById.get(l.part_id) : undefined) ?? partBySku.get(l.sku.trim().toUpperCase())
  const legendOf = (l: SizingLine) => partOf(l)?.legend.trim().toUpperCase() ?? ''

  const out = [...lines]
  const notes: string[] = []

  // Comments that need confirmation: counted, but flagged for review.
  const unsure = [...new Set(doors.flatMap((d) =>
    d.comments.split(' | ').map((c) => c.trim()).filter((c) => NEEDS_CONFIRMATION.test(c)),
  ))]
  for (const c of unsure) notes.push(`Needs confirmation: "${c}" — counted, check with the builder`)

  // HW columns the cost columns don't price: an option, not a part.
  for (const hw of HW_WITH_COST) {
    if (!costColumns.includes(hw.key) || (activities[hw.key] ?? 0) > 0) continue
    const values = [...new Set(doors.map((d) => hwValue(d.hardware, hw.label)).filter(Boolean))]
    if (values.length === 0) continue
    notes.push(
      `${hw.column} column says ${values.map((v) => `"${v}"`).join(' / ')} but there's no ${hw.cost} cost — not added (option: add it by hand)`,
    )
  }

  for (const rule of FLAG_RULES) {
    // The cost column decides (activityRules.ts); the HW column is only a note above.
    if (rule.costKey && costColumns.includes(rule.costKey)) continue
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
