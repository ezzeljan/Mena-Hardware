import { describe, expect, it } from 'vitest'
import {
  supplierSchema,
  nullablePriceSchema,
  parseNullablePriceInput,
  partFormSchema,
  projectFormSchema,
  standardSetLineSchema,
  standardSetSchema,
} from '@/lib/schemas'
import { formatCurrency } from '@/lib/utils'

describe('Shared Zod Schemas & Price Parsing', () => {
  it('preserves intentional null for blank unit_cost and unit_price (never defaults to 0)', () => {
    expect(parseNullablePriceInput('')).toBeNull()
    expect(parseNullablePriceInput('   ')).toBeNull()
    expect(nullablePriceSchema.parse(null)).toBeNull()
    expect(nullablePriceSchema.parse(undefined)).toBeNull()
  })

  it('parses valid 0 and decimal prices accurately', () => {
    expect(parseNullablePriceInput('0')).toBe(0)
    expect(parseNullablePriceInput('37.527')).toBe(37.527)
    expect(parseNullablePriceInput('239.22')).toBe(239.22)
  })

  it('rejects negative or non-numeric prices', () => {
    expect(() => parseNullablePriceInput('-5')).toThrow()
    expect(() => parseNullablePriceInput('abc')).toThrow()
  })

  it('uppercases supplier names and validates owner-supplied flag', () => {
    const parsed = supplierSchema.parse({
      name: '  novas ',
      is_owner_supplied: false,
    })
    expect(parsed.name).toBe('NOVAS')
    expect(parsed.is_owner_supplied).toBe(false)
  })

  it('validates part form with blank unit_cost', () => {
    const valid = partFormSchema.safeParse({
      sku: '505BC+SLC',
      supplier_id: '00000000-0000-0000-0000-000000000001',
      description: 'SLIDING ARM DOOR CLOSER',
      unit_cost: '',
      active: true,
      folder_id: '',
      legend: 'C2',
    })
    expect(valid.success).toBe(true)

    const tooLong = partFormSchema.safeParse({
      sku: 'X',
      supplier_id: '00000000-0000-0000-0000-000000000001',
      description: 'X',
      unit_cost: '',
      active: true,
      folder_id: 'not-a-folder',
      legend: 'X'.repeat(21),
    })
    expect(tooLong.success).toBe(false)
  })

  it('validates standard set and line forms', () => {
    const setValid = standardSetSchema.safeParse({
      room_name: 'UNIT ENTRY',
      classification: 'FIRE RATED',
      leaf: 'SINGLE',
      door_size: '2040 x 920',
      active: true,
    })
    expect(setValid.success).toBe(true)

    const lineValid = standardSetLineSchema.safeParse({
      sku: '6125SSS',
      description: 'NOVAS 6000 SERIES VESTIBULE LOCK',
      qty: '2',
      unit_price: '',
    })
    expect(lineValid.success).toBe(true)
  })

  it('formats null currency as em-dash', () => {
    expect(formatCurrency(null)).toBe('—')
    expect(formatCurrency(undefined)).toBe('—')
    expect(formatCurrency(54)).toContain('54.00')
  })

  it('validates project form schema', () => {
    const valid = projectFormSchema.safeParse({
      reference_no: 'SV002',
      name: 'Harborview Apartments',
      client: 'Mena Contractors',
      site: 'Sydney CBD',
      status: 'active',
      stage: 'tender',
      assigned_pm: '',
    })
    expect(valid.success).toBe(true)

    const badStage = projectFormSchema.safeParse({
      reference_no: '',
      name: 'Harborview Apartments',
      client: '',
      site: '',
      status: 'active',
      stage: 'lost',
      assigned_pm: '',
    })
    expect(badStage.success).toBe(false)

    const missingName = projectFormSchema.safeParse({
      reference_no: '',
      name: '   ',
      client: '',
      site: '',
      status: 'active',
      stage: 'tender',
      assigned_pm: '',
    })
    expect(missingName.success).toBe(false)
  })
})
