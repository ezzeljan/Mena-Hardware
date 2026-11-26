import { describe, expect, it } from 'vitest'
import { nameMatch, resolveGenericItem, type GenericItem, type ResolvablePart } from '@/features/projects/genericParts'

const NOVAS = 'sup-novas'
const LOCKWOOD = 'sup-lockwood'
const MM = 'sup-mm'
const LEVERS = 'folder-levers'

const part = (id: string, sku: string, description: string, supplier_id: string, extra: Partial<ResolvablePart> = {}): ResolvablePart => ({
  id, sku, description, supplier_id, unit_cost: 10, active: true, folder_id: LEVERS, ...extra,
})
const PARTS = [
  part('nv-pass', 'B0163SSS', 'NOVAS DESIGNER PASSAGE SET 63 LEVER ROUND B ROSE SSS', NOVAS),
  part('nv-priv', 'B0435SSS', 'NOVAS DESIGNER PRIVACY SET 35 LEVER ROUND B ROSE SSS', NOVAS),
  part('lw-pass', 'LW1800PS', 'LOCKWOOD PASSAGE SET LEVER ROUND ROSE SC', LOCKWOOD),
  part('lw-priv', 'LW1800PR', 'LOCKWOOD PRIVACY SET LEVER ROUND ROSE SC', LOCKWOOD),
  part('mm-view', 'PEEP', 'DOOR VIEWER', MM, { folder_id: 'folder-viewers' }),
]
const index = { byId: new Map(PARTS.map((p) => [p.id, p])), all: PARTS }
const PASSAGE: GenericItem = { id: 'g-pass', code: 'PASSSETLEVR', description: 'PASSAGE SET LEVER ROUND', folder_id: LEVERS, active: true }
const PRIVACY: GenericItem = { id: 'g-priv', code: 'PRIVSET35LRBR', description: 'PRIVACY SET 35 LEVER ROUND B ROSE', folder_id: LEVERS, active: true }
const TURNSNIB: GenericItem = { id: 'g-snib', code: 'TURNSNIBR', description: 'TURNSNIB ROUND', folder_id: LEVERS, active: true }
const ITEMS = [PASSAGE, PRIVACY, TURNSNIB]
const PREFS = [{ generic_id: 'g-pass', supplier_id: NOVAS, part_id: 'nv-pass' }]

describe('resolveGenericItem', () => {
  it("uses the supplier's preferred part", () => {
    expect(resolveGenericItem(PASSAGE, NOVAS, PREFS, index)).toMatchObject({ part: { sku: 'B0163SSS' }, how: 'preferred' })
  })

  it("without one, the supplier's closest part in the folder (by name)", () => {
    // Lockwood has a passage and a privacy set: the passage set matches the name.
    expect(resolveGenericItem(PASSAGE, LOCKWOOD, PREFS, index, new Set(), ITEMS)).toMatchObject({ part: { sku: 'LW1800PS' }, how: 'folder' })
  })

  it('falls back to the default (another supplier) when the supplier has nothing suitable', () => {
    expect(resolveGenericItem(PASSAGE, 'sup-none', PREFS, index)).toMatchObject({ part: { sku: 'B0163SSS' }, how: 'default' })
    expect(resolveGenericItem(PASSAGE, null, PREFS, index)).toMatchObject({ how: 'default' })
  })

  it('an inactive preferred part is skipped; with nothing at all, null', () => {
    const inactive = { byId: new Map(PARTS.map((p) => [p.id, p.id === 'nv-pass' ? { ...p, active: false } : p])), all: PARTS.map((p) => (p.id === 'nv-pass' ? { ...p, active: false } : p)) }
    // NOVAS: preferred inactive -> its only other lever part is a privacy set, not a passage set.
    expect(resolveGenericItem(PASSAGE, NOVAS, PREFS, inactive, new Set(), ITEMS)).toBeNull()
    expect(resolveGenericItem({ ...PASSAGE, id: 'g-none', folder_id: null }, NOVAS, PREFS, index)).toBeNull()
  })

  it('an owner-supplied preferred part (MM) is used for any supplier', () => {
    const viewer: GenericItem = { id: 'g-view', code: 'DOORVIEWER', description: 'DOOR VIEWER', folder_id: 'folder-viewers', active: true }
    const prefs = [{ generic_id: 'g-view', supplier_id: MM, part_id: 'mm-view' }]
    expect(resolveGenericItem(viewer, NOVAS, prefs, index, new Set([MM]))).toMatchObject({ part: { sku: 'PEEP' }, how: 'default' })
  })

  it('nameMatch: share of the name words in the description', () => {
    expect(nameMatch('PASSAGE SET LEVER ROUND', 'LOCKWOOD PASSAGE SET LEVER ROUND ROSE SC')).toBe(1)
    expect(nameMatch('PASSAGE SET LEVER ROUND', 'LOCKWOOD PRIVACY SET LEVER ROUND ROSE SC')).toBe(0.75)
    // Among the folder's names, PASSAGE is what sets it apart: a privacy set no longer passes 0.6.
    expect(nameMatch('PASSAGE SET LEVER ROUND', 'LOCKWOOD PRIVACY SET LEVER ROUND ROSE SC', ITEMS.map((g) => g.description))).toBeLessThan(0.6)
  })
})
