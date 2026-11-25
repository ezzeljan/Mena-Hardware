/**
 * Merging door groups in the hardware grid (merge_door_groups, migration 026).
 *
 * The first group (by position) is kept; the others' doors are added to it.
 * Hardware is compared per supplier sheet, line by line (SKU and qty per
 * door): a line every group has is kept once; a line only some groups have is
 * offered to the estimator, who decides whether the merged group gets it.
 */
import type { DoorGroup, ProjectLine } from '@/types/database'

export interface UncommonLine {
  /** sheet + SKU + qty: the same hardware in several groups is one choice. */
  key: string
  sheetId: string
  sku: string
  description: string
  qtyPerDoor: number
  /** Rooms of the groups that have it / don't. */
  inRooms: string[]
  notInRooms: string[]
}

export interface MergePlan {
  target: DoorGroup
  others: DoorGroup[]
  /** The rooms joined, as the merged group's name. */
  roomName: string
  doorQty: number
  /** Lines only some of the groups have (the estimator chooses). */
  uncommon: UncommonLine[]
  /** Rating / leaf / size differ: the merged group keeps the first group's. */
  specsDiffer: boolean
  /** Choice keys → line ids: the target's own line to keep, else one to copy. */
  resolve: (include: Set<string>) => { keep: string[]; copy: string[] }
}

const lineKey = (l: ProjectLine) =>
  `${l.sheet_id}|${l.sku.trim().toUpperCase()}|${Number(l.qty_per_door)}`

export function planMerge(groups: DoorGroup[], lines: ProjectLine[]): MergePlan {
  const ordered = [...groups].sort((a, b) => a.position - b.position)
  const [target, ...others] = ordered
  const roomOf = (g: DoorGroup) => g.room_name.trim()

  // Rooms as first written, once each (capitals and spacing ignored).
  const rooms = new Map<string, string>()
  for (const g of ordered) {
    for (const part of roomOf(g).split(' / ')) {
      const k = part.replace(/\s+/g, ' ').trim().toUpperCase()
      if (k && !rooms.has(k)) rooms.set(k, part.trim())
    }
  }

  // Which groups have each line (sheet + SKU + qty), and the line in each.
  const byKey = new Map<string, Map<string, ProjectLine>>()
  const first = new Map<string, ProjectLine>()
  for (const g of ordered) {
    for (const l of lines.filter((x) => x.group_id === g.id)) {
      const k = lineKey(l)
      const holders = byKey.get(k) ?? new Map<string, ProjectLine>()
      if (!holders.has(g.id)) holders.set(g.id, l)
      byKey.set(k, holders)
      if (!first.has(k)) first.set(k, l)
    }
  }

  const uncommon: UncommonLine[] = []
  const common = new Set<string>()
  for (const [k, holders] of byKey) {
    if (holders.size === ordered.length) {
      common.add(k)
      continue
    }
    const l = first.get(k)!
    uncommon.push({
      key: k,
      sheetId: l.sheet_id,
      sku: l.sku,
      description: l.description,
      qtyPerDoor: Number(l.qty_per_door),
      inRooms: ordered.filter((g) => holders.has(g.id)).map(roomOf),
      notInRooms: ordered.filter((g) => !holders.has(g.id)).map(roomOf),
    })
  }

  const specsDiffer = others.some(
    (g) => g.classification !== target.classification || g.leaf !== target.leaf || g.door_size !== target.door_size,
  )

  const resolve = (include: Set<string>) => {
    const keep: string[] = []
    const copy: string[] = []
    // The target's own lines: kept when common or chosen (each extra line of
    // the same hardware in the target is kept too).
    for (const l of lines.filter((x) => x.group_id === target.id)) {
      const k = lineKey(l)
      if (common.has(k) || include.has(k)) keep.push(l.id)
    }
    // Chosen hardware the target doesn't have: one copy, from the first group with it.
    for (const u of uncommon) {
      if (!include.has(u.key)) continue
      const holders = byKey.get(u.key)!
      if (holders.has(target.id)) continue
      const from = others.find((g) => holders.has(g.id))
      if (from) copy.push(holders.get(from.id)!.id)
    }
    return { keep, copy }
  }

  return {
    target,
    others,
    roomName: [...rooms.values()].join(' / '),
    doorQty: ordered.reduce((s, g) => s + Number(g.door_qty), 0),
    uncommon,
    specsDiffer,
    resolve,
  }
}
