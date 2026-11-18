import type ExcelJS from 'exceljs'
import { loadExcelJS } from '@/lib/loadExcelJS'
import type { DoorGroup, ProjectLine, ProjectVersion } from '@/types/database'

export interface ProjectExportInput {
  projectName: string
  builderName: string
  version: ProjectVersion
  groups: DoorGroup[]
  lines: ProjectLine[]
}

const CURRENCY_FMT = '$#,##0.00'
const NO_PRICE_FILL: ExcelJS.Fill = {
  type: 'pattern',
  pattern: 'solid',
  fgColor: { argb: 'FFFEF3C7' },
}
const NO_PRICE_NOTE = 'No unit price — not included in totals'
const PERCENT_FMT = '0.00%'

const THIN_BORDER: Partial<ExcelJS.Borders> = {
  top: { style: 'thin', color: { argb: 'FFD4D4D4' } },
  left: { style: 'thin', color: { argb: 'FFD4D4D4' } },
  bottom: { style: 'thin', color: { argb: 'FFD4D4D4' } },
  right: { style: 'thin', color: { argb: 'FFD4D4D4' } },
}

export async function buildProjectExportWorkbook({
  projectName,
  builderName,
  version,
  groups,
  lines,
}: ProjectExportInput): Promise<ArrayBuffer> {
  const ExcelJSLib = await loadExcelJS()
  const wb = new ExcelJSLib.Workbook()
  wb.creator = 'Mena Hardware'
  wb.created = new Date()

  const ws = wb.addWorksheet('HARDWARE')
  const markupPct = Number(version.markup_pct ?? 15)
  const markupRate = markupPct / 100
  const markupFactor = 1 + markupRate

  const linesByGroup = new Map<string, ProjectLine[]>()
  for (const g of groups) linesByGroup.set(g.id, [])
  for (const l of lines) {
    const arr = linesByGroup.get(l.group_id)
    if (arr) arr.push(l)
  }
  for (const arr of linesByGroup.values()) {
    arr.sort((a, b) => a.position - b.position)
  }

  const totalDoors = groups.reduce((sum, g) => sum + Number(g.door_qty), 0)

  // Title & Markup Strip (Rows 1-3)
  ws.getCell('A1').value = `DOOR HARDWARE SET — ${projectName}`
  ws.getCell('A1').font = { name: 'Calibri', size: 13, bold: true }
  ws.getCell('I1').value = 'MARKUP'
  ws.getCell('I1').font = { name: 'Calibri', size: 10, bold: true }
  ws.getCell('I1').alignment = { horizontal: 'center' }

  ws.getCell('A2').value = `${builderName || 'Mena Contractors'} • v${version.version_no} (${version.status.toUpperCase()})`
  ws.getCell('A2').font = { name: 'Calibri', size: 10, color: { argb: 'FF525252' } }
  ws.getCell('I2').value = markupRate
  ws.getCell('I2').numFmt = PERCENT_FMT
  ws.getCell('I2').font = { name: 'Calibri', size: 11, bold: true }
  ws.getCell('I2').alignment = { horizontal: 'center' }
  ws.getCell('I2').fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FFEFF6FF' },
  }
  ws.getCell('I2').border = {
    top: { style: 'medium', color: { argb: 'FF0A0A0A' } },
    left: { style: 'medium', color: { argb: 'FF0A0A0A' } },
    bottom: { style: 'medium', color: { argb: 'FF0A0A0A' } },
    right: { style: 'medium', color: { argb: 'FF0A0A0A' } },
  }

  ws.getCell('G3').value = 'OVERALL DOOR QTY:'
  ws.getCell('G3').font = { name: 'Calibri', size: 10, bold: true }
  ws.getCell('G3').alignment = { horizontal: 'right' }
  ws.getCell('H3').value = totalDoors
  ws.getCell('H3').font = { name: 'Calibri', size: 11, bold: true }
  ws.getCell('H3').alignment = { horizontal: 'right' }

  // Header Row (Row 4)
  const headers = [
    'ROOM NAME',
    'DOOR TAG',
    'DOOR SIZE',
    'DOOR CLASSIFICATION',
    'LEAFS',
    'PART NUMBER (SKU)',
    'HARDWARE DESCRIPTION',
    'QTY',
    'PRICE',
    'COST',
    'COST + MARKUP',
    'PM REMARKS',
  ]
  const headerRow = ws.getRow(4)
  headers.forEach((title, idx) => {
    const cell = headerRow.getCell(idx + 1)
    cell.value = title
    cell.font = { name: 'Calibri', size: 10, bold: true }
    cell.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFE5E5E5' },
    }
    cell.border = THIN_BORDER
    cell.alignment = {
      horizontal: idx >= 7 && idx <= 10 ? 'right' : 'left',
      vertical: 'middle',
    }
  })

  let currentRow = 5
  let noPriceCount = 0

  for (const group of groups) {
    const groupLines = linesByGroup.get(group.id) ?? []
    const doorQty = Number(group.door_qty)
    const doorTag =
      group.door_tag ||
      (group.match_status === 'manual' &&
      !group.matched_set_id &&
      group.match_reason?.startsWith('Custom:')
        ? group.match_reason.replace(/^Custom:\s*/, '')
        : '')

    const groupRowIdx = currentRow
    currentRow++

    const firstLineRow = currentRow
    const lastLineRow = firstLineRow + groupLines.length - 1

    const groupCost = groupLines.reduce((sum, l) => {
      if (l.unit_price === null) return sum
      return sum + Number(l.qty_per_door) * doorQty * Number(l.unit_price)
    }, 0)

    const gRow = ws.getRow(groupRowIdx)
    gRow.getCell(1).value = group.room_name
    gRow.getCell(2).value = doorTag
    gRow.getCell(3).value = group.door_size || ''
    gRow.getCell(4).value = group.classification || ''
    gRow.getCell(5).value = group.leaf || ''
    gRow.getCell(7).value = 'DOOR QTY:'
    gRow.getCell(8).value = doorQty
    gRow.getCell(10).value =
      groupLines.length > 0
        ? { formula: `SUM(J${firstLineRow}:J${lastLineRow})`, result: groupCost }
        : 0
    gRow.getCell(11).value =
      groupLines.length > 0
        ? {
            formula: `SUM(K${firstLineRow}:K${lastLineRow})`,
            result: groupCost * markupFactor,
          }
        : 0
    gRow.getCell(12).value = group.pm_remarks || ''

    for (let c = 1; c <= 12; c++) {
      const cell = gRow.getCell(c)
      cell.font = { name: 'Calibri', size: 10, bold: c !== 2 && c !== 12 }
      cell.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: c === 8 ? 'FFDCFCE7' : 'FFF5F5F5' },
      }
      cell.border = THIN_BORDER
      if (c === 7 || c === 8 || c === 10 || c === 11) {
        cell.alignment = { horizontal: 'right' }
      }
      if (c === 10 || c === 11) {
        cell.numFmt = CURRENCY_FMT
      }
    }


    for (const line of groupLines) {
      const rIdx = currentRow++
      const lRow = ws.getRow(rIdx)
      const hasPrice = line.unit_price !== null
      const lineCost = hasPrice
        ? Number(line.qty_per_door) * doorQty * Number(line.unit_price)
        : null

      lRow.getCell(6).value = line.sku
      lRow.getCell(7).value = line.description
      lRow.getCell(8).value = Number(line.qty_per_door)
      if (hasPrice) {
        lRow.getCell(9).value = Number(line.unit_price)
        lRow.getCell(10).value = {
          formula: `H${rIdx}*H${groupRowIdx}*I${rIdx}`,
          result: lineCost!,
        }
        lRow.getCell(11).value = {
          formula: `J${rIdx}*(1+$I$2)`,
          result: lineCost! * markupFactor,
        }
      }

      const isAdded = line.origin === 'added'
      for (let c = 1; c <= 12; c++) {
        const cell = lRow.getCell(c)
        cell.font = { name: 'Calibri', size: 10 }
        cell.border = THIN_BORDER
        if (isAdded && c >= 6) {
          cell.fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: 'FFDCFCE7' },
          }
        }
        if (c >= 8 && c <= 11) {
          cell.alignment = { horizontal: 'right' }
        }
        if (c >= 9 && c <= 11 && hasPrice) {
          cell.numFmt = CURRENCY_FMT
        }
        // Blank price: highlighted and noted, so it isn't mistaken for $0.
        if (c >= 9 && c <= 11 && !hasPrice) {
          cell.fill = NO_PRICE_FILL
        }
      }
      if (!hasPrice) {
        noPriceCount++
        lRow.getCell(9).note = NO_PRICE_NOTE
      }
    }
  }

  // Grand Totals in Row 3
  const doorQtyByGroup = new Map(groups.map((g) => [g.id, Number(g.door_qty)]))
  const grandTotal = lines.reduce((sum, l) => {
    if (l.unit_price === null) return sum
    const dQty = doorQtyByGroup.get(l.group_id) ?? 0
    return sum + Number(l.qty_per_door) * dQty * Number(l.unit_price)
  }, 0)

  // Sum the group rows (marked "DOOR QTY:" in column G). A SUMIF stays short
  // however many groups there are; "J5+J9+J14+..." broke Excel's formula
  // length limit on large projects.
  const lastRow = currentRow - 1
  ws.getCell('J3').value =
    groups.length > 0
      ? {
          formula: `SUMIF(G5:G${lastRow},"DOOR QTY:",J5:J${lastRow})`,
          result: grandTotal,
        }
      : 0
  if (noPriceCount > 0) {
    ws.getCell('J3').note = `Excludes ${noPriceCount} line${noPriceCount === 1 ? '' : 's'} with no unit price (highlighted)`
  }
  ws.getCell('J3').numFmt = CURRENCY_FMT
  ws.getCell('J3').font = { name: 'Calibri', size: 10, bold: true }
  ws.getCell('J3').alignment = { horizontal: 'right' }

  ws.getCell('K3').value = {
    formula: 'J3*(1+$I$2)',
    result: grandTotal * markupFactor,
  }
  ws.getCell('K3').numFmt = CURRENCY_FMT
  ws.getCell('K3').font = { name: 'Calibri', size: 10, bold: true }
  ws.getCell('K3').alignment = { horizontal: 'right' }

  // Auto-fit columns to longest content
  for (let c = 1; c <= 12; c++) {
    let maxLen = headers[c - 1].length + 2
    for (let r = 4; r < currentRow; r++) {
      const val = ws.getRow(r).getCell(c).value
      let text = ''
      if (val !== null && val !== undefined) {
        if (typeof val === 'object' && 'result' in val) {
          text = CURRENCY_FMT
        } else {
          text = String(val)
        }
      }
      if (text.length + 2 > maxLen) {
        maxLen = text.length + 2
      }
    }
    ws.getColumn(c).width = Math.min(Math.max(maxLen, 10), 55)
  }

  ws.views = [{ state: 'frozen', ySplit: 4 }]

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
