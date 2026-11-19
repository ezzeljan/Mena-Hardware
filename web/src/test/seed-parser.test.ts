import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  formatSeedReport,
  inferManufacturer,
  parseHardwareWorkbook,
} from '../../../supabase/seed/parser'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const xlsxPath = path.resolve(__dirname, '../../../DOOR_HARDWARE_SET_1.xlsx')

describe('Door Hardware Seed Parser', () => {
  it('infers manufacturer according to brief rules', () => {
    expect(inferManufacturer('MMHNG100100BB', 'HINGES 100X100 4BB BLACK')).toBe('MM')
    expect(inferManufacturer('505BC+SLC', 'SLIDING ARM DOOR CLOSER', true)).toBe('MM')
    expect(inferManufacturer('6125SSS', 'NOVAS 6000 SERIES VESTIBULE LOCK')).toBe('NOVAS')
    expect(inferManufacturer('LW160CPDP', 'LOCKWOOD 160 DOOR VIEWER CP')).toBe('LOCKWOOD')
    expect(inferManufacturer('BB03.300SC.B', 'SCOPE NECKED BARREL BOLT')).toBe('SCOPE')
    expect(inferManufacturer('TS2000SNVBCSIL', 'GEZE 1 - 4 DOOR CLOSER')).toBe('GEZE')
    expect(inferManufacturer('FES20', 'FSH HIGH SECURITY MONITORED ELECTRIC STRIKE')).toBe('FSH')
    expect(inferManufacturer('VINGCARDLOCK', 'VINGCARD RFID LOCK TO BE SUPPLIED BY OTHERS')).toBe(
      'OTHER',
    )
  })

  it('parses all 65 standard sets, preserves null unit costs, and reports only genuine SKU mismatches', async () => {
    const result = await parseHardwareWorkbook(xlsxPath)
    console.log('\n' + formatSeedReport(result))

    expect(result.sets.length).toBe(65)
    expect(result.parts.length).toBe(59)
    expect(result.dataIssues.length).toBe(0)

    // Ensure the 2 MM parts with no unit price remain null, not 0
    const closer1 = result.parts.find((p) => p.sku === '505BC+SLC')
    const closer2 = result.parts.find((p) => p.sku === 'L505 BC')
    expect(closer1?.unit_cost).toBeNull()
    expect(closer2?.unit_cost).toBeNull()
    expect(closer1?.manufacturer).toBe('MM')

    // Ensure KITCHEN (FIRE RATED - PIVOT) parts are now included since SKUs match descriptions
    expect(result.parts.find((p) => p.sku === 'STRAIGHTPULL')?.description).toBe('STRAIGHT PULL')
    expect(result.parts.find((p) => p.sku === 'FLRSPRGNHODC')?.description).toBe(
      'FLOOR SPRING NHO HO & DA COMPLETE',
    )
  })
})
