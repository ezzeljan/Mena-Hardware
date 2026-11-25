import { describe, expect, it } from 'vitest'
import ExcelJS from 'exceljs'
import { applyFlagRules, markByOthers, type FlagDoor } from '@/features/projects/doorFlags'
import { applyHingeType, hingeTypeOf } from '@/features/projects/hingeRules'
import { parseQuotationWorkbook } from '@/features/projects/quotationParser'
import type { SizingLine, SizingPart } from '@/features/projects/doorSizing'

const part = (id: string, sku: string, description: string, supplier_id = 'mm'): SizingPart => ({
  id, sku, legend: '', description, supplier_id, unit_cost: 5, active: true,
})
const PARTS: SizingPart[] = [
  part('bb', 'MMHINGE', 'HINGES 100X100 4BB BLACK'),
  part('lo', 'MMHINGELIFTOFF', 'LIFT OFF HINGE WITH SCREWS'),
  part('lo75', 'MMHINGELOFF', 'LIFT OFF 100X75X2.5 LOL HINGE 304 WITH SCREWS'),
  part('fp', 'LW10000FPSSS', 'LOCKWOOD HINGES 100X100X2.5MM FIXED PIN SSS', 'lw'),
  part('stop', 'MMDOORSTOP', '290 DOOR STOP FLOOR MOUNT'),
  part('es', 'ELECTRICSTRIKE', 'ELECTRIC STRIKE BY SECURITY CONTRACTOR'),
]
type Line = SizingLine & { origin: 'set' | 'added'; mhqt_remarks?: string }
const make = (p: SizingPart, qty: number): Line => ({
  sku: p.sku, description: p.description, qty_per_door: qty, unit_price: p.unit_cost, part_id: p.id, origin: 'added',
})
const line = (p: SizingPart, qty: number): Line => ({ ...make(p, qty), origin: 'set' })
const door = (hardware: string, comments = ''): FlagDoor => ({ qty: 1, hardware, comments })

describe('hinge type (Hinge column)', () => {
  it('reads LO and BH', () => {
    expect(hingeTypeOf('Closer · Hinge: LO')?.name).toBe('Lift Off')
    expect(hingeTypeOf('Hinge: BH · Lock')?.name).toBe('Ball Bearing')
    expect(hingeTypeOf('Hinge: XX')).toBeUndefined()
  })

  it('swaps the set hinge for a lift off one (same supplier, same size), keeping the count', () => {
    const r = applyHingeType([line(PARTS[0], 3)], 'Hinge: LO', PARTS, make)
    expect(r.lines.map((l) => [l.sku, l.qty_per_door])).toEqual([['MMHINGELIFTOFF', 3]])
    expect(r.notes).toEqual(['Hinge: LO (Lift Off): MMHINGE → MMHINGELIFTOFF'])
  })

  it('swaps a fixed pin hinge for a ball bearing one; leaves a matching hinge alone', () => {
    expect(applyHingeType([line(PARTS[3], 4)], 'Hinge: BH', PARTS, make).lines[0].sku).toBe('MMHINGE')
    const same = applyHingeType([line(PARTS[0], 3)], 'Hinge: BH', PARTS, make)
    expect(same.lines[0].origin).toBe('set')
    expect(same.notes).toEqual([])
  })
})

describe('cost columns decide over HW columns', () => {
  it('a Stop column without a STOP cost is only a note', () => {
    const r = applyFlagRules([], [door('Stop: DS · Closer: CL')], 1, PARTS, make, {
      costColumns: ['stop', 'closer'],
      activities: {},
    })
    expect(r.lines).toEqual([])
    expect(r.notes).toEqual([
      'Self Closing column says "CL" but there\'s no CLOSER cost — not added (option: add it by hand)',
      'Stop column says "DS" but there\'s no STOP cost — not added (option: add it by hand)',
    ])
  })

  it('with a STOP cost the Stop column adds nothing more (the cost added it); without the column it still adds', () => {
    const priced = applyFlagRules([], [door('Stop: DS · Prep: Stop')], 1, PARTS, make, {
      costColumns: ['stop'],
      activities: { stop: 1 },
    })
    expect(priced.lines).toEqual([])
    expect(priced.notes).toEqual([])
    expect(applyFlagRules([], [door('Stop: DS')], 1, PARTS, make).lines.map((l) => l.sku)).toEqual(['MMDOORSTOP'])
  })
})

