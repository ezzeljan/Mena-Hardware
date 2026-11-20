import type { DoorGroup, ProjectLine } from '@/types/database'
import { makeGroupFinder } from '@/features/projects/groupKey'

export type LineDiffKind = 'added' | 'removed' | 'changed' | 'unchanged'

export interface LineDiffItem {
  kind: LineDiffKind
  sku: string
  description: string
  beforeQty: number | null
  afterQty: number | null
  beforePrice: number | null
  afterPrice: number | null
}

export interface GroupDiffItem {
  groupKey: string
  roomName: string
  classification: string
  leaf: string
  doorSize: string
  beforeDoorQty: number | null
  afterDoorQty: number | null
  lines: LineDiffItem[]
}

export interface VersionDiffResult {
  groups: GroupDiffItem[]
  summary: {
    added: number
    removed: number
    changed: number
    unchanged: number
  }
}

export function computeVersionDiff(
  baseGroups: DoorGroup[],
  baseLines: ProjectLine[],
  targetGroups: DoorGroup[],
  targetLines: ProjectLine[],
): VersionDiffResult {
  // Pair each target group with its base group: the same key, or a base group
  // saved before hardware was part of the key (groupKey.ts).
  const findBase = makeGroupFinder(baseGroups)

  const baseLinesByGroup = new Map<string, ProjectLine[]>()
  for (const l of baseLines) {
    const arr = baseLinesByGroup.get(l.group_id) ?? []
    arr.push(l)
    baseLinesByGroup.set(l.group_id, arr)
  }

  const targetLinesByGroup = new Map<string, ProjectLine[]>()
  for (const l of targetLines) {
    const arr = targetLinesByGroup.get(l.group_id) ?? []
    arr.push(l)
    targetLinesByGroup.set(l.group_id, arr)
  }

  const pairs: Array<{ key: string; bg: DoorGroup | undefined; tg: DoorGroup | undefined }> = []
  const pairedBase = new Set<string>()
  for (const tg of targetGroups) {
    const bg = findBase(tg.group_key)
    if (bg) pairedBase.add(bg.id)
    pairs.push({ key: tg.group_key, bg, tg })
  }
  for (const bg of baseGroups) {
    if (!pairedBase.has(bg.id)) pairs.push({ key: bg.group_key, bg, tg: undefined })
  }

  const groupDiffs: GroupDiffItem[] = []
  let added = 0
  let removed = 0
  let changed = 0
  let unchanged = 0

  for (const { key, bg, tg } of pairs) {
    const ref = tg ?? bg!

    const bLines = [...(bg ? (baseLinesByGroup.get(bg.id) ?? []) : [])].sort(
      (a, b) => a.position - b.position,
    )
    const tLines = [...(tg ? (targetLinesByGroup.get(tg.id) ?? []) : [])].sort(
      (a, b) => a.position - b.position,
    )

    // Match lines by SKU occurrence index (handles duplicate SKUs cleanly)
    const bUsed = new Set<number>()
    const lineDiffs: LineDiffItem[] = []

    for (const tl of tLines) {
      const matchIdx = bLines.findIndex(
        (bl, idx) => !bUsed.has(idx) && bl.sku.trim().toUpperCase() === tl.sku.trim().toUpperCase(),
      )

      if (matchIdx === -1) {
        added++
        lineDiffs.push({
          kind: 'added',
          sku: tl.sku,
          description: tl.description,
          beforeQty: null,
          afterQty: Number(tl.qty_per_door),
          beforePrice: null,
          afterPrice: tl.unit_price,
        })
      } else {
        bUsed.add(matchIdx)
        const bl = bLines[matchIdx]
        const qtyChanged = Number(bl.qty_per_door) !== Number(tl.qty_per_door)
        const priceChanged = bl.unit_price !== tl.unit_price
        const descChanged = bl.description.trim() !== tl.description.trim()

        if (qtyChanged || priceChanged || descChanged) {
          changed++
          lineDiffs.push({
            kind: 'changed',
            sku: tl.sku,
            description: tl.description,
            beforeQty: Number(bl.qty_per_door),
            afterQty: Number(tl.qty_per_door),
            beforePrice: bl.unit_price,
            afterPrice: tl.unit_price,
          })
        } else {
          unchanged++
          lineDiffs.push({
            kind: 'unchanged',
            sku: tl.sku,
            description: tl.description,
            beforeQty: Number(bl.qty_per_door),
            afterQty: Number(tl.qty_per_door),
            beforePrice: bl.unit_price,
            afterPrice: tl.unit_price,
          })
        }
      }
    }

    bLines.forEach((bl, idx) => {
      if (bUsed.has(idx)) return
      removed++
      lineDiffs.push({
        kind: 'removed',
        sku: bl.sku,
        description: bl.description,
        beforeQty: Number(bl.qty_per_door),
        afterQty: null,
        beforePrice: bl.unit_price,
        afterPrice: null,
      })
    })

    groupDiffs.push({
      groupKey: key,
      roomName: ref.room_name,
      classification: ref.classification,
      leaf: ref.leaf,
      doorSize: ref.door_size,
      beforeDoorQty: bg ? Number(bg.door_qty) : null,
      afterDoorQty: tg ? Number(tg.door_qty) : null,
      lines: lineDiffs,
    })
  }

  return {
    groups: groupDiffs,
    summary: { added, removed, changed, unchanged },
  }
}
