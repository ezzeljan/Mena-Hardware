import { describe, expect, it } from 'vitest'
import { startingLines } from '@/features/projects/customGroupLines'
import type { SizingPart } from '@/features/projects/doorSizing'

const part = (id: string, sku: string, description: string): SizingPart => ({
  id, sku, legend: '', description, supplier_id: 's', unit_cost: 4, active: true,
})
const PARTS = [
  part('lo', 'MMHINGELIFTOFF', 'LIFT OFF HINGE WITH SCREWS'),
  part('bb', 'MMHINGE', 'HINGES 100X100 4BB BLACK'),
]

describe('startingLines (door group with no standard set)', () => {
  it('3 standard hinges per leaf', () => {
    expect(startingLines({ leaf: 'SINGLE', classification: 'NON RATED' }, 1, PARTS)).toEqual([{ part: PARTS[1], qty: 3 }])
    expect(startingLines({ leaf: 'DOUBLE', classification: 'FIRE RATED' }, 2, PARTS)[0].qty).toBe(6)
  })

  it('no hinges for a cavity slider or a pivot door', () => {
    expect(startingLines({ leaf: 'CAVITY SINGLE', classification: 'NON RATED' }, 1, PARTS)).toEqual([])
    expect(startingLines({ leaf: '', classification: 'FIRE RATED - PIVOT' }, 1, PARTS)).toEqual([])
  })

  it('without MMHINGE, any standard hinge (not a lift off one)', () => {
    const other = [PARTS[0], part('x', 'LW-HINGE', 'LOCKWOOD HINGES 100X100 FIXED PIN')]
    expect(startingLines({ leaf: 'SINGLE', classification: '' }, 1, other)[0].part.sku).toBe('LW-HINGE')
  })
})
