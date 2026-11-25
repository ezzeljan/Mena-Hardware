import { describe, expect, it } from 'vitest'
import ExcelJS from 'exceljs'
import { isGreenFill, isGreenRgb, isRedFill, isRedRgb, themeColorsOf } from '@/features/projects/rowColor'
import { changeCounts, compareDoors, type DoorRecord } from '@/features/projects/doorChanges'
import { parseQuotationWorkbook } from '@/features/projects/quotationParser'

const THEME_2007 = `<a:clrScheme name="Office"><a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="1F497D"/></a:dk2><a:lt2><a:srgbClr val="EEECE1"/></a:lt2><a:accent1><a:srgbClr val="4F81BD"/></a:accent1><a:accent2><a:srgbClr val="C0504D"/></a:accent2><a:accent3><a:srgbClr val="9BBB59"/></a:accent3><a:accent4><a:srgbClr val="8064A2"/></a:accent4><a:accent5><a:srgbClr val="4BACC6"/></a:accent5><a:accent6><a:srgbClr val="F79646"/></a:accent6></a:clrScheme>`

describe('green rows', () => {
  it('knows green from yellow, blue and orange', () => {
    expect(['00B050', '92D050', '9BBB59', '70AD47'].map(isGreenRgb)).toEqual([true, true, true, true])
    expect(['FFFF00', '00B0F0', 'F79646', 'FF0000', 'FFFFFF', '4F81BD'].map(isGreenRgb)).toEqual([false, false, false, false, false, false])
  })

  it('knows red from orange, pink and yellow; a pale theme red is not a red highlight', () => {
    expect(['FF0000', 'C00000', 'E6194B'].map(isRedRgb)).toEqual([true, true, true])
    expect(['F79646', 'FFC000', 'FFFF00', 'FF00FF', '00B050'].map(isRedRgb)).toEqual([false, false, false, false, false])
    const theme = themeColorsOf(THEME_2007)
    const fill = (fgColor: object) => ({ type: 'pattern', pattern: 'solid', fgColor })
    expect(isRedFill(fill({ argb: 'FFFF0000' }), theme)).toBe(true)
    expect(isRedFill(fill({ theme: 5 }), theme)).toBe(true) // accent 2 (C0504D)
    expect(isRedFill(fill({ theme: 5, tint: 0.8 }), theme)).toBe(false) // pale pink
  })

  it('reads RGB and theme fills (theme 6 = accent 3, green in the 2007 theme)', () => {
    const theme = themeColorsOf(THEME_2007)
    expect(theme.slice(0, 4)).toEqual(['FFFFFF', '000000', 'EEECE1', '1F497D'])
    const fill = (fgColor: object) => ({ type: 'pattern', pattern: 'solid', fgColor })
    expect(isGreenFill(fill({ argb: 'FF00B050' }), theme)).toBe(true)
    expect(isGreenFill(fill({ theme: 6, tint: 0.8 }), theme)).toBe(true)
    expect(isGreenFill(fill({ theme: 4, tint: 0.8 }), theme)).toBe(false)
    expect(isGreenFill(fill({ argb: 'FFFFFF00' }), theme)).toBe(false)
    expect(isGreenFill(undefined, theme)).toBe(false)
  })

  it('marks doors on green rows: QTY 1 is added, no QTY is not counted', async () => {
    const wb = new ExcelJS.Workbook()
    const ws = wb.addWorksheet('Quotation Test')
    ws.addRow(['MENA CONTRACTORS PTY LTD'])
    ws.addRow(['DOOR SCHEDULE'])
    ws.addRow(['LOCATION'])
    ws.addRow(['Door Level', 'Door Type', 'Door Apt #', 'Room Name', 'Frame Type', 'FRL', 'Leaf Type', 'Leaf Height', 'Leaf 1 Width', 'Leaf 2 Width', 'Leafs', 'QTY'])
    ws.addRow([])
    ws.addRow(['L1', 'D-01', 'A1', 'Bedroom', 'ST', '-/-/-', 'SC1', 2040, 820, '-', 1, 1])
    const green = (r: ExcelJS.Row) =>
      r.eachCell({ includeEmpty: true }, (c) => {
        c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF92D050' } }
      })
    green(ws.addRow(['L1', 'D-02', 'A2', 'Study', 'ST', '-/-/-', 'SC1', 2040, 820, '-', 1, 1]))
    green(ws.addRow(['L1', 'D-03', 'A3', 'Store', 'ST', '-/-/-', 'SC1', 2040, 820, '-', 1, null]))
    const red = ws.addRow(['L1', 'D-04', 'A4', 'Linen', 'ST', '-/-/-', 'SC1', 2040, 620, '-', 1, 1])
    red.eachCell({ includeEmpty: true }, (c) => {
      c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFF0000' } }
    })
    const res = await parseQuotationWorkbook((await wb.xlsx.writeBuffer()) as ArrayBuffer)
    expect(res.doors.map((d) => [d.door_tag, d.variation])).toEqual([
      ['D-01', false],
      ['D-02', true],
    ])
    expect(res.totalDoorQty).toBe(2)
    expect(res.variationRows).toEqual([
      { row: 7, rawRef: 'L1 · A2 · D-02', room_name: 'Study', qty: 1, kind: 'added' },
      { row: 8, rawRef: 'L1 · A3 · D-03', room_name: 'Store', qty: null, kind: 'added' },
      { row: 9, rawRef: 'L1 · A4 · D-04', room_name: 'Linen', qty: 1, kind: 'removed' },
    ])
    // The red row is excluded even with QTY 1 (and can be included back).
    expect(res.excluded.map((e) => [e.row, e.qty, e.reason])).toEqual([[9, 1, 'Red row: "excluded in variation"']])
    expect(res.excluded[0].door).not.toBeNull()
    expect(res.report).toMatchObject({ variationRowCount: 3, variationDoorsAdded: 1, variationDoorsRemoved: 1 })
  })
})

