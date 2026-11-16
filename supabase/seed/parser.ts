import fs from 'node:fs'
import XLSX from 'xlsx'

export interface ParsedSetLine {
  position: number
  sku: string
  description: string
  qty: number
  unit_price: number | null
}

export interface ParsedStandardSet {
  setIndex: number
  room_name: string
  door_tag: string
  door_size: string
  classification: string
  leaf: 'SINGLE' | 'DOUBLE' | 'CAVITY SINGLE' | ''
  lines: ParsedSetLine[]
}

export interface ParsedPart {
  sku: string
  manufacturer: 'MM' | 'NOVAS' | 'LOCKWOOD' | 'SCOPE' | 'GEZE' | 'FSH' | 'OTHER'
  description: string
  unit_cost: number | null
  source: 'OSM_SHEET' | 'HARDWARE_SHEET'
}

export interface DataIssue {
  setIndex: number
  room_name: string
  classification: string
  reason: string
  affectedLines: Array<{ sku: string; description: string; unit_price: number | null }>
}

export interface SeedParseResult {
  manufacturers: Array<{ name: string; is_owner_supplied: boolean }>
  parts: ParsedPart[]
  sets: ParsedStandardSet[]
  dataIssues: DataIssue[]
}

const KNOWN_MANUFACTURERS = ['NOVAS', 'LOCKWOOD', 'SCOPE', 'GEZE', 'FSH'] as const

export function inferManufacturer(
  sku: string,
  description: string,
  forceMM = false,
): ParsedPart['manufacturer'] {
  const cleanSku = sku.trim().toUpperCase()
  const cleanDesc = description.trim().toUpperCase()

  if (forceMM || cleanSku.startsWith('MM')) {
    return 'MM'
  }

  const firstWord = cleanDesc.split(/\s+/)[0] ?? ''
  for (const mfg of KNOWN_MANUFACTURERS) {
    if (firstWord === mfg) {
      return mfg
    }
  }

  return 'OTHER'
}

function normalizeLeaf(raw: unknown): ParsedStandardSet['leaf'] {
  const val = String(raw ?? '').trim().toUpperCase()
  if (val === 'SINGLE' || val === 'DOUBLE' || val === 'CAVITY SINGLE') {
    return val
  }
  return ''
}

function parseNullableNumber(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null
  const str = String(raw).trim()
  if (str === '') return null
  const num = Number(str)
  if (!Number.isFinite(num)) return null
  return Math.round(num * 1000) / 1000
}

