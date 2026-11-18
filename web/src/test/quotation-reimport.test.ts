import { describe, it, expect } from 'vitest'
import type { DoorGroup, ProjectLine } from '@/types/database'
import type { ParsedDoorGroupPreview } from '@/features/projects/quotationParser'
import {
  carriedLinesPayload,
  customNameFromReason,
  diffQuotationGroups,
} from '@/features/projects/quotationReimport'

const TS = '2026-11-18T00:00:00Z'

function baseGroup(key: string, qty: number): DoorGroup {
  return {
    id: `g-${key}`,
    version_id: 'v1',
    position: 1,
    group_key: key,
    door_tag: '',
    room_name: key,
    classification: '',
    leaf: '',
    door_size: '',
    door_qty: qty,
    matched_set_id: null,
    match_status: 'confirmed',
    match_score: null,
    match_reason: '',
    pm_remarks: '',
    created_at: TS,
    updated_at: TS,
  }
}

function parsed(key: string, qty: number): ParsedDoorGroupPreview {
  return {
    position: 1,
    group_key: key,
    door_tag: '',
    room_name: key,
    classification: null,
    leaf: null,
    door_size: null,
    door_qty: qty,
    source_rows: [1],
  }
}

describe('diffQuotationGroups', () => {
  it('finds added, removed, quantity-changed and unchanged door groups', () => {
    const changes = diffQuotationGroups(
      [baseGroup('BATHROOM', 3), baseGroup('ENTRY', 2), baseGroup('STORE', 1)],
      [parsed('BATHROOM', 3), parsed('ENTRY', 5), parsed('COMMS', 1)],
    )
    expect(changes.added.map((g) => g.group_key)).toEqual(['COMMS'])
    expect(changes.removed.map((g) => g.group_key)).toEqual(['STORE'])
    expect(changes.qtyChanged).toEqual([
      expect.objectContaining({ oldQty: 2, newQty: 5 }),
    ])
    expect(changes.unchangedCount).toBe(1)
  })

  it('treats numeric strings from the database as the same quantity', () => {
    const g = baseGroup('BATHROOM', 3)
    ;(g as unknown as { door_qty: string }).door_qty = '3.000'
    expect(diffQuotationGroups([g], [parsed('BATHROOM', 3)]).unchangedCount).toBe(1)
  })
})

describe('customNameFromReason', () => {
  it('reads the custom door group name', () => {
    expect(customNameFromReason('Custom: Plant Room Special')).toBe('Plant Room Special')
    expect(customNameFromReason('room ✓')).toBe('')
    expect(customNameFromReason(null)).toBe('')
  })
})

describe('carriedLinesPayload', () => {
  it('keeps edits and blank prices, and renumbers positions in order', () => {
    const line = (id: string, position: number, unit_price: number | null): ProjectLine => ({
      id,
      group_id: 'g',
      position,
      sku: id.toUpperCase(),
      description: id,
      qty_per_door: 1,
      unit_price,
      origin: 'edited',
      part_id: null,
      created_at: TS,
      updated_at: TS,
    })
    const payload = carriedLinesPayload([line('b', 7, null), line('a', 2, 4.5)])
    expect(payload.map((l) => [l.position, l.sku, l.unit_price, l.origin])).toEqual([
      [1, 'A', 4.5, 'edited'],
      [2, 'B', null, 'edited'],
    ])
  })
})
