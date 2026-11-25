import { describe, expect, it } from 'vitest'
import { applyFlagRules, commentItems, type FlagDoor } from '@/features/projects/doorFlags'
import { sizeSetLines, type SizingLine, type SizingPart } from '@/features/projects/doorSizing'

const part = (id: string, sku: string, legend: string, description: string): SizingPart => ({
  id, sku, legend, description, supplier_id: 'sup-other', unit_cost: 0, active: true,
})

const PARTS: SizingPart[] = [
  part('es', 'ELECTRICSTRIKE', 'ES', 'ELECTRIC STRIKE BY SECURITY CONTRACTOR'),
  part('cr', 'CARDREADER', 'CR', 'CARD READER BY SECURITY CONTRACTOR'),
  part('rs', 'REEDSWITCH', 'RS', 'REED SWITCH BY SECURITY CONTRACTOR'),
  part('kp1', 'KP1.2MM-CSK1', 'KP1', 'KICK PLATE 300(H)X920(W)X1.2M COUNTERSUNK SSS'),
  part('kp2', 'KP1.2MM-CSK2', 'KP2', 'KICK PLATE 300(H)X720(W)X1.2M COUNTERSUNK SSS'),
  part('l25', 'VINGCARD', 'L25', 'VINGCARD LOCK TO BE SUPPLIED BY OTHER'),
  part('peep', 'PEEP', 'MM', 'DOOR VIEWER'),
]

type Line = SizingLine & { origin: 'set' | 'added' }
const make = (p: SizingPart, qty: number): Line => ({
  sku: p.sku, description: p.description, qty_per_door: qty, unit_price: p.unit_cost, part_id: p.id, origin: 'added',
})
const SET: Line[] = [{ sku: '1500BCSIL', description: 'CLOSER', qty_per_door: 1, unit_price: 110, part_id: null, origin: 'set' }]
const door = (hardware: string, comments = '', qty = 1): FlagDoor => ({ qty, hardware, comments })

describe('applyFlagRules', () => {
  it('adds ES + CR + RS for "ES RS", and one kick plate per leaf from the comment', () => {
    const r = applyFlagRules(
      SET,
      [door('Closer · Lock · ES: ES RS', 'CR Card Reader by others. Allowance for kick plate install')],
      2,
      PARTS,
      make,
    )
    expect(r.lines.map((l) => [l.sku, l.qty_per_door, l.origin])).toEqual([
      ['1500BCSIL', 1, 'set'],
      ['ELECTRICSTRIKE', 1, 'added'],
      ['CARDREADER', 1, 'added'],
      ['REEDSWITCH', 1, 'added'],
      ['KP1.2MM-CSK1', 2, 'added'],
    ])
    expect(r.notes).toContain('Kick plate (comment): added KP1 ×2')
  })

  it('RS alone adds only the reed switch; Vingcard and peep hole comments add L25 and the viewer', () => {
    const r = applyFlagRules(SET, [door('Closer · ES: RS', 'Vingcard not allowed | peep hole')], 1, PARTS, make)
    expect(r.lines.slice(1).map((l) => l.sku)).toEqual(['REEDSWITCH', 'VINGCARD', 'PEEP'])
  })

  it('does not add an item the set already has (any kick plate size counts)', () => {
    const withKp: Line[] = [...SET, { ...make(PARTS[4], 1), origin: 'set' }, { ...make(PARTS[0], 1), origin: 'set' }]
    const r = applyFlagRules(withKp, [door('ES: ES', 'kick plate')], 1, PARTS, make)
    expect(r.lines.map((l) => l.sku)).toEqual(['1500BCSIL', 'KP1.2MM-CSK2', 'ELECTRICSTRIKE', 'CARDREADER'])
  })

  it('Stop column adds a door stop per leaf; the Reed Switch column adds the reed switch', () => {
    const stop = part('stop', 'MMDOORSTOP', 'MM', '290 DOOR STOP FLOOR MOUNT 25MM HEIGHT')
    const r = applyFlagRules(SET, [door('Hinge: BH · Stop · Reed switch · Prep: Stop')], 2, [...PARTS, stop], make)
    expect(r.lines.slice(1).map((l) => [l.sku, l.qty_per_door])).toEqual([
      ['REEDSWITCH', 1],
      ['MMDOORSTOP', 2],
    ])
    expect(r.notes).toContain('Door stop (Stop column): added MMDOORSTOP ×2')
    // Not when the set has a stop already, nor from the install cost alone ("Prep: Stop").
    const withStop: Line[] = [...SET, { ...make(stop, 1), origin: 'set' }]
    expect(applyFlagRules(withStop, [door('Stop')], 1, [...PARTS, stop], make).lines).toEqual(withStop)
    expect(applyFlagRules(SET, [door('Prep: Stop')], 1, [...PARTS, stop], make).lines).toEqual(SET)
  })

  it('only adds when every door in the group asks for it; otherwise says so', () => {
    const r = applyFlagRules(SET, [door('ES: RS', '', 5), door('', '', 1)], 1, PARTS, make)
    expect(r.lines).toEqual(SET)
    expect(r.notes).toEqual(['Reed switch (ES column) on 5 of 6 doors — not added; add it by hand if needed'])
  })

  it('notes a missing part instead of adding nothing silently', () => {
    const r = applyFlagRules(SET, [door('', 'Vingcard not allowed')], 1, PARTS.filter((p) => p.id !== 'l25'), make)
    expect(r.lines).toEqual(SET)
    expect(r.notes[0]).toContain('no active L25 part')
  })

  it('then sizing fits the added kick plate to the leaf', () => {
    const flagged = applyFlagRules(SET, [door('', 'Allowance for kick plate install')], 2, PARTS, make)
    const sized = sizeSetLines(flagged.lines, { classification: 'FIRE RATED', leaf: 'DOUBLE', door_size: '2040x720+720' }, PARTS)
    expect(sized.lines[1]).toMatchObject({ sku: 'KP1.2MM-CSK2', qty_per_door: 2, origin: 'added' })
  })

  it('ignores comments that rule the item out; "by others" only rules out items Mena would supply', () => {
    expect(commentItems('No kick plate')).toEqual([])
    expect(commentItems('Kick plate by builder')).toEqual([])
    expect(commentItems('Kick plate not required. Peep hole by others')).toEqual([])
    expect(commentItems('Card reader not required')).toEqual([])
    // The CR / L25 lines are themselves "by others".
    expect(commentItems('CR Card Reader by others. Allowance for kick plate install')).toEqual(['Card reader', 'Kick plate'])
    expect(commentItems('Vingcard not allowed')).toEqual(['Vingcard'])
    const r = applyFlagRules(SET, [door('Closer', 'No kick plate, card reader not required')], 1, PARTS, make)
    expect(r.lines).toEqual(SET)
  })

  it('counts a set line without a legend as already having the item (by its description)', () => {
    const withFsh: Line[] = [...SET, { sku: 'BYOFSH', description: 'FSH HIGH SECURITY MONITORED ELECTRIC STRIKE', qty_per_door: 1, unit_price: null, part_id: null, origin: 'set' }]
    const r = applyFlagRules(withFsh, [door('ES: ES')], 1, PARTS, make)
    expect(r.lines.map((l) => l.sku)).toEqual(['1500BCSIL', 'BYOFSH', 'CARDREADER'])
  })
})
