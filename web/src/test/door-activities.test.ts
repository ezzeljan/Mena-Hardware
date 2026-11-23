import { describe, expect, it } from 'vitest'
import {
  activitiesToken,
  activityQuantities,
  activityRates,
} from '@/features/projects/doorActivities'
import { applyActivityRules, type ActivityLine } from '@/features/projects/activityRules'
import type { SizingPart } from '@/features/projects/doorSizing'

const part = (id: string, sku: string, legend: string, description: string): SizingPart => ({
  id, sku, legend, description, supplier_id: 'sup', unit_cost: 10, active: true,
})

const PARTS: SizingPart[] = [
  part('ds', 'MMDOORSTOP', 'MM', '290 DOOR STOP FLOOR MOUNT 25MM HEIGHT'),
  part('c4', '1500BCSIL', 'C4', 'NOVAS 1500 SERIES CLOSER SIZE 2-5 WITH BACKCHECK SIL'),
  part('c3', '1500VTRBSIL', 'C3', 'NOVAS 1500 SERIES CLOSER SLIDE ARM WITH BACKCHECK'),
  part('kp1', 'KP1.2MM-CSK1', 'KP1', 'KICK PLATE 300(H)X920(W)X1.2M COUNTERSUNK SSS'),
  part('mb9', 'NHMDBS920CA', 'MB9', 'NOVAS CONCEALED FIX (MORTICE) AUTO DOOR BOTTOM SEAL 920MM CA'),
  part('bws', 'NHBWSSDS', 'BWS', 'NOVAS SELF ADHESIVE PERIMETER SEAL SINGLE DOOR SET BLK'),
  part('bwd', 'NHBWSDDS', 'BWD', 'NOVAS SELF ADHESIVE PERIMETER SEAL DOUBLE DOOR SET BLK'),
  part('ms', 'NHMSS2250SIL', '', 'NOVAS MEETING STILE SEAL 2250MM SIL'),
  part('b3', 'NHB3', 'B3', 'NOVAS FLUSH BOLT 300MM'),
  part('m1', 'SB250SSSS', 'M1', 'NOVAS SEQUENCE SELECTOR 230MM SSS'),
]

type Line = ActivityLine & { origin: 'set' | 'added' }
const line = (sku: string, description: string, qty: number, part_id: string | null = null): Line => ({
  sku, description, qty_per_door: qty, unit_price: 5, part_id, origin: 'set',
})
const make = (p: SizingPart, qty: number): Line => ({
  sku: p.sku, description: p.description, qty_per_door: qty, unit_price: p.unit_cost, part_id: p.id, origin: 'added',
})
const ALL_COLUMNS = ['stop', 'closer', 'kickplate', 'dropseal', 'frameseal', 'meetingstile', 'bolt', 'sequence'] as const

describe('prep / install activities', () => {
  it('counts items from the cost over the usual single cost, at most one per leaf for stops and closers', () => {
    const doors = [
      { raw: { stop: 7, closer: 22 }, leaves: 1 },
      { raw: { stop: 7, closer: 22 }, leaves: 1 },
      { raw: { stop: 14, closer: 44, bolt: 90 }, leaves: 2 },
      { raw: { bolt: 45 }, leaves: 2 },
    ]
    const rates = activityRates(doors)
    expect(rates).toMatchObject({ stop: 7, closer: 22, bolt: 45 })
    expect(activityQuantities({ stop: 14, closer: 44, bolt: 90 }, 2, rates)).toEqual({ stop: 2, closer: 2, bolt: 2 })
    // 18 on a double: rounds to 3 but a stop is at most one per leaf.
    expect(activityQuantities({ stop: 18 }, 2, rates)).toEqual({ stop: 2 })
    // Seal sets, sequence selectors: one per door whatever the cost.
    expect(activityQuantities({ frameseal: 38, sequence: 26 }, 2, rates)).toEqual({ frameseal: 1, sequence: 1 })
    expect(activitiesToken({ stop: 2, closer: 1, frameseal: 1 })).toBe('Prep: Stop ×2, Closer, Frame seal')
    expect(activitiesToken({})).toBe('')
  })
})

describe('applyActivityRules', () => {
  const door = (activities: Record<string, number>, extra: Partial<{ leaf: string; comments: string; leaves: number }> = {}) => ({
    activities, leaf: extra.leaf ?? 'SINGLE', comments: extra.comments ?? '', leaves: extra.leaves ?? 1,
  })

  it('adds priced parts the set lacks (any door stop: floor mount)', () => {
    const r = applyActivityRules([line('1500BCSIL', 'CLOSER', 1)], door({ closer: 1, stop: 1, dropseal: 1 }), [...ALL_COLUMNS], PARTS, make)
    expect(r.lines.map((l) => [l.sku, l.qty_per_door, l.origin])).toEqual([
      ['1500BCSIL', 1, 'set'],
      ['MMDOORSTOP', 1, 'added'],
      ['NHMDBS920CA', 1, 'added'],
    ])
    expect(r.notes).toContain('Stop: added MM (priced in the quotation)')
  })

  it('uses the slide-arm closer when the comments say slide arm / parallel', () => {
    const r = applyActivityRules([], door({ closer: 1 }, { comments: 'Slide arm door closer, fully mortised drop seal' }), [...ALL_COLUMNS], PARTS, make)
    expect(r.lines[0].sku).toBe('1500VTRBSIL')
  })

  it('flags a set part the quotation does not price, and keeps it', () => {
    const r = applyActivityRules(
      [line('MMDOORSTOP', 'DOOR STOP', 1), line('1500BCSIL', 'CLOSER', 1)],
      door({ closer: 1 }),
      [...ALL_COLUMNS],
      PARTS,
      make,
    )
    expect(r.lines).toHaveLength(2)
    expect(r.lines[0].review_flag).toBe('No STOP cost in the quotation — check this part')
    expect(r.lines[1].review_flag).toBeUndefined()
  })

  it('does not flag when the quotation has no such column', () => {
    const r = applyActivityRules([line('MMDOORSTOP', 'DOOR STOP', 1)], door({}), ['closer'], PARTS, make)
    expect(r.lines[0].review_flag).toBeUndefined()
  })

  it('raises a quantity the set has too few of', () => {
    const r = applyActivityRules([line('1500BCSIL', 'CLOSER', 1)], door({ closer: 2 }, { leaf: 'DOUBLE', leaves: 2 }), [...ALL_COLUMNS], PARTS, make)
    expect(r.lines[0].qty_per_door).toBe(2)
    expect(r.notes).toContain('Closer 1 → 2 (priced in the quotation)')
  })

  it('double doors: double seal set, meeting stile seal, flush bolts, sequence selector', () => {
    const r = applyActivityRules(
      [],
      door({ frameseal: 1, meetingstile: 1, bolt: 2, sequence: 1 }, { leaf: 'DOUBLE', leaves: 2 }),
      [...ALL_COLUMNS],
      PARTS,
      make,
    )
    expect(r.lines.map((l) => [l.sku, l.qty_per_door])).toEqual([
      ['NHBWSDDS', 1],
      ['NHMSS2250SIL', 1],
      ['NHB3', 2],
      ['SB250SSSS', 1],
    ])
  })

  it('a cavity door rebate kit is not a meeting stile seal', () => {
    const r = applyActivityRules([], door({ meetingstile: 1 }, { leaf: 'CAVITY DOUBLE', leaves: 2 }), [...ALL_COLUMNS], PARTS, make)
    expect(r.lines).toEqual([])
  })
})
