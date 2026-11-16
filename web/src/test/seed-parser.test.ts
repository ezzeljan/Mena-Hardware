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

  it('parses all standard sets, parts, and flags the KITCHEN (FIRE RATED - PIVOT) data issue', () => {
    const result = parseHardwareWorkbook(xlsxPath)
    console.log('\n' + formatSeedReport(result))

    expect(result.sets.length).toBeGreaterThan(0)
    expect(result.dataIssues.length).toBe(1)
    expect(result.dataIssues[0]?.room_name).toBe('KITCHEN')
    expect(result.dataIssues[0]?.classification).toBe('FIRE RATED - PIVOT')

    // Ensure the 2 MM parts with no unit price remain null, not 0
    const closer1 = result.parts.find((p) => p.sku === '505BC+SLC')
    const closer2 = result.parts.find((p) => p.sku === 'L505 BC')
    expect(closer1?.unit_cost).toBeNull()
    expect(closer2?.unit_cost).toBeNull()
    expect(closer1?.manufacturer).toBe('MM')
  })
})
