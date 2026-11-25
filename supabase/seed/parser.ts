import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type ExcelJS from 'exceljs'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const requireFromWeb = createRequire(path.resolve(__dirname, '../../web/package.json'))
const ExcelJSRuntime = requireFromWeb('exceljs') as typeof ExcelJS

export interface ParsedSetLine {
  position: number
  sku: string
  description: string
  qty: number
  unit_price: number | null
}

export interface ParsedStandardSet {
  setIndex: number
  seedKey: string
  room_name: string
  door_tag: string
  door_size: string
  classification: string
  leaf: 'SINGLE' | 'DOUBLE' | 'CAVITY SINGLE' | ''
  lines: ParsedSetLine[]
}

export interface ParsedPart {
  sku: string
  supplier: 'MM' | 'NOVAS' | 'LOCKWOOD' | 'SCOPE' | 'GEZE' | 'FSH' | 'OTHER'
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
  suppliers: Array<{ name: string; is_owner_supplied: boolean }>
  parts: ParsedPart[]
  sets: ParsedStandardSet[]
  dataIssues: DataIssue[]
}

const KNOWN_SUPPLIERS = ['NOVAS', 'LOCKWOOD', 'SCOPE', 'GEZE', 'FSH'] as const

export function inferSupplier(
  sku: string,
  description: string,
  forceMM = false,
): ParsedPart['supplier'] {
  const cleanSku = sku.trim().toUpperCase()
  const cleanDesc = description.trim().toUpperCase()

  if (forceMM || cleanSku.startsWith('MM')) {
    return 'MM'
  }

  const firstWord = cleanDesc.split(/\s+/)[0] ?? ''
  for (const mfg of KNOWN_SUPPLIERS) {
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

function unwrapCellValue(val: ExcelJS.CellValue): unknown {
  if (val === null || val === undefined) return null
  if (typeof val === 'object') {
    if ('result' in val) {
      return val.result ?? null
    }
    if ('richText' in val && Array.isArray(val.richText)) {
      return val.richText.map((part) => part.text).join('')
    }
    if ('text' in val) {
      return val.text
    }
  }
  return val
}

function sheetToRows(sheet: ExcelJS.Worksheet): unknown[][] {
  const rows: unknown[][] = []
  const maxRow = sheet.rowCount
  const maxCol = Math.max(sheet.columnCount, 12)

  for (let r = 1; r <= maxRow; r++) {
    const row = sheet.getRow(r)
    const arr: unknown[] = []
    for (let c = 1; c <= maxCol; c++) {
      arr.push(unwrapCellValue(row.getCell(c).value))
    }
    rows.push(arr)
  }
  return rows
}

function tokenizeDescription(desc: string): Set<string> {
  return new Set(
    desc
      .toUpperCase()
      .replace(/[^A-Z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length >= 3),
  )
}

function descriptionsConflict(a: string, b: string): boolean {
  const tokensA = tokenizeDescription(a)
  const tokensB = tokenizeDescription(b)
  if (tokensA.size === 0 || tokensB.size === 0) return false
  for (const t of tokensA) {
    if (tokensB.has(t)) return false
  }
  return true
}

export async function parseHardwareWorkbook(xlsxPath: string): Promise<SeedParseResult> {
  if (!fs.existsSync(xlsxPath)) {
    throw new Error(`Excel file not found at: ${xlsxPath}`)
  }

  const wb = new ExcelJSRuntime.Workbook()
  await wb.xlsx.readFile(xlsxPath)

  const hardwareSheet = wb.worksheets.find(
    (ws) => ws.name.trim().toUpperCase() === 'HARDWARE',
  )
  const osmSheet = wb.worksheets.find((ws) =>
    ws.name.toUpperCase().includes('OSM'),
  )

  if (!hardwareSheet) {
    throw new Error(`Sheet "HARDWARE" not found in ${xlsxPath}`)
  }

  const hwRows = sheetToRows(hardwareSheet)
  const sets: ParsedStandardSet[] = []
  const dataIssues: DataIssue[] = []
  const partsMap = new Map<string, ParsedPart>()

  // 1. Parse OSM sheet first (owner-supplied MM parts)
  if (osmSheet) {
    const osmRows = sheetToRows(osmSheet)

    for (let i = 0; i < osmRows.length; i++) {
      const row = osmRows[i]
      if (!Array.isArray(row)) continue
      const col0 = String(row[0] ?? '').trim().toUpperCase()
      const col1 = String(row[1] ?? '').trim().toUpperCase()
      const sku = String(row[2] ?? '').trim()
      const description = String(row[3] ?? '').trim()
      const unitCost = parseNullableNumber(row[4])

      if (
        !sku ||
        col0 === 'LEGEND' ||
        col0.includes('OWNER SUPPLIED') ||
        sku.toUpperCase().includes('PART NUMBER') ||
        sku.toUpperCase().includes('OWNER SUPPLIED')
      ) {
        continue
      }

      const isMM = col0 === 'MM' || col1 === 'MM' || sku.toUpperCase().startsWith('MM')
      const supplier = inferSupplier(sku, description, isMM)

      if (!partsMap.has(sku)) {
        partsMap.set(sku, {
          sku,
          supplier,
          description,
          unit_cost: unitCost,
          source: 'OSM_SHEET',
        })
      }
    }
  }

  // 2. Parse HARDWARE sheet for standard sets and part lines
  let currentSet: ParsedStandardSet | null = null
  const setKeyOccurrences = new Map<string, number>()

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
      const leaf = normalizeLeaf(col4)
      const baseKey = [
        col0.toUpperCase(),
        col3.toUpperCase(),
        leaf,
        col2.replace(/\s+/g, '').toUpperCase(),
      ].join('|')
      const occ = (setKeyOccurrences.get(baseKey) ?? 0) + 1
      setKeyOccurrences.set(baseKey, occ)

      currentSet = {
        setIndex: sets.length + 1,
        seedKey: `set:${baseKey}#${occ}`,
        room_name: col0,
        door_tag: col1,
        door_size: col2,
        classification: col3,
        leaf,
        lines: [],
      }
      sets.push(currentSet)
      continue
    }

    // Part row inside a standard set
    if (currentSet && (col5 !== '' || col6 !== '')) {
      if (
        col5.toUpperCase().includes('PART NUMBER') ||
        col6.toUpperCase().includes('HARDWARE DESCRIPTION')
      ) {
        continue
      }

      const parsedQty = parseNullableNumber(col7)
      if (parsedQty === null) {
        dataIssues.push({
          setIndex: currentSet.setIndex,
          room_name: currentSet.room_name,
          classification: currentSet.classification,
          reason: `Blank or non-numeric quantity on line "${col5 || col6}". Recorded as 0 rather than inventing a quantity.`,
          affectedLines: [
            {
              sku: col5,
              description: col6,
              unit_price: parseNullableNumber(col8),
            },
          ],
        })
      }
      const qty = parsedQty ?? 0
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

  // 3. Build canonical SKU -> description frequency map to detect mismatched sets dynamically
  const skuDescCounts = new Map<string, Map<string, number>>()
  for (const part of partsMap.values()) {
    const counts = new Map<string, number>()
    counts.set(part.description, 10) // OSM sheet is authoritative
    skuDescCounts.set(part.sku, counts)
  }
  for (const set of sets) {
    for (const line of set.lines) {
      if (!line.sku) continue
      let counts = skuDescCounts.get(line.sku)
      if (!counts) {
        counts = new Map<string, number>()
        skuDescCounts.set(line.sku, counts)
      }
      counts.set(line.description, (counts.get(line.description) ?? 0) + 1)
    }
  }

  const canonicalDescBySku = new Map<string, string>()
  for (const [sku, counts] of skuDescCounts.entries()) {
    let bestDesc = ''
    let bestCount = -1
    for (const [desc, count] of counts.entries()) {
      if (count > bestCount) {
        bestCount = count
        bestDesc = desc
      }
    }
    canonicalDescBySku.set(sku, bestDesc)
  }

  // 4. Process sets for parts library & flag sets with genuine SKU-to-description mismatches
  for (const set of sets) {
    const mismatchedLines = set.lines.filter((line) => {
      if (!line.sku) return false
      const canonical = canonicalDescBySku.get(line.sku)
      return canonical ? descriptionsConflict(line.description, canonical) : false
    })

    if (mismatchedLines.length >= 2) {
      dataIssues.push({
        setIndex: set.setIndex,
        room_name: set.room_name,
        classification: set.classification,
        reason: `SKUs in ${set.room_name} (${set.classification}) do not match their canonical hardware descriptions. Set imported as written; lines excluded from the Parts Library.`,
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
          supplier: inferSupplier(line.sku, line.description, false),
          description: line.description,
          unit_cost: line.unit_price,
          source: 'HARDWARE_SHEET',
        })
      }
    }
  }

  const suppliers = [
    { name: 'MM', is_owner_supplied: true },
    { name: 'NOVAS', is_owner_supplied: false },
    { name: 'LOCKWOOD', is_owner_supplied: false },
    { name: 'SCOPE', is_owner_supplied: false },
    { name: 'GEZE', is_owner_supplied: false },
    { name: 'FSH', is_owner_supplied: false },
    { name: 'OTHER', is_owner_supplied: false },
  ]

  return {
    suppliers,
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
  lines.push('Parts by Supplier:')

  for (const mfg of result.suppliers) {
    const mfgParts = result.parts.filter((p) => p.supplier === mfg.name)
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
