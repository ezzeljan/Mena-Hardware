/**
 * Merging door groups on the import's Matching Review step (before saving).
 *
 * A parsed group's hardware is the quotation's hardware columns, the items
 * its comments ask for, an extra hinge, and its prep / install activities.
 * Items every group has are kept; items only some have are offered to the
 * estimator. The merged group adds up the door qty and keeps the first
 * group's key, rating, leaf and size. It remembers the groups it was made
 * from, so it can be unmerged (each back with its own rooms, door qty and
 * rows, and the merged group's current hardware).
 */
import { ACTIVITY_LABEL, activitiesToken, type ActivityKey, type DoorActivities } from './doorActivities'
import { joinValues, type ParsedDoorGroupPreview } from './quotationParser'

export interface HardwareItem {
  /** Shown and compared as written, e.g. "Closer", "Grille: DG", "Prep: Stop ×2". */
  label: string
  activity?: { key: ActivityKey; qty: number }
  extraHinges?: number
}

const PREP = 'Prep: '

export function hardwareItems(g: Pick<ParsedDoorGroupPreview, 'hardware' | 'activities' | 'extra_hinges'>): HardwareItem[] {
  const items: HardwareItem[] = []
  for (const token of (g.hardware ?? '').split(' · ').map((t) => t.trim()).filter(Boolean)) {
    if (token.startsWith(PREP)) continue // from activities, one item each below
    const hinge = /^Extra hinge ×(\d+)$/.exec(token)
    items.push(hinge ? { label: token, extraHinges: Number(hinge[1]) } : { label: token })
  }
  for (const key of Object.keys(ACTIVITY_LABEL) as ActivityKey[]) {
    const qty = g.activities?.[key] ?? 0
    if (qty > 0) items.push({ label: `${PREP}${ACTIVITY_LABEL[key]}${qty > 1 ? ` ×${qty}` : ''}`, activity: { key, qty } })
  }
  return items
}

export interface UncommonHardware {
  label: string
  inRooms: string[]
  notInRooms: string[]
}

export interface DraftMergePlan {
  groups: ParsedDoorGroupPreview[]
  roomName: string
  doorQty: number
  specsDiffer: boolean
  uncommon: UncommonHardware[]
}

const roomsOf = (groups: ParsedDoorGroupPreview[]) => {
  const rooms = new Map<string, string>()
  for (const g of groups) {
    for (const part of g.room_name.split(' / ')) {
      const k = part.replace(/\s+/g, ' ').trim().toUpperCase()
      if (k && !rooms.has(k)) rooms.set(k, part.trim())
    }
  }
  return [...rooms.values()]
}

export function planDraftMerge(groups: ParsedDoorGroupPreview[]): DraftMergePlan {
  const ordered = [...groups].sort((a, b) => a.position - b.position)
  const labelsOf = ordered.map((g) => new Set(hardwareItems(g).map((i) => i.label)))
  const all: string[] = []
  for (const set of labelsOf) for (const l of set) if (!all.includes(l)) all.push(l)
  const uncommon = all
    .filter((l) => !labelsOf.every((set) => set.has(l)))
    .map((label) => ({
      label,
      inRooms: ordered.filter((_, i) => labelsOf[i].has(label)).map((g) => g.room_name),
      notInRooms: ordered.filter((_, i) => !labelsOf[i].has(label)).map((g) => g.room_name),
    }))
  const [first] = ordered
  return {
    groups: ordered,
    roomName: roomsOf(ordered).join(' / '),
    doorQty: ordered.reduce((s, g) => s + g.door_qty, 0),
    specsDiffer: ordered.some(
      (g) => g.classification !== first.classification || g.leaf !== first.leaf || g.door_size !== first.door_size,
    ),
    uncommon,
  }
}

/** The merged group: common hardware plus the chosen uncommon items. */
export function buildMergedGroup(
  plan: DraftMergePlan,
  roomName: string,
  include: Set<string>,
): ParsedDoorGroupPreview {
  const [first] = plan.groups
  const common = new Set(plan.groups.map((g) => hardwareItems(g).map((i) => i.label)).reduce((a, b) => a.filter((x) => b.includes(x))))
  const chosen = new Map<string, HardwareItem>()
  for (const g of plan.groups) {
    for (const item of hardwareItems(g)) {
      if ((common.has(item.label) || include.has(item.label)) && !chosen.has(item.label)) chosen.set(item.label, item)
    }
  }
  const items = [...chosen.values()]
  const activities: DoorActivities = {}
  for (const i of items) if (i.activity) activities[i.activity.key] = Math.max(activities[i.activity.key] ?? 0, i.activity.qty)
  const hinge = items.find((i) => i.extraHinges)
  const tags: string[] = []
  for (const g of plan.groups) {
    for (const t of g.door_tag.split(' / ').map((x) => x.trim()).filter(Boolean)) if (!tags.includes(t)) tags.push(t)
  }
  // Matched on the room of the group with the most doors.
  const biggest = [...plan.groups].sort((a, b) => b.door_qty - a.door_qty)[0]
  return {
    ...first,
    room_name: roomName,
    door_tag: tags.join(' / '),
    door_qty: plan.doorQty,
    source_rows: plan.groups.flatMap((g) => g.source_rows),
    match_room: biggest.match_room || biggest.room_name,
    hardware: [
      ...items.filter((i) => !i.activity).map((i) => i.label),
      activitiesToken(activities),
    ]
      .filter(Boolean)
      .join(' · '),
    activities,
    extra_hinges: hinge?.extraHinges ?? null,
    // Every group's prep / install cell values ("22/44" when they differ).
    prep_values: plan.groups.reduce<Record<string, string>>((acc, g) => joinValues(acc, g.prep_values ?? {}), {}),
  }
}

/** Unmerge: each group back with its own rooms, qty and rows, and the merged group's hardware. */
export function unmergeGroup(merged: ParsedDoorGroupPreview, parts: ParsedDoorGroupPreview[]): ParsedDoorGroupPreview[] {
  return parts.map((p) => ({
    ...p,
    classification: merged.classification,
    leaf: merged.leaf,
    door_size: merged.door_size,
    hardware: merged.hardware,
    activities: merged.activities,
    extra_hinges: merged.extra_hinges,
  }))
}
