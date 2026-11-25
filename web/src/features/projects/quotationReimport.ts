import type { DoorGroup } from '@/types/database'
import type { ParsedDoorGroupPreview } from '@/features/projects/quotationParser'
import { makeGroupFinder } from '@/features/projects/groupKey'

/**
 * Re-importing an updated quotation: door groups are matched to the current
 * version by group_key (see groupKey.ts). A group whose key is unchanged keeps
 * its set, every supplier sheet keeps its lines (edits, prices), and the PM
 * remarks stay; only its door quantity is taken from the new file.
 *
 * Groups saved earlier (room in the key, or no hardware in it) are found by
 * door type, rating, leaf and size. When several of them are now one typical
 * door (`merged`), the new group keeps the lines of the one with the most
 * doors; when one of them is now several groups by hardware (`split`), each
 * keeps its lines. Both are listed so they can be checked.
 */

export interface QuotationChanges {
  added: ParsedDoorGroupPreview[]
  removed: DoorGroup[]
  qtyChanged: Array<{ group: ParsedDoorGroupPreview; oldQty: number; newQty: number }>
  unchangedCount: number
  /** Earlier groups whose doors are now in several groups (split by hardware). */
  split: Array<{ base: DoorGroup; groups: ParsedDoorGroupPreview[] }>
  /** New groups that take the doors of several earlier groups (rooms merged). */
  merged: Array<{ group: ParsedDoorGroupPreview; bases: DoorGroup[] }>
}

export function diffQuotationGroups(
  baseGroups: DoorGroup[],
  nextGroups: ParsedDoorGroupPreview[],
): QuotationChanges {
  const findBase = makeGroupFinder(baseGroups)
  const matched = new Map<string, ParsedDoorGroupPreview[]>()

  const added: ParsedDoorGroupPreview[] = []
  const qtyChanged: QuotationChanges['qtyChanged'] = []
  const merged: QuotationChanges['merged'] = []
  let unchangedCount = 0

  for (const g of nextGroups) {
    const bases = findBase.findAll(g.group_key)
    for (const b of bases) matched.set(b.id, [...(matched.get(b.id) ?? []), g])
    if (bases.length === 0) {
      added.push(g)
      continue
    }
    if (bases.length > 1) merged.push({ group: g, bases })
    const oldQty = bases.reduce((sum, b) => sum + Number(b.door_qty), 0)
    if (oldQty !== Number(g.door_qty)) {
      qtyChanged.push({ group: g, oldQty, newQty: Number(g.door_qty) })
    } else {
      unchangedCount++
    }
  }

  const removed = baseGroups.filter((g) => !matched.has(g.id))
  const split = baseGroups
    .filter((g) => (matched.get(g.id)?.length ?? 0) > 1)
    .map((base) => ({ base, groups: matched.get(base.id) ?? [] }))
  return { added, removed, qtyChanged, unchangedCount, split, merged }
}

/** The custom door-group name stored in match_reason ("Custom: <name>"), if any. */
export function customNameFromReason(reason: string | null | undefined): string {
  const m = /^Custom:\s*(.+)$/.exec(reason ?? '')
  return m ? m[1].trim() : ''
}
