import { describe, expect, it } from 'vitest'
import ExcelJS from 'exceljs'
import type { DoorGroup, ProjectLine, ProjectVersion } from '@/types/database'
import { buildProjectExportWorkbook, worksheetNames } from '@/features/projects/projectExcelExport'

describe('buildProjectExportWorkbook', () => {
  it('exports the NOVAS Template layout with markup, formulas, blank prices, and green added rows', async () => {
    const version: ProjectVersion = {
      id: 'v1',
      project_id: 'p1',
      quote_id: 'q1',
      version_no: 1,
      status: 'approved',
      upload_id: null,
      markup_pct: 15,
      created_by: 'u1',
      submitted_at: null,
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    }

    const groups: DoorGroup[] = [
      {
        id: 'g1',
        version_id: 'v1',
        position: 1,
        group_key: 'DR-002 | BATHROOM | NON RATED | SINGLE | 2040x920',
        door_tag: 'DR-002',
        room_name: 'BATHROOM',
        classification: 'NON RATED',
        leaf: 'SINGLE',
        door_size: '2040x920',
        door_qty: 2,
        matched_set_id: null,
        match_status: 'confirmed',
        match_score: 1,
        match_reason: '',
        pm_remarks: 'Check hinge finish',
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
      },
    ]

    const lines: ProjectLine[] = [
      {
        id: 'l1',
        group_id: 'g1',
        sheet_id: 's1',
        position: 1,
        sku: 'MMHINGE',
        description: 'HINGES 100X100',
        qty_per_door: 3,
        unit_price: 4,
        origin: 'set',
        part_id: null,
        mhqt_remarks: 'Supply only',
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
      },
      {
        id: 'l2',
        group_id: 'g1',
        sheet_id: 's1',
        position: 2,
        sku: 'CUSTOMSEAL',
        description: 'ADDED DROP SEAL',
        qty_per_door: 1,
        unit_price: null, // blank price must remain empty, never 0
        origin: 'added',
        part_id: null,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
      },
    ]

    const parts = [
      { id: 'p-hinge', sku: 'MMHINGE', suppliers: { id: 'm1', name: 'MM', is_owner_supplied: true } },
      { id: 'p-seal', sku: 'CUSTOMSEAL', legend: 'BWS', suppliers: { id: 'm2', name: 'NOVAS', is_owner_supplied: false } },
    ]

    const buf = await buildProjectExportWorkbook({
      projectName: 'SV002 — McLaren St',
      projectTitle: 'Rozelle Village (Upper Levels)',
      clientName: 'Versatile',
      scheduleNo: '9/9/2026',
      version,
      groups,
      lines,
      parts,
    })

    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(buf)
    const ws = wb.getWorksheet('HARDWARE')
    expect(ws).toBeDefined()
    const result = (ref: string) => (ws!.getCell(ref).value as { result: number }).result
    const formula = (ref: string) => (ws!.getCell(ref).value as { formula: string }).formula

    // Rows 1-4, as in the NOVAS Template
    expect(ws!.getCell('A1').value).toBe('NOVAS HARDWARE - SATIN STAINLESS STEEL')
    expect(ws!.getCell('A2').value).toBe('Project:')
    expect(ws!.getCell('B2').value).toBe('ROZELLE VILLAGE (UPPER LEVELS)')
    expect(ws!.getCell('A3').value).toBe('Client:')
    expect(ws!.getCell('B3').value).toBe('VERSATILE')
    expect(ws!.getCell('A4').value).toBe('Schedule #:')
    expect(ws!.getCell('B4').value).toEqual(new Date(Date.UTC(2026, 8, 9)))
    expect(ws!.getCell('B4').numFmt).toBe('mm-dd-yy')
    expect(ws!.getCell('F2').value).toBe('MARKUP')
    expect(ws!.getCell('F3').value).toBe(0.15)
    expect(ws!.getCell('D4').value).toBe('OVERALL DOOR QTY:')
    expect(formula('E4')).toBe('SUMIF($D$6:$D$8,"DOOR QTY:",$E$6:$E$8)')
    expect(result('E4')).toBe(2)
    expect(ws!.getCell('J4').value).toBe('DELIVERIES')
    expect(formula('K4')).toBe('+E4*1.5')
    expect(result('K4')).toBe(3)
    expect(ws!.getCell('K2').value).toBe('TOTAL EX. GST')
    expect(formula('K3')).toBe('SUM(K4:K8)')
    // 2 doors × (3 × $4 × 1.15) + $3 deliveries
    expect(result('K3')).toBeCloseTo(30.6, 4)
    expect(formula('G3')).toBe('K3/(1+F3)')
    expect(formula('G4')).toBe('K3-G3')

    // Table header row 5
    expect(ws!.getRow(5).values).toEqual([
      undefined,
      'LEGEND', 'SUPPLIER', 'PART NUMBER', 'DESCRIPTION', 'QTY', 'Cost', 'Cost Door', 'Price',
      'Price Door', 'Hardware Price \nper Door Type', 'Overall HW Price \nper Typical Door',
      'Total Items \nper Typical Door', 'MHQT  REMARKS',
    ])

    // Door group row 6 (no PM remarks column any more)
    expect(ws!.getCell('A6').value).toBe('BATHROOM')
    expect(ws!.getCell('B6').value).toBe('DR-002')
    expect(ws!.getCell('C6').value).toBe('SINGLE NON RATED')
    expect(ws!.getCell('D6').value).toBe('DOOR QTY:')
    expect(ws!.getCell('E6').value).toBe(2)
    expect(formula('G6')).toBe('SUM(G7:G8)')
    expect(result('G6')).toBe(12)
    expect(formula('I6')).toBe('SUM(I7:I8)')
    expect(result('I6')).toBeCloseTo(13.8, 4)
    expect(formula('J6')).toBe('I6')
    expect(formula('K6')).toBe('E6*I6')
    expect(result('K6')).toBeCloseTo(27.6, 4)
    expect(ws!.getCell('M6').value).toBeNull()

    // Line 1 (owner-supplied set item) row 7
    expect(ws!.getCell('A7').value).toBe('MM')
    expect(ws!.getCell('B7').value).toBe('MM')
    expect(ws!.getCell('C7').value).toBe('MMHINGE')
    expect(ws!.getCell('D7').value).toBe('HINGES 100X100')
    expect(ws!.getCell('E7').value).toBe(3)
    expect(ws!.getCell('F7').value).toBe(4)
    expect(formula('G7')).toBe('IFERROR(E7*F7,"")')
    expect(formula('H7')).toBe('F7*(1+$F$3)')
    expect(formula('I7')).toBe('E7*H7')
    expect(formula('L7')).toBe('E7*$E$6')
    expect(result('L7')).toBe(6)
    expect(ws!.getCell('M7').value).toBe('Supply only')

    // Line 2 (added, blank price) row 8: price cells stay empty and are flagged;
    // LEGEND is the part's legend code.
    expect(ws!.getCell('A8').value).toBe('BWS')
    expect(ws!.getCell('B8').value).toBe('NOVAS')
    expect(ws!.getCell('C8').value).toBe('CUSTOMSEAL')
    expect(ws!.getCell('F8').value).toBeNull()
    expect(ws!.getCell('I8').value).toBeNull()
    expect((ws!.getCell('F8').fill as ExcelJS.FillPattern).fgColor?.argb).toBe('FFFEF3C7')
    expect((ws!.getCell('C8').fill as ExcelJS.FillPattern).fgColor?.argb).toBe('FFDCFCE7')

    expect(ws!.getCell('A1').isMerged).toBe(true)
  })

  it('writes one worksheet per supplier sheet with its own lines and totals', async () => {
    const version: ProjectVersion = {
      id: 'v1',
      project_id: 'p1',
      quote_id: 'q1',
      version_no: 2,
      status: 'draft',
      upload_id: null,
      markup_pct: 0,
      created_by: 'u1',
      submitted_at: null,
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    }
    const group: DoorGroup = {
      id: 'g1',
      version_id: 'v1',
      position: 1,
      group_key: 'ENTRY',
      door_tag: '',
      room_name: 'ENTRY',
      classification: '',
      leaf: 'SINGLE',
      door_size: '',
      door_qty: 1,
      matched_set_id: null,
      match_status: 'confirmed',
      match_score: 1,
      match_reason: '',
      pm_remarks: '',
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    }
    const line = (id: string, sheet: string, sku: string, price: number): ProjectLine => ({
      id,
      group_id: 'g1',
      sheet_id: sheet,
      position: 1,
      sku,
      description: sku,
      qty_per_door: 1,
      unit_price: price,
      origin: 'set',
      part_id: null,
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    })

    const buf = await buildProjectExportWorkbook({
      projectName: 'SV002',
      clientName: 'Acme Builders',
      scheduleNo: '9/9/2026',
      version,
      groups: [group],
      lines: [line('a', 'sA', 'ALPHA-1', 10), line('b', 'sB', 'BETA-1', 20)],
      sheets: [
        { id: 'sA', name: 'Alpha Supplies' },
        { id: 'sB', name: 'Beta / Co' },
      ],
    })

    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(buf)
    expect(wb.worksheets.map((w) => w.name)).toEqual(['Alpha Supplies', 'Beta Co'])
    const alpha = wb.getWorksheet('Alpha Supplies')!
    const beta = wb.getWorksheet('Beta Co')!
    expect(alpha.getCell('C7').value).toBe('ALPHA-1')
    expect(beta.getCell('C7').value).toBe('BETA-1')
    expect(beta.getCell('B3').value).toBe('ACME BUILDERS')
    // 1 door × $20 + $1.50 delivery
    expect((beta.getCell('K3').value as { result: number }).result).toBeCloseTo(21.5, 4)
  })
})

describe('worksheetNames', () => {
  it('removes characters Excel rejects, shortens to 31 and keeps names unique', () => {
    expect(worksheetNames(['A/B', 'a b', 'x'.repeat(40), '', "'quoted'"])).toEqual([
      'A B',
      'a b (2)',
      'x'.repeat(31),
      'Sheet 4',
      'quoted',
    ])
  })
})
