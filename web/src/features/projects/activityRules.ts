/**
 * Activity rules: the PREPARATION / INSTALLATION costs of a door group (see
 * doorActivities.ts) checked against the lines from its standard set.
 *
 *   - Priced but not in the set     -> the part is added (any door stop for
 *     now: floor mount; a slide-arm closer when the comments say slide arm /
 *     parallel, else the standard closer).
 *   - In the set, fewer than priced -> the quantity is raised.
 *   - In the set, not priced        -> the line is kept and flagged for the
 *     estimator (only when the quotation has that activity column at all).
 *
 * Runs before the flag rules and sizing, so an added kick plate, drop seal or
 * seal set is then sized to the door.
 */
import {
  ACTIVITY_COLUMN_NAME,
  ACTIVITY_LABEL,
  type ActivityKey,
  type DoorActivities,
} from './doorActivities'
import { toPartIndex, type PartIndex, type SizingLine, type SizingPart } from './doorSizing'

export interface ActivityLine extends SizingLine {
  /** Why the estimator should check this line ('' when nothing to check). */
  review_flag?: string
}

export interface ActivityDoor {
  activities: DoorActivities
  leaf: string | null
  comments: string
  leaves: number
}

interface ActivityRule {
  key: ActivityKey
  /** Is this set line that kind of part? (by legend, else by description) */
  is: (legend: string, description: string) => boolean
  /** The part to add when the set has none. */
  pick: (door: ActivityDoor, active: SizingPart[]) => SizingPart | undefined
  /** Not added on these doors (a cavity door's rebate kit is no meeting stile seal). */
  skip?: (door: ActivityDoor) => boolean
}

const byLegend = (active: SizingPart[], legend: string) =>
  active.find((p) => p.legend.trim().toUpperCase() === legend)
const byDescription = (active: SizingPart[], re: RegExp) => active.find((p) => re.test(p.description))
const isCavity = (d: ActivityDoor) => /CAVITY/i.test(d.leaf ?? '')

export const ACTIVITY_RULES: ActivityRule[] = [
  {
    key: 'stop',
    is: (l, d) => /^DS\d*B?$/.test(l) || /door\s*stop/i.test(d),
    // Wall or floor mount depends on the wall type / plans; any door stop for now.
    pick: (_door, a) =>
      byLegend(a, 'DS1') ??
      byDescription(a, /\b290\b.*door\s*stop\s*floor\s*mount/i) ??
      byDescription(a, /door\s*stop\s*floor\s*mount/i) ??
      byDescription(a, /door\s*stop/i),
  },
  {
    key: 'closer',
    is: (l, d) => /^C\d+B?$/.test(l) || /closer/i.test(d),
    pick: (door, a) =>
      /slide\s*arm|parallel/i.test(door.comments)
        ? (byLegend(a, 'C3') ?? byLegend(a, 'C4'))
        : (byLegend(a, 'C4') ?? byDescription(a, /closer/i)),
  },
  {
    key: 'kickplate',
    is: (l, d) => /^KP\d+$/.test(l) || /kick\s*plate/i.test(d),
    pick: (_door, a) => byLegend(a, 'KP1') ?? byDescription(a, /kick\s*plate/i),
  },
  {
    key: 'dropseal',
    is: (l, d) => /^(MB|FB)\d+$/.test(l) || /door\s*bottom\s*seal|drop\s*seal/i.test(d),
    pick: (_door, a) => byLegend(a, 'MB9') ?? byDescription(a, /door\s*bottom\s*seal/i),
  },
  {
    key: 'frameseal',
    is: (l, d) => /^BWL?[SD]$/.test(l) || /perimeter\s*seal/i.test(d),
    pick: (door, a) => byLegend(a, door.leaves > 1 ? 'BWD' : 'BWS') ?? byDescription(a, /perimeter\s*seal/i),
  },
  {
    key: 'meetingstile',
    is: (l, d) => /^MS\d+$/.test(l) || /meeting\s*(stile\s*)?seal/i.test(d),
    pick: (_door, a) => byDescription(a, /meeting\s*stile\s*seal/i),
    skip: isCavity,
  },
  {
    key: 'bolt',
    is: (l, d) => /^B\d+B?$/.test(l) || /flush\s*bolt|barrel\s*bolt/i.test(d),
    pick: (_door, a) => byLegend(a, 'B3') ?? byDescription(a, /flush\s*bolt/i),
  },
  {
    key: 'sequence',
    is: (l, d) => /^M1$/.test(l) || /sequence\s*selector/i.test(d),
    pick: (_door, a) => byLegend(a, 'M1') ?? byDescription(a, /sequence\s*selector/i),
  },
]

