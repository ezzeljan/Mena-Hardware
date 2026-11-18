import { describe, expect, it } from 'vitest'
import type { DoorGroup, ProjectLine } from '@/types/database'
import { computeVersionDiff } from '@/features/projects/versionDiff'

function makeGroup(overrides: Partial<DoorGroup>): DoorGroup {
  return {
    id: overrides.id ?? 'g1',
    version_id: overrides.version_id ?? 'v1',
    position: overrides.position ?? 1,
    group_key: overrides.group_key ?? 'D10 | BATHROOM | NON RATED | SINGLE | 2040x920',
    door_tag: overrides.door_tag ?? 'D10',
    room_name: overrides.room_name ?? 'BATHROOM',
    classification: overrides.classification ?? 'NON RATED',
    leaf: overrides.leaf ?? 'SINGLE',
    door_size: overrides.door_size ?? '2040x920',
    door_qty: overrides.door_qty ?? 4,
    matched_set_id: null,
    match_status: 'confirmed',
    match_score: 1,
    match_reason: '',
    pm_remarks: '',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  }
}

function makeLine(overrides: Partial<ProjectLine>): ProjectLine {
  return {
    id: overrides.id ?? 'l1',
    group_id: overrides.group_id ?? 'g1',
    position: overrides.position ?? 1,
    sku: overrides.sku ?? 'MMHINGE',
    description: overrides.description ?? 'HINGES',
    qty_per_door: overrides.qty_per_door ?? 3,
    unit_price: overrides.unit_price === undefined ? 4 : overrides.unit_price,
    origin: overrides.origin ?? 'set',
    part_id: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  }
}

describe('computeVersionDiff', () => {
  it('detects added, removed, changed, and unchanged lines across versions', () => {
    const baseGroups = [makeGroup({ id: 'g1-v1', version_id: 'v1' })]
    const targetGroups = [makeGroup({ id: 'g1-v2', version_id: 'v2' })]

    const baseLines = [
      makeLine({ id: 'l1', group_id: 'g1-v1', position: 1, sku: 'MMHINGE', qty_per_door: 3, unit_price: 4 }),
      makeLine({ id: 'l2', group_id: 'g1-v1', position: 2, sku: 'PRIVSET35LRBR', qty_per_door: 1, unit_price: 46 }),
      makeLine({ id: 'l3', group_id: 'g1-v1', position: 3, sku: 'OLDSTOP', qty_per_door: 1, unit_price: 4 }),
    ]

    const targetLines = [
      makeLine({ id: 'l4', group_id: 'g1-v2', position: 1, sku: 'MMHINGE', qty_per_door: 3, unit_price: 4 }), // unchanged
      makeLine({ id: 'l5', group_id: 'g1-v2', position: 2, sku: 'PRIVSET35LRBR', qty_per_door: 2, unit_price: 50 }), // changed
      makeLine({ id: 'l6', group_id: 'g1-v2', position: 3, sku: 'NEWSEAL', qty_per_door: 1, unit_price: null }), // added
    ]

    const diff = computeVersionDiff(baseGroups, baseLines, targetGroups, targetLines)

    expect(diff.summary).toEqual({
      added: 1,
      removed: 1,
      changed: 1,
      unchanged: 1,
    })

    const kinds = diff.groups[0].lines.map((l) => `${l.sku}:${l.kind}`)
    expect(kinds).toContain('MMHINGE:unchanged')
    expect(kinds).toContain('PRIVSET35LRBR:changed')
    expect(kinds).toContain('NEWSEAL:added')
    expect(kinds).toContain('OLDSTOP:removed')
  })
})
