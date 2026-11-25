import { describe, expect, it } from 'vitest'
import type { DoorGroup, ProjectLine } from '@/types/database'
import { planMerge } from '@/features/projects/mergeGroups'

const TS = '2026-11-24T00:00:00Z'

function group(id: string, position: number, room: string, qty: number, size = '2040x770'): DoorGroup {
  return {
    id, version_id: 'v1', position, group_key: `* | ${room.toUpperCase()} | NON RATED | SINGLE | ${size}`,
    door_tag: '', room_name: room, classification: 'NON RATED', leaf: 'SINGLE', door_size: size,
    door_qty: qty, matched_set_id: null, match_status: 'manual', match_score: null, match_reason: '',
    pm_remarks: '', created_at: TS, updated_at: TS,
  }
}

function line(id: string, groupId: string, sku: string, qty = 1, sheet = 's1'): ProjectLine {
  return {
    id, group_id: groupId, position: 1, sku, description: sku, qty_per_door: qty, unit_price: 1,
    origin: 'set', part_id: null, sheet_id: sheet, mhqt_remarks: '', review_flag: '', created_at: TS, updated_at: TS,
  } as ProjectLine
}

describe('planMerge', () => {
  const linen = group('g1', 1, 'Linen', 10)
  const broom = group('g2', 2, 'Broom', 1)
  const lines = [
    line('l1', 'g1', 'H-1', 3), line('l2', 'g1', 'DS-1'),
    line('l3', 'g2', 'H-1', 3), line('l4', 'g2', 'KP-1'),
    // Second sheet: both have the hinge.
    line('l5', 'g1', 'H-1', 3, 's2'), line('l6', 'g2', 'H-1', 3, 's2'),
  ]

  it('keeps the first group, adds the door qty and joins the rooms', () => {
    const plan = planMerge([broom, linen], lines)
    expect(plan.target.id).toBe('g1')
    expect(plan.others.map((g) => g.id)).toEqual(['g2'])
    expect(plan.doorQty).toBe(11)
    expect(plan.roomName).toBe('Linen / Broom')
    expect(plan.specsDiffer).toBe(false)
  })

  it('offers only the hardware not in every group, per sheet', () => {
    const plan = planMerge([linen, broom], lines)
    expect(plan.uncommon.map((u) => [u.sku, u.inRooms, u.notInRooms])).toEqual([
      ['DS-1', ['Linen'], ['Broom']],
      ['KP-1', ['Broom'], ['Linen']],
    ])
  })

  it('keeps common lines once and resolves the choices to line ids', () => {
    const plan = planMerge([linen, broom], lines)
    const ds = plan.uncommon.find((u) => u.sku === 'DS-1')!.key
    const kp = plan.uncommon.find((u) => u.sku === 'KP-1')!.key
    // Include the kick plate, drop the door stop.
    expect(plan.resolve(new Set([kp]))).toEqual({ keep: ['l1', 'l5'], copy: ['l4'] })
    // Include both.
    expect(plan.resolve(new Set([ds, kp]))).toEqual({ keep: ['l1', 'l2', 'l5'], copy: ['l4'] })
    // Neither.
    expect(plan.resolve(new Set())).toEqual({ keep: ['l1', 'l5'], copy: [] })
  })

  it('treats another qty of the same part as different hardware', () => {
    const plan = planMerge([linen, broom], [line('a', 'g1', 'H-1', 3), line('b', 'g2', 'H-1', 4)])
    expect(plan.uncommon.map((u) => [u.sku, u.qtyPerDoor])).toEqual([
      ['H-1', 3],
      ['H-1', 4],
    ])
  })

  it('flags groups of different sizes', () => {
    expect(planMerge([linen, group('g3', 3, 'Store', 2, '2040x820')], []).specsDiffer).toBe(true)
  })

  it('lists a room once when it is already in a merged name', () => {
    expect(planMerge([group('g1', 1, 'Linen / Broom', 11), group('g2', 2, 'BROOM', 1)], []).roomName).toBe('Linen / Broom')
  })
})

describe('buildMergedGroup (import page)', () => {
  it('keeps every group\'s prep / install values', async () => {
    const { planDraftMerge, buildMergedGroup } = await import('@/features/projects/mergeParsedGroups')
    const g = (key: string, hardware: string, prep: Record<string, string>, rows: number[]) => ({
      position: 1, group_key: key, door_tag: 'D', room_name: 'Store', classification: 'NR', leaf: 'SINGLE',
      door_size: '2040x820', door_qty: 1, source_rows: rows, hardware, match_room: 'Store', extra_hinges: 0,
      activities: {}, lock_cost: '', prep_values: prep,
    })
    const plan = planDraftMerge([
      g('a', 'Prep: Closer', { Closer: '22' }, [6]),
      g('b', 'Prep: Closer, Kick plate', { Closer: '44', 'Kick plate': '30' }, [7]),
    ])
    const merged = buildMergedGroup(plan, 'Store', new Set(['Kick plate']))
    expect(merged.prep_values).toEqual({ Closer: '22/44', 'Kick plate': '30' })
  })
})
