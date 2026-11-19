import type ExcelJS from 'exceljs'
import { loadExcelJS } from '@/lib/loadExcelJS'
import type { DoorGroup, Part, ProjectLine, ProjectVersion } from '@/types/database'
import { DELIVERY_PER_DOOR } from '@/features/projects/pricing'

/**
 * Excel export in the layout of Mena's final "NOVAS Template":
 *   rows 1-4  title, Project, Client, Schedule # (date), markup (F3),
 *             overall door qty (E4), deliveries (K4), total ex. GST (K3)
 *   row 5     LEGEND | SUPPLIER | PART NUMBER | DESCRIPTION | QTY | Cost |
 *             Cost Door | Price | Price Door | HW Price per Door Type |
 *             Overall HW Price per Typical Door | Total Items per Typical Door |
 *             MHQT REMARKS (from each line's remarks in the grid)
 *   then      one grey "DOOR QTY:" row per door group followed by its lines.
 */

/** Default sheet title (row 1); editable in the export dialog. */
export const DEFAULT_EXPORT_TITLE = 'NOVAS HARDWARE - SATIN STAINLESS STEEL'

export interface ProjectExportInput {
  /** Used for the file name, e.g. "SV002 — McLaren St". */
  projectName: string
  /** Row 2 "Project: ..." — the project name without the reference no. Defaults to projectName. */
  projectTitle?: string
  clientName: string
  /** Row 4 "Schedule #:" date picked before exporting ("9/9/2026"); written as an Excel date. */
  scheduleNo: string
  /** Row 1 title. Defaults to DEFAULT_EXPORT_TITLE. */
  sheetTitle?: string
  version: ProjectVersion
  groups: DoorGroup[]
  lines: ProjectLine[]
  /** Library parts, for each line's supplier (matched by part id, else SKU). */
  parts?: Pick<Part, 'id' | 'sku' | 'suppliers'>[]
}

// Number formats and colours copied from the Mena "NOVAS Template" workbook.
const ACCOUNTING_FMT = '_("$"* #,##0.00_);_("$"* \\(#,##0.00\\);_("$"* "-"??_);_(@_)'
const TOTAL_FMT = '_-"$"* #,##0.00_-;\\-"$"* #,##0.00_-;_-"$"* "-"??_-;_-@_-'
const PERCENT_FMT = '0.00%'
const DATE_FMT = 'mm-dd-yy'

const FONT = 'Arial'
const GREY_TEXT = { argb: 'FF808080' }
const NAVY_TEXT = { argb: 'FF002060' }
const MARKUP_TEXT = { argb: 'FF4472C4' }

const solid = (argb: string): ExcelJS.Fill => ({ type: 'pattern', pattern: 'solid', fgColor: { argb } })
const HEADER_FILL = solid('FFD9D9D9') // table header and door group rows
const DOOR_QTY_FILL = solid('FFC6E0B4') // door qty on group rows
const BLUE_FILL = solid('FFBDD7EE') // overall price per door type, grand total
const LIGHT_BLUE_FILL = solid('FFDEEBF7') // markup, deliveries
const PEACH_FILL = solid('FFFBE5D6') // total before markup
const REMARKS_FILL = solid('FFFFFF00') // MHQT REMARKS header
const ADDED_FILL = solid('FFDCFCE7') // lines added to the standard set
const NO_PRICE_FILL = solid('FFFEF3C7')
const NO_PRICE_NOTE = 'No unit price — not included in totals'

const THIN = { style: 'thin' as const }
const MEDIUM = { style: 'medium' as const }

export { DELIVERY_PER_DOOR }

/** Template column widths, A–M. */
const COLUMN_WIDTHS = [22.71, 18.86, 20.29, 96, 9.57, 12.71, 15.71, 12.71, 15.71, 16.71, 19.71, 17.71, 24.43]

const TABLE_HEADER_ROW = 5
const TABLE_HEADERS = [
  'LEGEND',
  'SUPPLIER',
  'PART NUMBER',
  'DESCRIPTION',
  'QTY',
  'Cost',
  'Cost Door',
  'Price',
  'Price Door',
  'Hardware Price \nper Door Type',
  'Overall HW Price \nper Typical Door',
  'Total Items \nper Typical Door',
  'MHQT  REMARKS',
]

