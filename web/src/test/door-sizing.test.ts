import { describe, expect, it } from 'vitest'
import {
  parseDoorSize,
  partWidthMm,
  sizeSetLines,
  type SizingLine,
  type SizingPart,
} from '@/features/projects/doorSizing'

const NOVAS = 'sup-novas'
const OTHER = 'sup-other'
const MM = 'sup-mm'

const part = (id: string, sku: string, legend: string, description: string, supplier_id: string, unit_cost: number | null = 10): SizingPart => ({
  id, sku, legend, description, supplier_id, unit_cost, active: true,
})

const PARTS: SizingPart[] = [
  part('hinge', 'MMHINGE', 'MM', 'HINGES 100X100 4BB BLACK', MM, null),
  part('bws', 'NHBWSSDS', 'BWS', 'NOVAS SELF ADHESIVE PERIMETER SEAL SINGLE DOOR SET BLK', NOVAS, 15),
  part('bwls', 'NHBWSLSDS', 'BWLS', 'NOVAS SELF ADHESIVE PERIMETER SEAL LONG SINGLE DOOR SET BLK', NOVAS, 19),
  part('bwd', 'NHBWSDDS', 'BWD', 'NOVAS SELF ADHESIVE PERIMETER SEAL DOUBLE DOOR SET BLK', NOVAS, 22),
  part('bwld', 'NHBWSLDDS', 'BWLD', 'NOVAS SELF ADHESIVE PERIMETER SEAL LONG DOUBLE DOOR SET BLK', NOVAS, 26),
  part('mb7', 'NHMDBS720CA', 'MB7', 'NOVAS CONCEALED FIX (MORTICE) AUTO DOOR BOTTOM SEAL 720MM CA', NOVAS, 24),
  part('mb8', 'NHMDBS820CA', 'MB8', 'NOVAS CONCEALED FIX (MORTICE) AUTO DOOR BOTTOM SEAL 820MM CA', NOVAS, 25),
  part('mb9', 'NHMDBS920CA', 'MB9', 'NOVAS CONCEALED FIX (MORTICE) AUTO DOOR BOTTOM SEAL 920MM CA', NOVAS, 26),
  part('kp1', 'KP1.2MM-CSK1', 'KP1', 'KICK PLATE 300(H)X920(W)X1.2M COUNTERSUNK SSS', OTHER, 0),
  part('kp2', 'KP1.2MM-CSK2', 'KP2', 'KICK PLATE 300(H)X720(W)X1.2M COUNTERSUNK SSS', OTHER, 0),
  part('c4', '1500BCSIL', 'C4', 'NOVAS 1500 SERIES CLOSER SIZE 2-5 WITH BACKCHECK SIL', NOVAS, 110),
]

const line = (sku: string, description: string, qty: number, part_id: string | null = null): SizingLine => ({
  sku, description, qty_per_door: qty, unit_price: 5, part_id,
})

// A standard fire-rated single set, drawn up for 2040 x 920.
const FIRE_SINGLE = [
  line('MMHINGE', 'HINGES', 3),
  line('1500BCSIL', 'CLOSER', 1),
  line('NHBWSSDS', 'PERIMETER SEAL', 1),
  line('NHMDBS920CA', 'DROP SEAL', 1),
  line('KP1.2MM-CSK1', 'KICK PLATE', 1),
]

describe('door sizing helpers', () => {
  it('reads door sizes and part widths', () => {
    expect(parseDoorSize('2340x920+920')).toEqual({ height: 2340, widths: [920, 920] })
    expect(parseDoorSize('2040x870')).toEqual({ height: 2040, widths: [870] })
    expect(parseDoorSize(null)).toBeNull()
    expect(parseDoorSize('custom')).toBeNull()
    expect(partWidthMm('KICK PLATE 300(H)X720(W)X1.2M')).toBe(720)
    expect(partWidthMm('AUTO DOOR BOTTOM SEAL 820MM CA')).toBe(820)
    expect(partWidthMm('DOOR STOP FLOOR MOUNT 25MM HEIGHT')).toBeNull()
  })
})

