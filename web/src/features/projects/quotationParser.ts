import ExcelJS from 'exceljs';

export interface ParsedQuotationDoor {
  door_ref: string;
  room_name: string;
  classification: string | null;
  leaf: string | null;
  door_size: string | null;
  qty: number;
  source_row: number;
}

export interface ParsedDoorGroupPreview {
  position: number;
  group_key: string;
  room_name: string;
  classification: string | null;
  leaf: string | null;
  door_size: string | null;
  door_qty: number;
  source_rows: number[];
}

export interface ParseIssue {
  row: number;
  severity: 'warning' | 'error';
  message: string;
  rawRef?: string;
}

export interface QuotationParseResult {
  sheetName: string;
  headerRow: number;
  totalDataRowsScanned: number;
  doors: ParsedQuotationDoor[];
  groups: ParsedDoorGroupPreview[];
  totalDoorQty: number;
  excludedCount: number;
  skippedCount: number;
  issues: ParseIssue[];
  report: Record<string, unknown>;
}

interface ColumnMap {
  doorLevel?: number;
  doorType?: number;
  doorApt?: number;
  roomName: number;
  frameType?: number;
  frl?: number;
  leafType?: number;
  leafHeight?: number;
  leaf1Width?: number;
  leaf2Width?: number;
  leaf3Width?: number;
  leafs?: number;
  scheduleComments?: number;
  menaComments?: number;
  qty: number;
}

function cellToString(cell: ExcelJS.Cell): string {
  let v: unknown = cell.value;
  if (v !== null && typeof v === 'object') {
    if ('result' in v) {
      v = (v as { result?: unknown }).result;
    } else if ('richText' in v) {
      const rt = (v as { richText?: Array<{ text?: string }> }).richText;
      v = Array.isArray(rt) ? rt.map((t) => t.text ?? '').join('') : '';
    } else if ('text' in v) {
      v = (v as { text?: unknown }).text;
    }
  }
  if (v === null || v === undefined) return '';
  return String(v).replace(/\s+/g, ' ').trim();
}