const door = (ref: string, room: string, size: string, qty = 1, row = 1, variation = false): DoorRecord => ({
  door_ref: ref, room_name: room, classification: 'NON RATED', leaf: 'SINGLE', door_size: size, qty, source_row: row, variation,
})

describe('doors compared with the previous upload', () => {
  it('finds added, removed and changed doors', () => {
    const before = [
      door('L1 · A1 · D-01', 'Bedroom', '2040x820', 1, 10),
      door('L1 · A2 · D-02', 'Store', '2040x820', 1, 11),
      door('L1 · A3 · D-03', 'Laundry', '2040x720', 2, 12),
      door('L2 · A4 · D-04', 'Linen', '2040x620', 1, 13),
    ]
    const after = [
      door('L1 · A1 · D-01', 'BEDROOM', '2040x820', 1, 20), // same (capitals don't matter)
      door('L1 · A3 · D-03', 'Laundry', '2040x720', 3, 21), // one more
      door('L2 · A4 · D-04', 'Linen', '2040x770', 1, 22), // other size
      door('L2 · A5 · D-05', 'Study', '2040x820', 1, 23, true), // new, in the variation
    ]
    const c = compareDoors(before, after)
    expect(c.added.map((d) => [d.door_ref, d.qty, d.variation])).toEqual([
      ['L1 · A3 · D-03', 1, false],
      ['L2 · A5 · D-05', 1, true],
    ])
    expect(c.removed.map((d) => [d.door_ref, d.row])).toEqual([['L1 · A2 · D-02', 11]])
    expect(c.changed.map((x) => [x.before.door_size, x.after.door_size])).toEqual([['2040x620', '2040x770']])
    expect(c).toMatchObject({ previousTotal: 5, currentTotal: 6, unchangedQty: 3 })
    expect(changeCounts(c)).toEqual({ added: 2, addedInVariation: 1, removed: 1, changed: 1 })
  })

  it('no changes', () => {
    const doors = [door('L1 · A1 · D-01', 'Bedroom', '2040x820')]
    expect(changeCounts(compareDoors(doors, doors))).toEqual({ added: 0, addedInVariation: 0, removed: 0, changed: 0 })
  })
})

describe('compareDoors without a door ref', () => {
  it('reports added and removed, not changed', () => {
    const d = (size: string, row: number) => ({ door_ref: '', room_name: 'WC', classification: 'NR', leaf: 'SINGLE', door_size: size, qty: 1, source_row: row })
    const c = compareDoors([d('2040x820', 5)], [d('2040x920', 6)])
    expect(c.changed).toEqual([])
    expect(c.added.map((x) => x.door_size)).toEqual(['2040x920'])
    expect(c.removed.map((x) => x.door_size)).toEqual(['2040x820'])
  })
})