export interface ActivityResult<L> {
  lines: L[]
  notes: string[]
}

export function applyActivityRules<L extends ActivityLine>(
  lines: L[],
  door: ActivityDoor,
  /** Activity columns the quotation has; a missing activity is only flagged when its column is there. */
  columns: ActivityKey[],
  parts: SizingPart[] | PartIndex,
  makeLine: (part: SizingPart, qty: number) => L,
): ActivityResult<L> {
  if (columns.length === 0) return { lines, notes: [] }
  const { byId, bySku, active } = toPartIndex(parts)
  const partOf = (l: SizingLine) =>
    (l.part_id ? byId.get(l.part_id) : undefined) ?? bySku.get(l.sku.trim().toUpperCase())
  const kindOf = (l: SizingLine): ActivityRule | undefined => {
    const p = partOf(l)
    const legend = (p?.legend ?? '').trim().toUpperCase()
    const description = `${l.description} ${p?.description ?? ''}`
    return ACTIVITY_RULES.find((r) => r.is(legend, description))
  }

  // Parts the set doesn't have come from its main supplier when there's a
  // choice (a NOVAS meeting stile seal for a NOVAS set, not a Raven one).
  const supplierCount = new Map<string, number>()
  for (const l of lines) {
    const s = partOf(l)?.supplier_id
    if (s) supplierCount.set(s, (supplierCount.get(s) ?? 0) + 1)
  }
  const main = [...supplierCount].sort((a, b) => b[1] - a[1])[0]?.[0]
  const preferred = main
    ? [...active].sort((a, b) => Number(b.supplier_id === main) - Number(a.supplier_id === main))
    : active

  const notes: string[] = []
  const out = lines.map((l) => {
    const rule = kindOf(l)
    if (!rule || !columns.includes(rule.key)) return l
    const wanted = door.activities[rule.key] ?? 0
    if (wanted === 0) {
      const flag = `No ${ACTIVITY_COLUMN_NAME[rule.key]} cost in the quotation — check this part`
      notes.push(`${ACTIVITY_LABEL[rule.key]}: in the set but not priced — flagged`)
      return { ...l, review_flag: flag }
    }
    return l
  })

  for (const rule of ACTIVITY_RULES) {
    const wanted = door.activities[rule.key] ?? 0
    if (!wanted || rule.skip?.(door)) continue
    const existing = out.filter((l) => kindOf(l) === rule)
    if (existing.length > 0) {
      const have = existing.reduce((s, l) => s + Number(l.qty_per_door), 0)
      if (have < wanted) {
        const first = out.indexOf(existing[0])
        out[first] = { ...existing[0], qty_per_door: Number(existing[0].qty_per_door) + (wanted - have) }
        notes.push(`${ACTIVITY_LABEL[rule.key]} ${have} → ${wanted} (priced in the quotation)`)
      }
      continue
    }
    const part = rule.pick(door, preferred)
    if (!part) {
      notes.push(`${ACTIVITY_LABEL[rule.key]}: priced, but no matching part in the parts library — not added`)
      continue
    }
    out.push(makeLine(part, wanted))
    notes.push(`${ACTIVITY_LABEL[rule.key]}: added ${part.legend || part.sku}${wanted > 1 ? ` ×${wanted}` : ''} (priced in the quotation)`)
  }
  return { lines: out, notes }
}