/** "9/9/2026" from the export dialog → a real date for Excel (no time-zone shift). */
function scheduleCellValue(scheduleNo: string): Date | string {
  const m = scheduleNo.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/)
  if (!m) return scheduleNo.trim()
  return new Date(Date.UTC(Number(m[3]), Number(m[1]) - 1, Number(m[2])))
}

/** "SINGLE NON RATED": leaf + classification, as in the template's door group rows. */
function doorTypeLabel(group: DoorGroup): string {
  const leaf = (group.leaf || '').trim().toUpperCase()
  const cls = (group.classification || '').trim().toUpperCase()
  if (!leaf) return cls
  if (!cls || cls.startsWith(leaf)) return cls || leaf
  return `${leaf} ${cls}`
}

function doorTagOf(group: DoorGroup): string {
  return (
    group.door_tag ||
    (group.match_status === 'manual' && !group.matched_set_id && group.match_reason?.startsWith('Custom:')
      ? group.match_reason.replace(/^Custom:\s*/, '')
      : '')
  )
}

export async function buildProjectExportWorkbook({
  projectName,
  projectTitle,
  clientName,
  scheduleNo,
  sheetTitle,
  version,
  groups,
  lines,
  parts = [],
}: ProjectExportInput): Promise<ArrayBuffer> {
  const ExcelJSLib = await loadExcelJS()
  const wb = new ExcelJSLib.Workbook()
  wb.creator = 'Mena Hardware'
  wb.created = new Date()

  const ws = wb.addWorksheet('HARDWARE')
  const markupRate = Number(version.markup_pct ?? 15) / 100
  const markupFactor = 1 + markupRate

  // Supplier per line: from its library part (by id, else by SKU).
  const partById = new Map(parts.map((p) => [p.id, p]))
  const partBySku = new Map(parts.map((p) => [p.sku.trim().toUpperCase(), p]))
  const partOf = (line: ProjectLine) =>
    (line.part_id ? partById.get(line.part_id) : undefined) ?? partBySku.get(line.sku.trim().toUpperCase())

  const linesByGroup = new Map<string, ProjectLine[]>()
  for (const g of groups) linesByGroup.set(g.id, [])
  for (const l of lines) linesByGroup.get(l.group_id)?.push(l)
  for (const arr of linesByGroup.values()) arr.sort((a, b) => a.position - b.position)

  const totalDoors = groups.reduce((sum, g) => sum + Number(g.door_qty), 0)

  COLUMN_WIDTHS.forEach((w, i) => (ws.getColumn(i + 1).width = w))
  for (let c = 1; c <= 13; c++) ws.getColumn(c).font = { name: FONT, size: 10 }

  const setCell = (
    ref: string,
    value: ExcelJS.CellValue,
    style: { bold?: boolean; size?: number; color?: { argb: string }; fill?: ExcelJS.Fill; numFmt?: string; align?: ExcelJS.Alignment['horizontal'] } = {},
  ) => {
    const cell = ws.getCell(ref)
    cell.value = value
    cell.font = { name: FONT, size: style.size ?? 10, bold: style.bold ?? true, color: style.color }
    if (style.fill) cell.fill = style.fill
    if (style.numFmt) cell.numFmt = style.numFmt
    cell.alignment = { horizontal: style.align, vertical: 'middle' }
    return cell
  }

  // ---------------------------------------------------------------- rows 1-4
  ws.mergeCells('A1:L1')
  setCell('A1', (sheetTitle?.trim() || DEFAULT_EXPORT_TITLE).toUpperCase(), { size: 12, color: GREY_TEXT, align: 'left' })
  setCell('A2', 'Project:', { color: GREY_TEXT, align: 'left' })
  setCell('B2', (projectTitle || projectName).toUpperCase(), { color: GREY_TEXT, align: 'left' })
  setCell('A3', 'Client:', { color: GREY_TEXT, align: 'left' })
  setCell('B3', (clientName || '').toUpperCase(), { color: GREY_TEXT, align: 'left' })
  setCell('A4', 'Schedule #:', { color: GREY_TEXT, align: 'left' })
  const scheduleValue = scheduleCellValue(scheduleNo)
  setCell('B4', scheduleValue, {
    color: GREY_TEXT,
    align: 'left',
    numFmt: scheduleValue instanceof Date ? DATE_FMT : undefined,
  })
  for (const r of [1, 2, 3, 4]) ws.getRow(r).height = 17.1

  // Markup (F2:F3) and the cost / margin of the whole schedule (G3:G4)
  setCell('F2', 'MARKUP', { align: 'center' })
  const markupCell = setCell('F3', markupRate, { color: MARKUP_TEXT, fill: LIGHT_BLUE_FILL, numFmt: PERCENT_FMT, align: 'center' })
  markupCell.border = { top: MEDIUM, left: MEDIUM, bottom: MEDIUM, right: MEDIUM }

  // Overall door qty and deliveries (row 4)
  setCell('D4', 'OVERALL DOOR QTY:', { color: NAVY_TEXT, align: 'right' })
  setCell('J4', 'DELIVERIES', { color: GREY_TEXT, align: 'right' })

  // Totals (K2:K3)
  setCell('K2', 'TOTAL EX. GST', { align: 'center' })
  setCell('J3', 'INCL. DELIVERIES / EXCL. GST', { color: GREY_TEXT, align: 'right' })

  // ------------------------------------------------------------ table header
  const headerRow = ws.getRow(TABLE_HEADER_ROW)
  headerRow.height = 27.95
  TABLE_HEADERS.forEach((title, idx) => {
    const cell = headerRow.getCell(idx + 1)
    cell.value = title
    cell.font = { name: FONT, size: 10, bold: true }
    cell.fill = idx === 12 ? REMARKS_FILL : HEADER_FILL
    cell.alignment = { horizontal: idx >= 4 ? 'center' : undefined, vertical: 'middle', wrapText: title.includes('\n') }
    if (idx <= 10) cell.border = { top: THIN, bottom: THIN }
  })

  // ------------------------------------------------------------- door groups
  let currentRow = TABLE_HEADER_ROW + 1
  let noPriceCount = 0
  let grandTotal = 0 // Σ door qty × price per door (with markup)

  for (const group of groups) {
    const groupLines = linesByGroup.get(group.id) ?? []
    const doorQty = Number(group.door_qty)
    const g = currentRow++
    const first = currentRow
    const last = first + groupLines.length - 1

    const costPerDoor = groupLines.reduce(
      (sum, l) => (l.unit_price === null ? sum : sum + Number(l.qty_per_door) * Number(l.unit_price)),
      0,
    )
    const pricePerDoor = costPerDoor * markupFactor
    grandTotal += doorQty * pricePerDoor

    const gRow = ws.getRow(g)
    gRow.getCell(1).value = group.room_name
    gRow.getCell(2).value = doorTagOf(group)
    gRow.getCell(3).value = doorTypeLabel(group)
    gRow.getCell(4).value = 'DOOR QTY:'
    gRow.getCell(5).value = doorQty
    gRow.getCell(7).value = groupLines.length ? { formula: `SUM(G${first}:G${last})`, result: costPerDoor } : 0
    gRow.getCell(9).value = groupLines.length ? { formula: `SUM(I${first}:I${last})`, result: pricePerDoor } : 0
    gRow.getCell(10).value = { formula: `I${g}`, result: pricePerDoor }
    gRow.getCell(11).value = { formula: `E${g}*I${g}`, result: doorQty * pricePerDoor }

    for (let c = 1; c <= 11; c++) {
      const cell = gRow.getCell(c)
      cell.font = { name: FONT, size: 10, bold: c !== 10 }
      cell.fill = c === 5 ? DOOR_QTY_FILL : c === 11 ? BLUE_FILL : HEADER_FILL
      cell.border = { top: THIN, bottom: THIN }
      cell.alignment = { vertical: 'middle', horizontal: c === 4 ? 'right' : c === 5 ? 'center' : undefined }
      if (c >= 6 && c <= 10) cell.numFmt = ACCOUNTING_FMT
      if (c === 11) cell.numFmt = TOTAL_FMT
    }

    for (const line of groupLines) {
      const r = currentRow++
      const row = ws.getRow(r)
      const part = partOf(line)
      const supplier = part?.suppliers?.name ?? ''
      const ownerSupplied = part?.suppliers?.is_owner_supplied ?? false
      const qty = Number(line.qty_per_door)
      const hasPrice = line.unit_price !== null
      const cost = hasPrice ? Number(line.unit_price) : null

      // LEGEND: "MM" for owner-supplied (Mena) items, as in the template.
      if (ownerSupplied) row.getCell(1).value = 'MM'
      if (supplier) row.getCell(2).value = supplier
      row.getCell(3).value = line.sku
      row.getCell(4).value = line.description
      row.getCell(5).value = qty
      if (cost !== null) {
        row.getCell(6).value = cost
        row.getCell(7).value = { formula: `IFERROR(E${r}*F${r},"")`, result: qty * cost }
        row.getCell(8).value = { formula: `F${r}*(1+$F$3)`, result: cost * markupFactor }
        row.getCell(9).value = { formula: `E${r}*H${r}`, result: qty * cost * markupFactor }
      }
      row.getCell(12).value = { formula: `E${r}*$E$${g}`, result: qty * doorQty }
      if (line.mhqt_remarks?.trim()) row.getCell(13).value = line.mhqt_remarks.trim()

      const added = line.origin === 'added'
      for (let c = 1; c <= 13; c++) {
        const cell = row.getCell(c)
        cell.font = { name: FONT, size: 10 }
        cell.alignment = {
          vertical: 'middle',
          horizontal: c === 5 || c === 12 ? 'center' : undefined,
          wrapText: c === 13 ? true : undefined,
        }
        if (c <= 9) cell.border = { bottom: THIN }
        if (c >= 6 && c <= 10) cell.numFmt = ACCOUNTING_FMT
        if (added && c <= 9) cell.fill = ADDED_FILL
        // Blank price: highlighted and noted, so it isn't mistaken for $0.
        if (!hasPrice && c >= 6 && c <= 9) cell.fill = NO_PRICE_FILL
      }
      if (!hasPrice) {
        noPriceCount++
        row.getCell(6).note = NO_PRICE_NOTE
      }
    }
  }

  // ------------------------------------------------------------------ totals
  const firstData = TABLE_HEADER_ROW + 1
  const lastData = Math.max(currentRow - 1, firstData)
  const deliveries = totalDoors * DELIVERY_PER_DOOR
  const totalExGst = grandTotal + deliveries

  setCell(
    'E4',
    { formula: `SUMIF($D$${firstData}:$D$${lastData},"DOOR QTY:",$E$${firstData}:$E$${lastData})`, result: totalDoors },
    { color: NAVY_TEXT, align: 'center' },
  )
  setCell('K4', { formula: `+E4*${DELIVERY_PER_DOOR}`, result: deliveries }, { bold: false, fill: LIGHT_BLUE_FILL, numFmt: TOTAL_FMT, align: 'center' })
  const totalCell = setCell('K3', { formula: `SUM(K4:K${lastData})`, result: totalExGst }, { size: 11, fill: BLUE_FILL, numFmt: TOTAL_FMT, align: 'center' })
  if (noPriceCount > 0) {
    totalCell.note = `Excludes ${noPriceCount} line${noPriceCount === 1 ? '' : 's'} with no unit price (highlighted)`
  }
  const beforeMarkup = setCell('G3', { formula: 'K3/(1+F3)', result: totalExGst / markupFactor }, { fill: PEACH_FILL, numFmt: TOTAL_FMT })
  beforeMarkup.border = { left: MEDIUM }
  setCell('G4', { formula: 'K3-G3', result: totalExGst - totalExGst / markupFactor }, { bold: false, numFmt: ACCOUNTING_FMT })

  ws.views = [{ state: 'frozen', ySplit: TABLE_HEADER_ROW }]
  ws.autoFilter = `A${TABLE_HEADER_ROW}:K${lastData}`

  const buf = await wb.xlsx.writeBuffer()
  return buf as ArrayBuffer
}

export async function downloadProjectExcel(input: ProjectExportInput): Promise<void> {
  const buffer = await buildProjectExportWorkbook(input)
  const blob = new Blob([buffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  })
  const safeName = input.projectName
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '')
  const filename = `${safeName || 'project'}-v${input.version.version_no}.xlsx`

  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}
