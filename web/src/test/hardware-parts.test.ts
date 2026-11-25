import { describe, expect, it } from 'vitest'
import ExcelJS from 'exceljs'
import { hardwareParts } from '@/features/projects/hardwareParts'
import { parseQuotationWorkbook } from '@/features/projects/quotationParser'

const HEADERS: Array<[string, string]> = [
  ['Closer', 'Self Closing'],
  ['Hinge', 'Hinge'],
  ['Lock', 'Lock'],
  ['Stop', 'Stop'],
  ['Reed switch', 'Reed Switch'],
  ['ES', 'Electric Strike'],
  ['Keying', 'Keying'],
]

describe('hardwareParts', () => {
  it('groups builder hardware (named as in the quotation), comment items and prep / install', () => {
    const parts = hardwareParts(
      'Closer: CL · Hinge: LO · Lock · Stop: DS · ES: ES · Keying · Kick plate · Extra hinge ×1 · Prep: Stop, Closer ×2 · Lock prep: 25',
      HEADERS,
    )
    expect(parts.builder).toEqual([
      { header: 'Self Closing', value: 'CL' },
      { header: 'Hinge', value: 'LO' },
      { header: 'Lock', value: null },
      { header: 'Stop', value: 'DS' },
      { header: 'Electric Strike', value: 'ES' },
      { header: 'Keying', value: null },
    ])
    expect(parts.comments).toEqual(['Kick plate'])
    expect(parts.prep).toEqual(['Extra hinge ×1', 'Stop', 'Closer ×2', 'Lock prep: 25'])
    expect(hardwareParts('', HEADERS)).toEqual({ builder: [], comments: [], prep: [] })
  })

  it('adds each prep / install item its cell value', () => {
    const parts = hardwareParts(
      'Closer: CL · Extra hinge ×1 · Prep: Stop, Closer ×2 · Lock prep: 25',
      HEADERS,
      { Stop: '15', Closer: '44', 'Extra hinge': '9' },
    )
    expect(parts.prep).toEqual(['Extra hinge ×1: 9', 'Stop: 15', 'Closer ×2: 44', 'Lock prep: 25'])
  })

  it('the parser keeps each HW column header as written', async () => {
    const wb = new ExcelJS.Workbook()
    const ws = wb.addWorksheet('Quotation Test')
    ws.addRow(['MENA CONTRACTORS PTY LTD'])
    ws.addRow(['DOOR SCHEDULE'])
    ws.addRow(['LOCATION'])
    ws.addRow(['Door Level', 'Door Type', 'Door Apt #', 'Room Name', 'Frame Type', 'FRL', 'Leaf Type', 'Leaf Height', 'Leaf 1 Width', 'Leaf 2 Width', 'Leafs', 'Self Closing', 'Door Grille', 'Lock', 'QTY', 'STOP', 'CLOSER'])
    ws.addRow([])
    ws.addRow(['L1', 'D-01', 'A1', 'Store', 'ST', '-/-/-', 'SC1', 2040, 820, '-', 1, 'CL', 'DG', 'YES', 1, 15, 22])
    ws.addRow(['L1', 'D-02', 'A1', 'Store', 'ST', '-/-/-', 'SC1', 2040, 820, '-', 1, 'CL', 'DG', 'YES', 1, 15, 22])
    const res = await parseQuotationWorkbook((await wb.xlsx.writeBuffer()) as ArrayBuffer)
    expect(res.hardwareHeaders).toEqual([
      ['Closer', 'Self Closing'],
      ['Grille', 'Door Grille'],
      ['Lock', 'Lock'],
    ])
    expect(hardwareParts(res.doors[0].hardware, res.hardwareHeaders).builder).toEqual([
      { header: 'Self Closing', value: 'CL' },
      { header: 'Door Grille', value: 'DG' },
      { header: 'Lock', value: null },
    ])
    expect(res.doors[0].prep_values).toEqual({ Stop: '15', Closer: '22' })
    expect(res.groups[0].prep_values).toEqual({ Stop: '15', Closer: '22' })
    expect(hardwareParts(res.groups[0].hardware, res.hardwareHeaders, res.groups[0].prep_values).prep).toEqual([
      'Stop: 15',
      'Closer: 22',
    ])
  })
})