function normalizeHeader(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function matchColumns(row: ExcelJS.Row, maxCol: number): ColumnMap | null {
  const found: Partial<ColumnMap> = {};
  for (let c = 1; c <= maxCol; c++) {
    const raw = cellToString(row.getCell(c));
    if (!raw) continue;
    const h = normalizeHeader(raw);
    if (h === 'door level' && !found.doorLevel) found.doorLevel = c;
    else if (h === 'door type' && !found.doorType) found.doorType = c;
    else if ((h === 'door apt' || h === 'door apt #') && !found.doorApt) found.doorApt = c;
    else if (h === 'room name' && !found.roomName) found.roomName = c;
    else if (h === 'frame type' && !found.frameType) found.frameType = c;
    else if (h === 'frl' && !found.frl) found.frl = c;
    else if (h === 'leaf type' && !found.leafType) found.leafType = c;
    else if (h === 'leaf height' && !found.leafHeight) found.leafHeight = c;
    else if (h === 'leaf 1 width' && !found.leaf1Width) found.leaf1Width = c;
    else if (h === 'leaf 2 width' && !found.leaf2Width) found.leaf2Width = c;
    else if (h === 'leaf 3 width' && !found.leaf3Width) found.leaf3Width = c;
    else if (h === 'leafs' && !found.leafs) found.leafs = c;
    else if (h === 'door schedule comments' && !found.scheduleComments) found.scheduleComments = c;
    else if (h === 'mena contractors comments' && !found.menaComments) found.menaComments = c;
    else if (h === 'qty' && !found.qty) found.qty = c;
  }

  if (found.roomName && found.qty) {
    return found as ColumnMap;
  }
  return null;
}

function findQuotationSheet(wb: ExcelJS.Workbook): {
  ws: ExcelJS.Worksheet;
  headerRow: number;
  cols: ColumnMap;
} {
  let best: {
    score: number;
    ws: ExcelJS.Worksheet;
    headerRow: number;
    cols: ColumnMap;
  } | null = null;

  for (const ws of wb.worksheets) {
    if (ws.rowCount < 3 || ws.columnCount < 5) continue;
    const scanLimit = Math.min(20, ws.rowCount);
    const maxCol = Math.min(80, ws.columnCount);

    for (let r = 1; r <= scanLimit; r++) {
      const cols = matchColumns(ws.getRow(r), maxCol);
      if (!cols) continue;

      let score = 10;
      const nameLower = ws.name.toLowerCase();
      if (nameLower.includes('quotation') || nameLower.includes('quote')) score += 20;
      if (nameLower.includes('door schedule')) score += 10;
      if (nameLower.includes('vary') || nameLower.includes('profile') || nameLower.includes('invoice')) {
        score -= 15;
      }
      if (cols.frl) score += 5;
      if (cols.leafs) score += 5;
      if (cols.leafHeight && cols.leaf1Width) score += 5;

      if (!best || score > best.score) {
        best = { score, ws, headerRow: r, cols };
      }
      break;
    }
  }

  if (!best) {
    throw new Error(
      'Could not find a quotation Door Schedule sheet with "Room Name" and "QTY" columns.'
    );
  }

  return { ws: best.ws, headerRow: best.headerRow, cols: best.cols };
}

function isPlaceholder(val: string): boolean {
  const t = val.trim();
  return t === '' || t === '.' || t === '-';
}

function isExcludedValue(val: string): boolean {
  if (!val) return false;
  return /\bexcluded\b|\bexcl\.?\b|\(ex\.?\)|^ex\.?$/i.test(val.trim());
}

export function normalizeClassification(frl: string, leafType: string): string | null {
  const f = frl.trim();
  if (f && f !== '-' && f !== '.' && !/^-+\/-+\/-+$/.test(f)) {
    if (/\d/.test(f)) {
      return 'FIRE RATED';
    }
  }
  const lt = leafType.trim().toUpperCase();
  if (lt === 'FD' || lt.startsWith('FR')) {
    return 'FIRE RATED';
  }
  if (f === '-/-/-' || f === '-' || lt === 'SC' || lt === 'HC' || lt === 'SC1') {
    return 'NON RATED';
  }
  return f ? 'NON RATED' : null;
}

export function normalizeLeaf(leafsRaw: string, frameTypeRaw: string): string | null {
  const frame = frameTypeRaw.trim().toUpperCase();
  const isCavity =
    frame === 'CS' ||
    frame.includes('POCKET SLIDER') ||
    frame.includes('CAVITY');

  const l = leafsRaw.trim().toUpperCase();
  if (!l || l === '.' || l === '-') return null;

  if (l === '1' || l === 'SINGLE') {
    return isCavity ? 'CAVITY SINGLE' : 'SINGLE';
  }
  if (l === '2' || l === 'DOUBLE') {
    return isCavity ? 'CAVITY DOUBLE' : 'DOUBLE';
  }
  if (l === '3' || l === 'TRIPLE') {
    return 'TRIPLE';
  }
  return l;
}

function parsePositiveNumber(raw: string): number | null {
  if (!raw || raw === '-' || raw === '.') return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

export function normalizeDoorSize(
  heightRaw: string,
  w1Raw: string,
  w2Raw: string,
  w3Raw: string
): string | null {
  const h = parsePositiveNumber(heightRaw);
  const w1 = parsePositiveNumber(w1Raw);
  if (!h || !w1) return null;

  const widths = [w1];
  const w2 = parsePositiveNumber(w2Raw);
  if (w2) widths.push(w2);
  const w3 = parsePositiveNumber(w3Raw);
  if (w3) widths.push(w3);

  return `${h}x${widths.join('+')}`;
}

export async function parseQuotationWorkbook(
  buffer: ArrayBuffer | Uint8Array
): Promise<QuotationParseResult> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as ArrayBuffer);

  const { ws, headerRow, cols } = findQuotationSheet(wb);

  const doors: ParsedQuotationDoor[] = [];
  const issues: ParseIssue[] = [];
  let excludedCount = 0;
  let skippedCount = 0;
  let totalDataRowsScanned = 0;

  const get = (row: ExcelJS.Row, col?: number) =>
    col ? cellToString(row.getCell(col)) : '';

  for (let r = headerRow + 1; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const doorLevel = get(row, cols.doorLevel);
    const doorType = get(row, cols.doorType);
    const doorApt = get(row, cols.doorApt);
    const roomName = get(row, cols.roomName);
    const frameType = get(row, cols.frameType);
    const frl = get(row, cols.frl);
    const leafType = get(row, cols.leafType);
    const leafHeight = get(row, cols.leafHeight);
    const leaf1Width = get(row, cols.leaf1Width);
    const leaf2Width = get(row, cols.leaf2Width);
    const leaf3Width = get(row, cols.leaf3Width);
    const leafs = get(row, cols.leafs);
    const schedComments = get(row, cols.scheduleComments);
    const menaComments = get(row, cols.menaComments);
    const qtyRaw = get(row, cols.qty);

    // Skip blank rows, placeholder dot/dash rows (e.g. bottom SUM row), or section headers
    if (
      isPlaceholder(doorType) &&
      isPlaceholder(roomName) &&
      isPlaceholder(frl) &&
      isPlaceholder(leafs)
    ) {
      if (!isPlaceholder(doorLevel) || !isPlaceholder(qtyRaw)) skippedCount++;
      continue;
    }

    totalDataRowsScanned++;
    const rawRef = [doorLevel, doorApt, doorType].filter(Boolean).join(' · ') || `Row ${r}`;

    // Check exclusion markers across key columns
    if (
      isExcludedValue(doorType) ||
      isExcludedValue(roomName) ||
      isExcludedValue(frameType) ||
      isExcludedValue(frl) ||
      isExcludedValue(qtyRaw) ||
      isExcludedValue(schedComments) ||
      isExcludedValue(menaComments)
    ) {
      excludedCount++;
      continue;
    }

    // Rows without a valid positive integer QTY (e.g. "Door size changed" duplicate annotation rows or "." placeholders)
    if (!qtyRaw || qtyRaw === '.' || qtyRaw === '-') {
      skippedCount++;
      continue;
    }

    const qtyNum = Number(qtyRaw);
    if (!Number.isFinite(qtyNum) || qtyNum <= 0 || !Number.isInteger(qtyNum)) {
      issues.push({
        row: r,
        severity: 'warning',
        message: `Skipped row with non-integer QTY "${qtyRaw}"`,
        rawRef,
      });
      skippedCount++;
      continue;
    }

    if (!roomName) {
      issues.push({
        row: r,
        severity: 'error',
        message: 'Missing Room Name for row with valid QTY',
        rawRef,
      });
      continue;
    }

    const classification = normalizeClassification(frl, leafType);
    const leaf = normalizeLeaf(leafs, frameType);
    const doorSize = normalizeDoorSize(leafHeight, leaf1Width, leaf2Width, leaf3Width);

    if (!classification) {
      issues.push({
        row: r,
        severity: 'warning',
        message: 'Could not determine fire rating classification from FRL/Leaf Type',
        rawRef,
      });
    }
    if (!leaf) {
      issues.push({
        row: r,
        severity: 'warning',
        message: `Unrecognized leaf configuration "${leafs}"`,
        rawRef,
      });
    }
    if (!doorSize) {
      issues.push({
        row: r,
        severity: 'warning',
        message: 'Missing or invalid leaf dimensions (height/width)',
        rawRef,
      });
    }

    doors.push({
      door_ref: rawRef,
      room_name: roomName.toUpperCase(),
      classification,
      leaf,
      door_size: doorSize,
      qty: qtyNum,
      source_row: r,
    });
  }

  // Group doors by normalized attributes
  const groupMap = new Map<string, ParsedDoorGroupPreview>();
  for (const d of doors) {
    const key = [
      d.room_name,
      d.classification ?? 'UNKNOWN',
      d.leaf ?? 'UNKNOWN',
      d.door_size ?? 'UNKNOWN',
    ].join(' | ');

    const existing = groupMap.get(key);
    if (existing) {
      existing.door_qty += d.qty;
      existing.source_rows.push(d.source_row);
    } else {
      groupMap.set(key, {
        position: groupMap.size + 1,
        group_key: key,
        room_name: d.room_name,
        classification: d.classification,
        leaf: d.leaf,
        door_size: d.door_size,
        door_qty: d.qty,
        source_rows: [d.source_row],
      });
    }
  }

  const groups = Array.from(groupMap.values());
  const totalDoorQty = doors.reduce((sum, d) => sum + d.qty, 0);

  const report: Record<string, unknown> = {
    sheetName: ws.name,
    headerRow,
    totalDataRowsScanned,
    parsedDoorRows: doors.length,
    totalDoorQty,
    doorGroupsCount: groups.length,
    excludedCount,
    skippedCount,
    warningCount: issues.filter((i) => i.severity === 'warning').length,
    errorCount: issues.filter((i) => i.severity === 'error').length,
    issues: issues.slice(0, 100),
  };

  return {
    sheetName: ws.name,
    headerRow,
    totalDataRowsScanned,
    doors,
    groups,
    totalDoorQty,
    excludedCount,
    skippedCount,
    issues,
    report,
  };
}