describe('sizeSetLines', () => {
  it('leaves a 2040 x 920 door as the set has it', () => {
    const r = sizeSetLines(FIRE_SINGLE, { classification: 'FIRE RATED', leaf: 'SINGLE', door_size: '2040x920' }, PARTS)
    expect(r.notes).toEqual([])
    expect(r.lines).toEqual(FIRE_SINGLE)
  })

  it('sizes a tall fire-rated single: 4 hinges, long seal, narrower drop seal and kick plate', () => {
    const r = sizeSetLines(FIRE_SINGLE, { classification: 'FIRE RATED', leaf: 'SINGLE', door_size: '2340x720' }, PARTS)
    expect(r.lines.map((l) => [l.sku, l.qty_per_door])).toEqual([
      ['MMHINGE', 4],
      ['1500BCSIL', 1],
      ['NHBWSLSDS', 1],
      ['NHMDBS720CA', 1],
      ['KP1.2MM-CSK2', 1],
    ])
    // A swapped line takes the new part's id, description and cost.
    expect(r.lines[2]).toMatchObject({ part_id: 'bwls', unit_price: 19 })
    expect(r.notes).toEqual([
      'Hinges 3 → 4 (fire rated, 2340 high)',
      'BWS → BWLS (2340 high)',
      'MB9 → MB7 (720 mm for a 720 leaf)',
      'KP1 → KP2 (720 mm for a 720 leaf)',
    ])
  })

  it('takes the smallest drop seal that covers the leaf', () => {
    const r = sizeSetLines(FIRE_SINGLE, { classification: 'FIRE RATED', leaf: 'SINGLE', door_size: '2040x870' }, PARTS)
    // Lines keep their order: [3] drop seal, [4] kick plate.
    expect(r.lines[3].sku).toBe('NHMDBS920CA')
    expect(r.lines[4].sku).toBe('KP1.2MM-CSK1')
    const narrow = sizeSetLines(FIRE_SINGLE, { classification: 'FIRE RATED', leaf: 'SINGLE', door_size: '2040x780' }, PARTS)
    expect(narrow.lines[3].sku).toBe('NHMDBS820CA')
  })

  it('keeps the largest part and says so when nothing covers the leaf', () => {
    const r = sizeSetLines(FIRE_SINGLE, { classification: 'FIRE RATED', leaf: 'SINGLE', door_size: '2040x970' }, PARTS)
    expect(r.lines[3].sku).toBe('NHMDBS920CA')
    expect(r.notes.some((n) => n.startsWith('No MB part of 970 mm or more') && n.includes('kept MB9'))).toBe(true)
  })

  it('doubles: hinges per leaf, long double seal set, drop seal per widest leaf', () => {
    const set = [
      line('MMHINGE', 'HINGES', 6),
      line('NHBWSDDS', 'PERIMETER SEAL', 1),
      line('NHMDBS920CA', 'DROP SEAL', 2),
    ]
    const r = sizeSetLines(set, { classification: 'FIRE RATED', leaf: 'DOUBLE', door_size: '2395x720+720' }, PARTS)
    expect(r.lines.map((l) => [l.sku, l.qty_per_door])).toEqual([
      ['MMHINGE', 8],
      ['NHBWSLDDS', 1],
      ['NHMDBS720CA', 2],
    ])
  })

  it('does not add hinges to non-rated tall doors or to sets with a non-standard count', () => {
    const nonRated = sizeSetLines(FIRE_SINGLE, { classification: 'NON RATED', leaf: 'SINGLE', door_size: '2340x920' }, PARTS)
    expect(nonRated.lines[0].qty_per_door).toBe(3)
    // The long seal still applies: it depends on height only.
    expect(nonRated.lines[2].sku).toBe('NHBWSLSDS')
    const odd = sizeSetLines([line('MMHINGE', 'HINGES', 6)], { classification: 'FIRE RATED', leaf: 'SINGLE', door_size: '2340x920' }, PARTS)
    expect(odd.lines[0].qty_per_door).toBe(6)
  })

  it('adds the EXTRA HINGE hinges to the hinge line when the schedule gives them', () => {
    const single = sizeSetLines(FIRE_SINGLE, { classification: 'FIRE RATED', leaf: 'SINGLE', door_size: '2340x920', extra_hinges: 1 }, PARTS)
    expect(single.lines[0].qty_per_door).toBe(4)
    expect(single.notes[0]).toBe('Hinges 3 → 4 (EXTRA HINGE: +1)')
    const double = sizeSetLines([line('MMHINGE', 'HINGES', 6)], { classification: 'FIRE RATED', leaf: 'DOUBLE', door_size: '2340x920+920', extra_hinges: 2 }, PARTS)
    expect(double.lines[0].qty_per_door).toBe(8)
    // The schedule says no extra hinge: none added, even on a tall fire door.
    const none = sizeSetLines(FIRE_SINGLE, { classification: 'FIRE RATED', leaf: 'SINGLE', door_size: '2340x920', extra_hinges: 0 }, PARTS)
    expect(none.lines[0].qty_per_door).toBe(3)
    // Only the first hinge line gets them.
    const two = sizeSetLines([line('MMHINGE', 'HINGES', 3), line('MMHINGE', 'HINGES', 3)], { classification: 'NON RATED', leaf: 'SINGLE', door_size: '2040x920', extra_hinges: 1 }, PARTS)
    expect(two.lines.map((l) => l.qty_per_door)).toEqual([4, 3])
  })

  it('without an EXTRA HINGE column: non-rated doors over 2400 get one more hinge per leaf', () => {
    const tall = sizeSetLines(FIRE_SINGLE, { classification: 'NON RATED', leaf: 'SINGLE', door_size: '2560x1038' }, PARTS)
    expect(tall.lines[0].qty_per_door).toBe(4)
    expect(tall.notes[0]).toBe('Hinges 3 → 4 (non rated, 2560 high)')
    const atLimit = sizeSetLines(FIRE_SINGLE, { classification: 'NON RATED', leaf: 'SINGLE', door_size: '2400x920' }, PARTS)
    expect(atLimit.lines[0].qty_per_door).toBe(3)
  })

  it('keeps the set price when the swapped part has no cost in the library', () => {
    const parts = PARTS.map((p) => (p.id === 'bwls' ? { ...p, unit_cost: null } : p))
    const r = sizeSetLines(FIRE_SINGLE, { classification: 'NON RATED', leaf: 'SINGLE', door_size: '2340x920' }, parts)
    expect(r.lines[2]).toMatchObject({ sku: 'NHBWSLSDS', unit_price: 5 })
    expect(r.notes).toContain('BWLS: no cost in the parts library — kept the set price')
  })

  it('swaps a long seal back to short on a low door', () => {
    const r = sizeSetLines([line('NHBWSLSDS', 'SEAL', 1)], { classification: 'NON RATED', leaf: 'SINGLE', door_size: '2040x820' }, PARTS)
    expect(r.lines[0].sku).toBe('NHBWSSDS')
  })

  it('leaves lines alone when the door size is unknown', () => {
    const r = sizeSetLines(FIRE_SINGLE, { classification: 'FIRE RATED', leaf: 'SINGLE', door_size: null }, PARTS)
    expect(r).toEqual({ lines: FIRE_SINGLE, notes: [] })
  })
})
