import { describe, expect, it } from 'vitest'
import { applyLockRules, lockKindOf, lockNeedOf, type LockDoor } from '@/features/projects/lockRules'
import type { SizingPart } from '@/features/projects/doorSizing'
import type { ActivityLine } from '@/features/projects/activityRules'

const part = (legend: string, sku: string, description: string): SizingPart => ({
  id: sku, sku, legend, description, supplier_id: 'novas', unit_cost: 10, active: true,
})
const PARTS: SizingPart[] = [
  part('L1', '6115SSS', 'NOVAS 6000 SERIES STOREROOM LOCK 60MM BACKSET SSS'),
  part('L2', '6125SSS', 'NOVAS 6000 SERIES VESTIBULE LOCK 60MM BACKSET SSS'),
  part('L4', '6235SSS', 'NOVAS 6000 SERIES PRIVACY LATCH 60MM BACKSET SSS'),
  part('L5', '6250SSS', 'NOVAS 6000 SERIES PASSAGE LATCH 60MM BACKSET SSS'),
  part('L12', '12905SSS', 'NOVAS TUBULAR PASSAGE LATCH SSS'),
  part('K1A', '610N1ASCA', 'NOVAS N1A RESTRICTED OVAL CYLINDER SC WITH ACAM'),
  part('K4', 'N1ACUTKEY', 'N1A CUT KEY'),
  part('F2', 'B08SSS', 'NOVAS CYLINDER ESCUTCHEON ROUND B ROSE SSS'),
  part('F3', 'B06SSS', 'NOVAS TURNSNIB ROUND B ROSE SSS'),
  part('F4', 'B0435SSS', 'NOVAS DESIGNER PRIVACY SET 35 LEVER ROUND B ROSE SSS'),
  part('F6', 'B06DSSS', 'NOVAS DISABLED TURNSNIB ROUND B ROSE SSS'),
  part('F7', 'B0163SSS', 'NOVAS DESIGNER PASSAGE SET 63 LEVER ROUND B ROSE SSS'),
  part('MM', 'MMHINGE', 'BUTT HINGE 100X75'),
]
type Line = ActivityLine & { origin: 'set' | 'added' }
const make = (p: SizingPart, qty: number): Line => ({
  sku: p.sku, description: p.description, qty_per_door: qty, unit_price: p.unit_cost, part_id: p.id, origin: 'added',
})
const set = (...skus: string[]): Line[] =>
  skus.map((sku) => ({ ...make(PARTS.find((p) => p.sku === sku)!, 1), origin: 'set' as const }))
const door = (lockCost: string, hardware = '', room = 'STORE'): LockDoor => ({ lockCost, hardware, room })
const skus = (lines: Line[]) => lines.map((l) => l.sku)

