import type { DoorGroup } from '@/types/database'
import type { ParsedDoorGroupPreview } from '@/features/projects/quotationParser'

/**
 * Re-importing an updated quotation: door groups are matched to the current
 * version by group_key (room | classification | leaf | size). A group whose key
 * is unchanged keeps its set, every supplier sheet keeps its lines (edits,
 * prices), and the PM remarks stay; only its door quantity is taken from the new file.
 */

export interface QuotationChanges {
  added: ParsedDoorGroupPreview[]
  removed: DoorGroup[]
  qtyChanged: Array<{ group: ParsedDoorGroupPreview; oldQty: number; newQty: number }>
  unchangedCount: number
}

export function diffQuotationGroups(
  baseGroups: DoorGroup[],
  nextGroups: ParsedDoorGroupPreview[],
): QuotationChanges {
  const baseByKey = new Map(baseGroups.map((g) => [g.group_key, g]))
  const nextKeys = new Set(nextGroups.map((g) => g.group_key))

  const added: ParsedDoorGroupPreview[] = []
  const qtyChanged: QuotationChanges['qtyChanged'] = []
  let unchangedCount = 0

  for (const g of nextGroups) {
    const base = baseByKey.get(g.group_key)
    if (!base) {
      added.push(g)
    } else if (Number(base.door_qty) !== Number(g.door_qty)) {
      qtyChanged.push({ group: g, oldQty: Number(base.door_qty), newQty: Number(g.door_qty) })
    } else {
      unchangedCount++
    }
  }

  const removed = baseGroups.filter((g) => !nextKeys.has(g.group_key))
  return { added, removed, qtyChanged, unchangedCount }
}

/** The custom door-group name stored in match_reason ("Custom: <name>"), if any. */
export function customNameFromReason(reason: string | null | undefined): string {
  const m = /^Custom:\s*(.+)$/.exec(reason ?? '')
  return m ? m[1].trim() : ''
}
