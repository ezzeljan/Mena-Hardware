/**
 * PREPARATION / INSTALLATION COST activities in the quotation: a cost in a
 * door's STOP, CLOSER, KICKPLATE ... column means that work is priced, so the
 * door needs that part. The value is a cost per item (a double door with
 * CLOSER 44 at 22 each has two closers), so the quantity is the value over the
 * column's usual single-item cost.
 *
 * Read by the parser (part of the door's hardware, so doors in a group need
 * the same parts) and used by activityRules.ts to add or flag lines.
 */

export type ActivityKey =
  | 'stop'
  | 'closer'
  | 'kickplate'
  | 'dropseal'
  | 'frameseal'
  | 'meetingstile'
  | 'bolt'
  | 'sequence'

/** Activity columns by normalised header (lower case, punctuation as spaces). */
export const ACTIVITY_COLUMNS: Record<string, ActivityKey> = {
  stop: 'stop',
  closer: 'closer',
  kickplate: 'kickplate',
  'kick plate': 'kickplate',
  'conc seal prep': 'dropseal',
  'drop seal inst': 'dropseal',
  'frame seal inst': 'frameseal',
  'meeting style rebate kit': 'meetingstile',
  'meeting stile rebate kit': 'meetingstile',
  'barrel bolts auto flush bolts': 'bolt',
  'sequence sel': 'sequence',
  'sequence selector': 'sequence',
}

export const ACTIVITY_LABEL: Record<ActivityKey, string> = {
  stop: 'Stop',
  closer: 'Closer',
  kickplate: 'Kick plate',
  dropseal: 'Drop seal',
  frameseal: 'Frame seal',
  meetingstile: 'Meeting stile seal',
  bolt: 'Flush bolt',
  sequence: 'Sequence selector',
}

/** The quotation column name, for notes ("No STOP priced ..."). */
export const ACTIVITY_COLUMN_NAME: Record<ActivityKey, string> = {
  stop: 'STOP',
  closer: 'CLOSER',
  kickplate: 'KICKPLATE',
  dropseal: 'CONC SEAL PREP / DROP SEAL INST',
  frameseal: 'FRAME SEAL INST',
  meetingstile: 'MEETING STYLE REBATE KIT',
  bolt: 'BARREL BOLTS / AUTO FLUSH BOLTS',
  sequence: 'SEQUENCE SEL',
}

/** Counted from the cost (value / single cost); the rest are one per door. */
const COUNTED: ActivityKey[] = ['stop', 'closer', 'kickplate', 'dropseal', 'bolt']
/** At most one per leaf. */
const PER_LEAF_MAX: ActivityKey[] = ['stop', 'closer', 'dropseal']

export type DoorActivities = Partial<Record<ActivityKey, number>>

/** The most common positive value (the single-item cost), preferring single-leaf doors. */
export function activityRates(
  doors: Array<{ raw: DoorActivities; leaves: number }>,
): Partial<Record<ActivityKey, number>> {
  const rates: Partial<Record<ActivityKey, number>> = {}
  const keys = new Set(doors.flatMap((d) => Object.keys(d.raw) as ActivityKey[]))
  for (const key of keys) {
    const mode = (list: number[]) => {
      const n = new Map<number, number>()
      for (const v of list) n.set(v, (n.get(v) ?? 0) + 1)
      return [...n].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]?.[0]
    }
    const values = (single: boolean) =>
      doors
        .filter((d) => !single || d.leaves === 1)
        .map((d) => d.raw[key])
        .filter((v): v is number => v !== undefined && v > 0)
    const rate = mode(values(true)) ?? mode(values(false))
    if (rate) rates[key] = rate
  }
  return rates
}

/** Quantities per door from the raw costs. */
export function activityQuantities(
  raw: DoorActivities,
  leaves: number,
  rates: Partial<Record<ActivityKey, number>>,
): DoorActivities {
  const out: DoorActivities = {}
  for (const [key, value] of Object.entries(raw) as Array<[ActivityKey, number]>) {
    if (!(value > 0)) continue
    let qty = 1
    const rate = rates[key]
    if (COUNTED.includes(key) && rate) qty = Math.max(1, Math.round(value / rate))
    if (PER_LEAF_MAX.includes(key)) qty = Math.min(qty, Math.max(1, leaves))
    out[key] = qty
  }
  return out
}

/** "Prep: Stop, Closer ×2, Drop seal ×2" ('' when none), in a fixed order. */
export function activitiesToken(activities: DoorActivities): string {
  const parts = (Object.keys(ACTIVITY_LABEL) as ActivityKey[])
    .filter((k) => activities[k])
    .map((k) => `${ACTIVITY_LABEL[k]}${(activities[k] ?? 0) > 1 ? ` ×${activities[k]}` : ''}`)
  return parts.length ? `Prep: ${parts.join(', ')}` : ''
}