describe('lock rules', () => {
  it('knows the lock parts', () => {
    expect(PARTS.map((p) => lockKindOf(p.description))).toEqual([
      'lock', 'lock', 'latch', 'latch', 'latch', 'cylinder', 'key', 'escutcheon', 'turnsnib', 'privacyset', 'turnsnib', 'lever', null,
    ])
  })

  it('reads 15 / 25, and other values from the Lock / Latch columns', () => {
    expect(lockNeedOf(door('15'))).toMatchObject({ need: 'nonlockable', sure: true })
    expect(lockNeedOf(door('25/70'))).toMatchObject({ need: 'lockable', sure: true })
    expect(lockNeedOf(door('30', 'Hinge: BH · Lock · Latch'))).toMatchObject({ need: 'lockable', sure: false })
    expect(lockNeedOf(door('30', 'Latch · Lock prep: 30'))).toMatchObject({ need: 'nonlockable', sure: false })
    expect(lockNeedOf(door('35'))).toMatchObject({ need: null })
    expect(lockNeedOf(door(''))).toMatchObject({ need: null })
  })

  it('25 on a passage set: latch out; storeroom lock, cylinder and escutcheon in', () => {
    const r = applyLockRules(set('MMHINGE', '12905SSS', 'B0163SSS'), door('25'), PARTS, make)
    expect(skus(r.lines)).toEqual(['MMHINGE', 'B0163SSS', '6115SSS', '610N1ASCA', 'B08SSS'])
    expect(r.lines.filter((l) => l.origin === 'added').map((l) => l.sku)).toEqual(['6115SSS', '610N1ASCA', 'B08SSS'])
    expect(r.notes[0]).toBe('LOCK PREP 25: removed 12905SSS')
  })

  it('25 on a privacy set (turnsnib): a vestibule lock', () => {
    const r = applyLockRules(set('MMHINGE', '6235SSS', 'B0163SSS', 'B06DSSS'), door('25'), PARTS, make)
    expect(skus(r.lines)).toEqual(['MMHINGE', 'B0163SSS', 'B06DSSS', '6125SSS', '610N1ASCA', 'B08SSS'])
  })

  it('25 on a lockable set: nothing changes', () => {
    const lines = set('MMHINGE', '6115SSS', 'B0163SSS', 'B08SSS', '610N1ASCA')
    expect(applyLockRules(lines, door('25'), PARTS, make)).toEqual({ lines, notes: [] })
  })

  it('15 on a lockable set: lock, cylinder, key and escutcheon out; passage latch in', () => {
    const r = applyLockRules(set('MMHINGE', '6115SSS', 'B0163SSS', 'B08SSS', '610N1ASCA', 'N1ACUTKEY'), door('15'), PARTS, make)
    expect(skus(r.lines)).toEqual(['MMHINGE', 'B0163SSS', '6250SSS'])
    expect(r.lines.some((l) => l.review_flag)).toBe(false)
  })

  it('15 in a bathroom: privacy latch, lever and turnsnib', () => {
    const r = applyLockRules(set('MMHINGE', '6115SSS', 'B08SSS', '610N1ASCA'), door('15', '', 'ENSUITE'), PARTS, make)
    expect(skus(r.lines)).toEqual(['MMHINGE', '6235SSS', 'B0163SSS', 'B06SSS'])
  })

  it('15 on a passage or privacy set: nothing changes', () => {
    const passage = set('MMHINGE', '6250SSS', 'B0163SSS')
    expect(applyLockRules(passage, door('15'), PARTS, make).lines).toEqual(passage)
    const privacy = set('MMHINGE', 'B0435SSS')
    expect(applyLockRules(privacy, door('15', '', 'BATHROOM'), PARTS, make).lines).toEqual(privacy)
  })

  it('15 with Lock = YES: non-lockable, and the lock lines are flagged', () => {
    const r = applyLockRules(set('MMHINGE', '6115SSS', 'B0163SSS'), door('15', 'Hinge: LO · Lock · Latch'), PARTS, make)
    expect(skus(r.lines)).toEqual(['MMHINGE', 'B0163SSS', '6250SSS'])
    const flagged = r.lines.filter((l) => l.review_flag).map((l) => l.sku)
    expect(flagged).toEqual(['B0163SSS', '6250SSS'])
    expect(r.lines[1].review_flag).toBe('LOCK PREP 15 means non-lockable, but the Lock column says YES — check the lock')
  })

  it('30: follows the Lock column and flags the lock lines', () => {
    const r = applyLockRules(set('MMHINGE', '6250SSS', 'B0163SSS'), door('30', 'Lock'), PARTS, make)
    expect(skus(r.lines)).toEqual(['MMHINGE', 'B0163SSS', '6115SSS', '610N1ASCA', 'B08SSS'])
    expect(r.lines.filter((l) => l.review_flag)).toHaveLength(4)
    expect(r.lines[1].review_flag).toMatch(/^LOCK PREP 30: meaning not confirmed yet — lockable \(Lock column\)/)
  })

  it('35 with no Lock / Latch column: nothing changes, the lock is flagged', () => {
    const r = applyLockRules(set('MMHINGE', '6250SSS', 'B0163SSS'), door('35'), PARTS, make)
    expect(skus(r.lines)).toEqual(['MMHINGE', '6250SSS', 'B0163SSS'])
    expect(r.lines.map((l) => Boolean(l.review_flag))).toEqual([false, true, true])
  })

  it('no lock cost (EX / blank): nothing changes', () => {
    const lines = set('MMHINGE', '6250SSS')
    expect(applyLockRules(lines, door(''), PARTS, make)).toEqual({ lines, notes: [] })
  })
})