export function parseHardwareWorkbook(xlsxPath: string): SeedParseResult {
  if (!fs.existsSync(xlsxPath)) {
    throw new Error(`Excel file not found at: ${xlsxPath}`)
  }

  const wb = XLSX.readFile(xlsxPath)
  const hardwareSheetName = wb.SheetNames.find(
    (n: string) => n.trim().toUpperCase() === 'HARDWARE',
  )
  const osmSheetName = wb.SheetNames.find((n: string) =>
    n.toUpperCase().includes('OSM'),
  )

  if (!hardwareSheetName) {
    throw new Error(`Sheet "HARDWARE" not found in ${xlsxPath}`)
  }

  const hwRows = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[hardwareSheetName], {
    header: 1,
    defval: null,
  })

  const sets: ParsedStandardSet[] = []
  const dataIssues: DataIssue[] = []
  const partsMap = new Map<string, ParsedPart>()

  // 1. Parse OSM sheet first (owner-supplied MM parts)
  if (osmSheetName) {
    const osmRows = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[osmSheetName], {
      header: 1,
      defval: null,
    })

    for (let i = 0; i < osmRows.length; i++) {
      const row = osmRows[i]
      if (!Array.isArray(row)) continue
      const col0 = String(row[0] ?? '').trim().toUpperCase()
      const col1 = String(row[1] ?? '').trim().toUpperCase()
      const sku = String(row[2] ?? '').trim()
      const description = String(row[3] ?? '').trim()
      const unitCost = parseNullableNumber(row[4])

      if (!sku || col0 === 'LEGEND' || sku.toUpperCase().includes('PART NUMBER')) {
        continue
      }

      const isMM = col0 === 'MM' || col1 === 'MM' || sku.toUpperCase().startsWith('MM')
      const manufacturer = inferManufacturer(sku, description, isMM)

      if (!partsMap.has(sku)) {
        partsMap.set(sku, {
          sku,
          manufacturer,
          description,
          unit_cost: unitCost,
          source: 'OSM_SHEET',
        })
      }
    }
  }

  // 2. Parse HARDWARE sheet for standard sets and part lines
  let currentSet: ParsedStandardSet | null = null

  for (let i = 0; i < hwRows.length; i++) {
    const row = hwRows[i]
    if (!Array.isArray(row)) continue

    const col0 = String(row[0] ?? '').trim()
    const col1 = String(row[1] ?? '').trim()
    const col2 = String(row[2] ?? '').trim()
    const col3 = String(row[3] ?? '').trim()
    const col4 = row[4]
    const col5 = String(row[5] ?? '').trim()
    const col6 = String(row[6] ?? '').trim()
    const col7 = row[7]
    const col8 = row[8]

    // Stop if we reach footer notes
    if (col0.toUpperCase().startsWith('INCLUSIONS & EXCLUSIONS')) {
      break
    }

    // Header row for a standard set is marked by col6 === "DOOR QTY:"
    if (col6.toUpperCase() === 'DOOR QTY:') {
      currentSet = {
        setIndex: sets.length + 1,
        room_name: col0,
        door_tag: col1,
        door_size: col2,
        classification: col3,
        leaf: normalizeLeaf(col4),
        lines: [],
      }
      sets.push(currentSet)
      continue
    }

    // Part row inside a standard set
    if (currentSet && (col5 !== '' || col6 !== '')) {
      // Skip header/title rows if any
      if (col5.toUpperCase().includes('PART NUMBER') || col6.toUpperCase().includes('HARDWARE DESCRIPTION')) {
        continue
      }

      const qty = parseNullableNumber(col7) ?? 1
      const unitPrice = parseNullableNumber(col8)
      const position = currentSet.lines.length + 1

      currentSet.lines.push({
        position,
        sku: col5,
        description: col6,
        qty,
        unit_price: unitPrice,
      })
    }
  }

  // 3. Process sets for parts library & detect known data issues (KITCHEN / FIRE RATED - PIVOT)
  for (const set of sets) {
    const isKitchenPivot =
      set.room_name.toUpperCase() === 'KITCHEN' &&
      set.classification.toUpperCase().includes('FIRE RATED - PIVOT')

    if (isKitchenPivot) {
      dataIssues.push({
        setIndex: set.setIndex,
        room_name: set.room_name,
        classification: set.classification,
        reason:
          'SKUs in KITCHEN (FIRE RATED - PIVOT) do not match their hardware descriptions. Set imported as written; lines excluded from the Parts Library.',
        affectedLines: set.lines.map((l) => ({
          sku: l.sku,
          description: l.description,
          unit_price: l.unit_price,
        })),
      })
      continue
    }

    for (const line of set.lines) {
      if (!line.sku) continue
      if (!partsMap.has(line.sku)) {
        partsMap.set(line.sku, {
          sku: line.sku,
          manufacturer: inferManufacturer(line.sku, line.description, false),
          description: line.description,
          unit_cost: line.unit_price,
          source: 'HARDWARE_SHEET',
        })
      }
    }
  }

  const manufacturers = [
    { name: 'MM', is_owner_supplied: true },
    { name: 'NOVAS', is_owner_supplied: false },
    { name: 'LOCKWOOD', is_owner_supplied: false },
    { name: 'SCOPE', is_owner_supplied: false },
    { name: 'GEZE', is_owner_supplied: false },
    { name: 'FSH', is_owner_supplied: false },
    { name: 'OTHER', is_owner_supplied: false },
  ]

  return {
    manufacturers,
    parts: Array.from(partsMap.values()),
    sets,
    dataIssues,
  }
}

export function formatSeedReport(result: SeedParseResult): string {
  const lines: string[] = []
  lines.push('=====================================================================')
  lines.push('                 MENA HARDWARE — SEED MAPPING SUMMARY                ')
  lines.push('=====================================================================')
  lines.push(`Total Standard Sets parsed: ${result.sets.length}`)
  lines.push(`Total Unique Parts in Library: ${result.parts.length}`)
  lines.push('')
  lines.push('Parts by Manufacturer:')

  for (const mfg of result.manufacturers) {
    const mfgParts = result.parts.filter((p) => p.manufacturer === mfg.name)
    const nullCostCount = mfgParts.filter((p) => p.unit_cost === null).length
    const ownerTag = mfg.is_owner_supplied ? ' [Owner-Supplied]' : ''
    lines.push(
      `  - ${mfg.name.padEnd(10)}${ownerTag.padEnd(18)}: ${String(mfgParts.length).padStart(3)} parts (${nullCostCount} with null unit_cost)`,
    )
    for (const p of mfgParts) {
      const costStr = p.unit_cost === null ? 'NULL (no unit price)' : `$${p.unit_cost.toFixed(2)}`
      lines.push(`      [${p.sku.padEnd(18)}] ${p.description.slice(0, 48).padEnd(48)} | ${costStr}`)
    }
  }

  lines.push('')
  lines.push('=====================================================================')
  lines.push('                         DATA ISSUES REPORT                          ')
  lines.push('=====================================================================')
  if (result.dataIssues.length === 0) {
    lines.push('No data issues detected.')
  } else {
    for (const issue of result.dataIssues) {
      lines.push(`Set #${issue.setIndex}: ${issue.room_name} (${issue.classification})`)
      lines.push(`Reason: ${issue.reason}`)
      lines.push('Excluded Lines (imported into standard_set_lines as-is, omitted from parts):')
      for (const l of issue.affectedLines) {
        lines.push(`  - SKU: ${l.sku.padEnd(15)} | Desc: ${l.description} | Price: ${l.unit_price ?? 'NULL'}`)
      }
    }
  }
  lines.push('=====================================================================')

  return lines.join('\n')
}
