import { describe, expect, it } from 'vitest'
import ExcelJS from 'exceljs'
import type { DoorGroup, ProjectLine, ProjectVersion } from '@/types/database'
import { buildProjectExportWorkbook } from '@/features/projects/projectExcelExport'

describe('buildProjectExportWorkbook', () => {
  it('exports DOOR HARDWARE SET layout with markup, formulas, blank prices, and green added rows', async () => {
    const version: ProjectVersion = {
      id: 'v1',
      project_id: 'p1',
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
        position: 1,
        sku: 'MMHINGE',
        description: 'HINGES 100X100',
        qty_per_door: 3,
        unit_price: 4,
        origin: 'set',
        part_id: null,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
      },
      {
        id: 'l2',
        group_id: 'g1',
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

    const buf = await buildProjectExportWorkbook({
      projectName: 'SV002 — McLaren St',
      builderName: 'DECODE',
      version,
      groups,
      lines,
    })

    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(buf)
    const ws = wb.getWorksheet('HARDWARE')
    expect(ws).toBeDefined()

    expect(ws!.getCell('I2').value).toBe(0.15)
    expect(ws!.getCell('H3').value).toBe(2)

    // Header row 4
    expect(ws!.getCell('A4').value).toBe('ROOM NAME')
    expect(ws!.getCell('B4').value).toBe('DOOR TAG')
    expect(ws!.getCell('K4').value).toBe('COST + MARKUP')
    expect(ws!.getCell('L4').value).toBe('PM REMARKS')

    // Group row 5
    expect(ws!.getCell('A5').value).toBe('BATHROOM')
    expect(ws!.getCell('B5').value).toBe('DR-002')
    expect(ws!.getCell('H5').value).toBe(2)
    expect(ws!.getCell('L5').value).toBe('Check hinge finish')
    expect((ws!.getCell('J5').value as { result: number }).result).toBe(24)
    expect((ws!.getCell('K5').value as { result: number }).result).toBeCloseTo(27.6, 4)

    // Line 1 (set) row 6
    expect(ws!.getCell('F6').value).toBe('MMHINGE')
    expect(ws!.getCell('I6').value).toBe(4)

    // Line 2 (added, blank price) row 7
    expect(ws!.getCell('F7').value).toBe('CUSTOMSEAL')
    expect(ws!.getCell('I7').value).toBeNull()
    expect(ws!.getCell('J7').value).toBeNull()
    // ...and is flagged, so it isn't mistaken for $0
    expect((ws!.getCell('I7').fill as ExcelJS.FillPattern).fgColor?.argb).toBe('FFFEF3C7')
    // Grand total uses a short SUMIF over the group rows (no formula-length limit)
    expect((ws!.getCell('J3').value as { formula: string }).formula).toMatch(/^SUMIF\(G5:G\d+,"DOOR QTY:",J5:J\d+\)$/)
    expect((ws!.getCell('F7').fill as ExcelJS.FillPattern).fgColor?.argb).toBe('FFDCFCE7')
  })
})