describe('electrical items and confirmation comments', () => {
  it('electrical lines get no price and BY OTHERS', () => {
    const r = markByOthers([line(PARTS[5], 1), line(PARTS[0], 3)], PARTS)
    expect(r.lines.map((l) => [l.sku, l.unit_price, l.mhqt_remarks])).toEqual([
      ['ELECTRICSTRIKE', 0, 'BY OTHERS'],
      ['MMHINGE', 5, undefined],
    ])
  })

  it('a comment needing confirmation flags the group', () => {
    const r = applyFlagRules([], [door('', 'NEED CONFIRMATION IF DOOR IS INCLUDED | ADDITIONAL DOOR (NCL)')], 1, PARTS, make)
    expect(r.notes).toEqual(['Needs confirmation: "NEED CONFIRMATION IF DOOR IS INCLUDED" — counted, check with the builder'])
  })

  it('the parser counts the door and warns', async () => {
    const wb = new ExcelJS.Workbook()
    const ws = wb.addWorksheet('Quotation Test')
    ws.addRow(['MENA CONTRACTORS PTY LTD'])
    ws.addRow(['DOOR SCHEDULE'])
    ws.addRow(['LOCATION'])
    ws.addRow(['Door Level', 'Door Type', 'Door Apt #', 'Room Name', 'Frame Type', 'FRL', 'Leaf Type', 'Leaf Height', 'Leaf 1 Width', 'Leaf 2 Width', 'Leafs', 'Mena Contractors Comments', 'QTY'])
    ws.addRow([])
    ws.addRow(['L1', 'D-01', 'A1', 'Store', 'ST', '-/-/-', 'SC1', 2040, 820, '-', 1, 'NEED CONFIRMATION IF DOOR IS INCLUDED', 1])
    const res = await parseQuotationWorkbook((await wb.xlsx.writeBuffer()) as ArrayBuffer)
    expect(res.doors).toHaveLength(1)
    expect(res.issues.some((i) => i.row === 6 && i.message.startsWith('Needs confirmation'))).toBe(true)
  })
})

describe('review fixes', () => {
  it('NON-ELECTRIC parts keep their price; parts in the by-others folder are BY OTHERS', () => {
    const nonElectric = part('ne', 'NESTRIKE', 'NON-ELECTRIC STRIKE SSS')
    const ctd = { ...part('ctd', 'LC8810', '277MM LEAD COVER'), folder: 'Electronic & security (by others)' }
    const plated = part('pl', 'PULL', 'PULL HANDLE ELECTROPLATED')
    const r = markByOthers([line(nonElectric, 1), line(ctd, 1), line(plated, 1)], [nonElectric, ctd, plated])
    expect(r.lines.map((l) => [l.sku, l.unit_price, l.mhqt_remarks])).toEqual([
      ['NESTRIKE', 5, undefined],
      ['LC8810', 0, 'BY OTHERS'],
      ['PULL', 5, undefined],
    ])
  })

  it('a swapped hinge stays the set line and keeps the set price when the new part has none', () => {
    const noCost = { ...PARTS[1], unit_cost: null }
    const set = { ...line(PARTS[0], 3), unit_price: 4.5 }
    const r = applyHingeType([set], 'Hinge: LO', [PARTS[0], noCost], make)
    expect(r.lines[0]).toMatchObject({ sku: 'MMHINGELIFTOFF', origin: 'set', unit_price: 4.5, qty_per_door: 3 })
  })
})
