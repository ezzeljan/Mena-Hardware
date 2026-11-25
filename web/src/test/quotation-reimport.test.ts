import { describe, it, expect } from 'vitest'
import type { DoorGroup } from '@/types/database'
import type { ParsedDoorGroupPreview } from '@/features/projects/quotationParser'
import {
  customNameFromReason,
  diffQuotationGroups,
} from '@/features/projects/quotationReimport'
import { makeGroupFinder } from '@/features/projects/groupKey'

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
    hardware: key.split(' | ').slice(5).join(' | '),
    match_room: key,
    extra_hinges: null,
    activities: {},
    lock_cost: '',
  }
}

describe('diffQuotationGroups', () => {
  it('finds added, removed, quantity-changed and unchanged door groups', () => {
    // Typical doors differ by size (door type and room are not part of a group).
    const BATH = '* | * | NON RATED | SINGLE | 2040x820'
    const ENTRY = '* | * | FIRE RATED | SINGLE | 2340x920'
    const STORE = '* | * | NON RATED | SINGLE | 2040x720'
    const COMMS = '* | * | FIRE RATED | SINGLE | 2040x870'
    const changes = diffQuotationGroups(
      [baseGroup(BATH, 3), baseGroup(ENTRY, 2), baseGroup(STORE, 1)],
      [parsed(BATH, 3), parsed(ENTRY, 5), parsed(COMMS, 1)],
    )
    expect(changes.added.map((g) => g.group_key)).toEqual([COMMS])
    expect(changes.removed.map((g) => g.group_key)).toEqual([STORE])
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

describe('diffQuotationGroups with hardware in the key', () => {
  const OLD = 'D65b | FIRE EGRESS | FIRE RATED | SINGLE | 2340x920'

  it('finds a group saved before hardware was part of the key', () => {
    const changes = diffQuotationGroups([baseGroup(OLD, 6)], [parsed(`${OLD} | Closer · ES: RS`, 6)])
    expect(changes.unchangedCount).toBe(1)
    expect(changes.added).toEqual([])
    expect(changes.removed).toEqual([])
    expect(changes.split).toEqual([])
  })

  it('reports an older group whose doors now split by hardware, and does not call it removed', () => {
    const changes = diffQuotationGroups(
      [baseGroup(OLD, 6)],
      [parsed(`${OLD} | Closer · ES: RS`, 5), parsed(`${OLD} | Closer`, 1)],
    )
    expect(changes.removed).toEqual([])
    expect(changes.added).toEqual([])
    expect(changes.split).toHaveLength(1)
    expect(changes.split[0].base.group_key).toBe(OLD)
    expect(changes.split[0].groups.map((g) => g.door_qty)).toEqual([5, 1])
  })

  it('a group with hardware in its key only matches the same hardware', () => {
    const changes = diffQuotationGroups(
      [baseGroup(`${OLD} | Closer · ES: RS`, 5)],
      [parsed(`${OLD} | Closer`, 5)],
    )
    expect(changes.added).toHaveLength(1)
    expect(changes.removed).toHaveLength(1)
  })
})

describe('diffQuotationGroups with rooms merged', () => {
  it('finds older per-room groups for a merged group and keeps the one with the most doors first', () => {
    const a = baseGroup('D62a | SERVICES CUPBOARD | NON RATED | DOUBLE | 2340x620+620', 1)
    const b = baseGroup('D62a | SERVICES CUPBOARD - B1 & B2 | NON RATED | DOUBLE | 2340x620+620', 3)
    const next = parsed('D62a | * | NON RATED | DOUBLE | 2340x620+620 | Closer · Bolt', 4)
    const changes = diffQuotationGroups([a, b], [next])
    expect(changes.removed).toEqual([])
    expect(changes.added).toEqual([])
    expect(changes.unchangedCount).toBe(1) // 1 + 3 = 4 doors
    expect(changes.merged).toHaveLength(1)
    expect(changes.merged[0].bases.map((g) => g.door_qty)).toEqual([3, 1])
    expect(makeGroupFinder([a, b])(next.group_key)).toBe(b)
  })

  it('does not take an older group of another size', () => {
    const other = baseGroup('D62 | SERVICES CUPBOARD | NON RATED | DOUBLE | 2340x720+720', 1)
    const changes = diffQuotationGroups([other], [parsed('* | * | NON RATED | DOUBLE | 2340x620+620', 1)])
    expect(changes.added).toHaveLength(1)
    expect(changes.removed).toHaveLength(1)
  })

  it('takes older groups of other door types and rooms with the same specs (door type is not a hardware factor)', () => {
    const d03 = baseGroup('D-03 | * | NON RATED | SINGLE | 2040x770 | Hinge: BH', 10)
    const d04 = baseGroup('D-04 | * | NON RATED | SINGLE | 2040x770 | Hinge: BH', 1)
    const changes = diffQuotationGroups([d03, d04], [parsed('* | * | NON RATED | SINGLE | 2040x770 | Hinge: BH', 11)])
    expect(changes.added).toHaveLength(0)
    expect(changes.removed).toHaveLength(0)
    expect(changes.merged).toEqual([
      expect.objectContaining({ bases: [d03, d04] }),
    ])
  })
})

describe('customNameFromReason', () => {
  it('reads the custom door group name', () => {
    expect(customNameFromReason('Custom: Plant Room Special')).toBe('Plant Room Special')
    expect(customNameFromReason('room ✓')).toBe('')
    expect(customNameFromReason(null)).toBe('')
  })
})
