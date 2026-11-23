import type ExcelJS from 'exceljs';
// Relative path (not '@/') so the parser also loads in the Playwright tests.
import { loadExcelJS } from '../../lib/loadExcelJS';
import { commentItems } from './doorFlags';
import { makeGroupKey, typicalDoorOf } from './groupKey';
import {
  ACTIVITY_COLUMNS,
  activitiesToken,
  activityQuantities,
  activityRates,
  type ActivityKey,
  type DoorActivities,
} from './doorActivities';

export interface ParsedQuotationDoor {
  door_ref: string;
  door_tag: string;
  room_name: string;
  classification: string | null;
  leaf: string | null;
  door_size: string | null;
  qty: number;
  source_row: number;
  /** The door's hardware columns, e.g. "Closer · Lock · ES: RS" ('' when none). */
  hardware: string;
  /**
   * Extra hinges per door from the EXTRA HINGE (FR) column (9 = one hinge);
   * 0 when blank, null when the sheet has no such column.
   */
  extra_hinges: number | null;
  /** Door schedule and Mena comments, joined with " | " ('' when none). */
  comments: string;
  /** Parts its PREPARATION / INSTALLATION costs call for, with quantities (see doorActivities.ts). */
  activities: DoorActivities;
}

export interface ParsedDoorGroupPreview {
  position: number;
  group_key: string;
  door_tag: string;
  room_name: string;
  classification: string | null;
  leaf: string | null;
  door_size: string | null;
  door_qty: number;
  source_rows: number[];
  /** The hardware every door in the group has ('' when none). */
  hardware: string;
  /** The room with the most doors in the group, used for matching a merged group. */
  match_room: string;
  /** Extra hinges per door (the same for every door in the group; see ParsedQuotationDoor). */
  extra_hinges: number | null;
  /** Prep / install activities of every door in the group (part of the hardware, so the same). */
  activities: DoorActivities;
}

export interface ParseIssue {
  row: number;
  severity: 'warning' | 'error';
  message: string;
  rawRef?: string;
  /** 'row': about one row. 'total' / 'group': worked out from all doors (recomputed on include). */
  kind?: 'row' | 'total' | 'group';
}

/** A row left out of scope, with why. Rows with a numeric QTY can be included again. */
export interface ExcludedQuotationRow {
  row: number;
  rawRef: string;
  room_name: string;
  reason: string;
  qty: number | null;
  /** The door this row would add when included (null when it has no usable QTY / room). */
  door: ParsedQuotationDoor | null;
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
  excluded: ExcludedQuotationRow[];
  /** The sheet's own total of the QTY column (a SUM / SUBTOTAL formula), when it has one. */
  sheetQtyTotal: number | null;
  sheetQtyTotalRow: number | null;
  /** Excluded rows the estimator chose to include (see applyRowInclusions). */
  includedRows: number[];
  /** Prep / install activity columns the sheet has (an activity is only flagged as missing when its column is there). */
  activityColumns: ActivityKey[];
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
  extraHinge?: number;
  qty: number;
  /** PREPARATION / INSTALLATION COST activity columns: [activity, column]. */
  activities: Array<[ActivityKey, number]>;
  /** Hardware columns found, in sheet order: [label, column]. */
  hardware: Array<[string, number]>;
}

/** Hardware columns of the Mena door schedule and the short label shown for each. */
const HARDWARE_COLUMNS: Record<string, string> = {
  'self closing': 'Closer',
  'fire seal': 'Fire seal',
  'smoke seal': 'Smoke seal',
  hinge: 'Hinge',
  handle: 'Handle',
  lock: 'Lock',
  latch: 'Latch',
  bolt: 'Bolt',
  'door stop': 'Stop',
  keying: 'Keying',
  'door grille': 'Grille',
  'electric strike': 'ES',
};

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

/** The result of a SUM / SUBTOTAL formula cell, or null for anything else. */
function sumFormulaResult(cell: ExcelJS.Cell): number | null {
  const v = cell.value as unknown;
  if (v === null || typeof v !== 'object') return null;
  const o = v as { formula?: unknown; sharedFormula?: unknown; result?: unknown };
  const formula = typeof o.formula === 'string' ? o.formula : typeof o.sharedFormula === 'string' ? o.sharedFormula : '';
  if (!/\b(SUM|SUBTOTAL)\s*\(/i.test(formula)) return null;
  return typeof o.result === 'number' && Number.isFinite(o.result) ? o.result : null;
}

function normalizeHeader(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function matchColumns(row: ExcelJS.Row, maxCol: number): ColumnMap | null {
  const found: Partial<ColumnMap> = {};
  const hardware: Array<[string, number]> = [];
  const seenHardware = new Set<string>();
  const activities: Array<[ActivityKey, number]> = [];
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
    else if (h === 'extra hinge fr' && !found.extraHinge) found.extraHinge = c;
    else if (h in ACTIVITY_COLUMNS) activities.push([ACTIVITY_COLUMNS[h], c]);
    else if (h in HARDWARE_COLUMNS && !seenHardware.has(h)) {
      seenHardware.add(h);
      hardware.push([HARDWARE_COLUMNS[h], c]);
    }
  }

  if (found.roomName && found.qty) {
    return { ...(found as ColumnMap), hardware, activities };
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

/**
 * Rows marked as not in Mena's hardware scope: "EXCLUDED", "Excl.", "(Ex.)", "Ex."
 * and "BY OTHERS" / "SUPPLIED BY OTHERS" / "BY OTHER". Used on the door's own
 * cells (door type, room, frame, FRL, QTY).
 */
export function isExcludedValue(val: string): boolean {
  if (!val) return false;
  return /\bexcluded\b|\bexcl\.?\b|\(ex\.?\)|^ex\.?$|\bby\s+others?\b/i.test(val.trim());
}

/**
 * A comment that puts the whole door out of scope: it starts with the marker
 * ("EXCLUDED", "Ex. GLAZED", "By others", "Door supplied by others").
 * "CR Card Reader by others" is about one item, so it does not exclude the door.
 */
export function isWholeDoorExclusionComment(val: string): boolean {
  if (!val) return false;
  return /^\s*(\(?\s*ex(cl)?\.?\s*\)?(\s|$|[.:,;-])|excluded\b|(the\s+)?(doors?\s+(and\s+frames?\s+)?)?(to\s+be\s+)?((supplied|supply)(\s+(and|&)\s+(installed|install))?\s+|installed\s+)?by\s+others?\b)/i.test(
    val
  );
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

/**
 * Group doors into typical doors: the same door type, classification, leaf,
 * size and hardware (the group key; see groupKey.ts). Doors of one door type
 * in different rooms are one group, named after its rooms as written in the
 * file ("Services cupboard / Services cupboard - B1 & B2"); a door whose
 * hardware differs gets its own group. Doors without a door type are grouped
 * per room.
 */
export function groupDoors(doors: ParsedQuotationDoor[]): ParsedDoorGroupPreview[] {
  const groupMap = new Map<string, ParsedDoorGroupPreview>();
  const roomsOf = new Map<string, Map<string, string>>(); // key -> ROOM -> room as first written
  const roomQty = new Map<string, Map<string, number>>(); // key -> ROOM -> doors
  for (const d of doors) {
    const key = makeGroupKey({
      tag: d.door_tag,
      room: d.room_name,
      classification: d.classification,
      leaf: d.leaf,
      size: d.door_size,
      hardware: d.hardware,
    });

    const rooms = roomsOf.get(key) ?? new Map<string, string>();
    roomsOf.set(key, rooms);
    const roomKey = d.room_name.replace(/\s+/g, ' ').trim().toUpperCase();
    if (!rooms.has(roomKey)) rooms.set(roomKey, d.room_name.replace(/\s+/g, ' ').trim());
    const qtys = roomQty.get(key) ?? new Map<string, number>();
    roomQty.set(key, qtys);
    qtys.set(roomKey, (qtys.get(roomKey) ?? 0) + d.qty);

    const existing = groupMap.get(key);
    if (existing) {
      existing.door_qty += d.qty;
      existing.source_rows.push(d.source_row);
      existing.room_name = [...rooms.values()].join(' / ');
    } else {
      groupMap.set(key, {
        position: groupMap.size + 1,
        group_key: key,
        door_tag: d.door_tag,
        room_name: d.room_name,
        classification: d.classification,
        leaf: d.leaf,
        door_size: d.door_size,
        door_qty: d.qty,
        source_rows: [d.source_row],
        hardware: d.hardware,
        match_room: d.room_name,
        extra_hinges: d.extra_hinges,
        activities: d.activities,
      });
    }
  }
  for (const [key, g] of groupMap) {
    // Most doors wins; on a tie, the room seen first.
    let best = '';
    let bestQty = -1;
    for (const [room, qty] of roomQty.get(key) ?? []) {
      if (qty > bestQty) [best, bestQty] = [room, qty];
    }
    g.match_room = roomsOf.get(key)?.get(best) ?? g.room_name;
  }
  return Array.from(groupMap.values());
}

/** Issues worked out from all the doors: the sheet total, and groups split by hardware. */
function summaryIssues(
  doors: ParsedQuotationDoor[],
  groups: ParsedDoorGroupPreview[],
  excluded: ExcludedQuotationRow[],
  includedRows: Set<number>,
  sheetQtyTotal: number | null,
  sheetQtyTotalRow: number | null
): ParseIssue[] {
  const issues: ParseIssue[] = [];
  const totalDoorQty = doors.reduce((sum, d) => sum + d.qty, 0);

  if (sheetQtyTotal !== null && sheetQtyTotal !== totalDoorQty) {
    const diff = sheetQtyTotal - totalDoorQty;
    const candidates = excluded.filter((e) => e.qty !== null && !includedRows.has(e.row));
    const hint = candidates.length
      ? ` Excluded rows that have a QTY: ${candidates
          .slice(0, 12)
          .map((e) => `row ${e.row} (${e.qty})`)
          .join(', ')}${candidates.length > 12 ? ', …' : ''}.`
      : '';
    issues.push({
      row: sheetQtyTotalRow ?? 0,
      severity: 'error',
      kind: 'total',
      rawRef: 'QTY total',
      message: `The sheet's QTY total is ${sheetQtyTotal} but ${totalDoorQty} doors were read (${
        diff > 0 ? `${diff} missing` : `${-diff} extra`
      }).${hint}`,
    });
  }

  // One door type split by hardware: say so, so the groups aren't a surprise.
  const byBase = new Map<string, ParsedDoorGroupPreview[]>();
  for (const g of groups) {
    const base = typicalDoorOf(g.group_key);
    byBase.set(base, [...(byBase.get(base) ?? []), g]);
  }
  for (const split of byBase.values()) {
    if (split.length < 2) continue;
    const g = split[0];
    issues.push({
      row: g.source_rows[0],
      severity: 'warning',
      kind: 'group',
      rawRef: [g.door_tag, g.room_name].filter(Boolean).join(' · '),
      message: `Split into ${split.length} door groups because the hardware differs: ${split
        .map((s) => `${s.door_qty} × ${s.hardware || 'no hardware'}`)
        .join('; ')}.`,
    });
  }
  return issues;
}

function buildReport(r: Omit<QuotationParseResult, 'report'>): Record<string, unknown> {
  return {
    sheetName: r.sheetName,
    headerRow: r.headerRow,
    totalDataRowsScanned: r.totalDataRowsScanned,
    parsedDoorRows: r.doors.length,
    totalDoorQty: r.totalDoorQty,
    sheetQtyTotal: r.sheetQtyTotal,
    doorGroupsCount: r.groups.length,
    excludedCount: r.excludedCount,
    includedRows: r.includedRows,
    skippedCount: r.skippedCount,
    warningCount: r.issues.filter((i) => i.severity === 'warning').length,
    errorCount: r.issues.filter((i) => i.severity === 'error').length,
    excluded: r.excluded.slice(0, 100).map((e) => ({ row: e.row, reason: e.reason, qty: e.qty })),
    issues: r.issues.slice(0, 100),
  };
}

/**
 * The parse with some excluded rows included again (by row number). Doors,
 * groups, totals and the summary issues are worked out again; the original
 * parse is not changed. Rows without a usable door are ignored.
 */
export function applyRowInclusions(
  result: QuotationParseResult,
  rows: Iterable<number>
): QuotationParseResult {
  const wanted = new Set(rows);
  const extra = result.excluded
    .filter((e) => e.door && wanted.has(e.row))
    .map((e) => e.door as ParsedQuotationDoor);
  const included = new Set(extra.map((d) => d.source_row));
  // Start from the parse without any earlier inclusions.
  const prior = new Set(result.includedRows);
  const doors = [...result.doors.filter((d) => !prior.has(d.source_row)), ...extra].sort(
    (a, b) => a.source_row - b.source_row
  );
  const groups = groupDoors(doors);
  const issues = [
    ...result.issues.filter((i) => (i.kind ?? 'row') === 'row'),
    ...summaryIssues(doors, groups, result.excluded, included, result.sheetQtyTotal, result.sheetQtyTotalRow),
  ];
  const next: Omit<QuotationParseResult, 'report'> = {
    ...result,
    doors,
    groups,
    totalDoorQty: doors.reduce((s, d) => s + d.qty, 0),
    excludedCount: result.excluded.length - included.size,
    issues,
    includedRows: [...included].sort((a, b) => a - b),
  };
  return { ...next, report: buildReport(next) };
}

export async function parseQuotationWorkbook(
  buffer: ArrayBuffer | Uint8Array
): Promise<QuotationParseResult> {
  const ExcelJSLib = await loadExcelJS();
  const wb = new ExcelJSLib.Workbook();
  await wb.xlsx.load(buffer as ArrayBuffer);

  const { ws, headerRow, cols } = findQuotationSheet(wb);

  const doors: ParsedQuotationDoor[] = [];
  const issues: ParseIssue[] = [];
  const excluded: ExcludedQuotationRow[] = [];
  let skippedCount = 0;
  let totalDataRowsScanned = 0;
  let sheetQtyTotal: number | null = null;
  let sheetQtyTotalRow: number | null = null;

  const get = (row: ExcelJS.Row, col?: number) =>
    col ? cellToString(row.getCell(col)) : '';

  for (let r = headerRow + 1; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);

    // The sheet's own total: the largest SUM / SUBTOTAL in the QTY column, so
    // per-level subtotals aren't mistaken for the grand total.
    const total = sumFormulaResult(row.getCell(cols.qty));
    if (total !== null && (sheetQtyTotal === null || total > sheetQtyTotal)) {
      sheetQtyTotal = total;
      sheetQtyTotalRow = r;
    }

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
    // EXTRA HINGE (FR): 9 per extra hinge on the door (a double with 18 has one per leaf).
    const extraHingeRaw = Number(get(row, cols.extraHinge));
    const extraHinges = cols.extraHinge
      ? Number.isFinite(extraHingeRaw) && extraHingeRaw > 0
        ? Math.max(1, Math.round(extraHingeRaw / 9))
        : 0
      : null;
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
    const qtyNum = Number(qtyRaw);
    const qtyOk = !isPlaceholder(qtyRaw) && Number.isInteger(qtyNum) && qtyNum > 0;

    // The door's hardware: the hardware columns, then items its comments ask
    // for (kick plate, Vingcard, card reader, viewer). Doors are grouped by it.
    const hardware = [
      ...cols.hardware.map(([label, col]) => {
        const v = get(row, col).replace(/\|/g, '/');
        // "-", N, No, None, N/A, 0: no such hardware on this door.
        if (isPlaceholder(v) || /^(n\/?a|n|no|none|nil|0)$/i.test(v)) return '';
        return /^y(es)?$/i.test(v) ? label : `${label}: ${v.toUpperCase()}`;
      }),
      ...commentItems([schedComments, menaComments].join(' ')),
      extraHinges ? `Extra hinge ×${extraHinges}` : '',
    ]
      .filter(Boolean)
      .join(' · ');

    const activityRaw: DoorActivities = {};
    for (const [key, col] of cols.activities) {
      const v = Number(get(row, col));
      if (Number.isFinite(v) && v > 0) activityRaw[key] = Math.max(activityRaw[key] ?? 0, v);
    }

    const makeDoor = (cleanEx: boolean): ParsedQuotationDoor => {
      const clean = (s: string) => (cleanEx ? s.replace(/\s*\(ex\.?\)\s*/gi, ' ').trim() : s.trim());
      const tag = isPlaceholder(doorType) ? '' : clean(doorType);
      return {
        door_ref: rawRef,
        door_tag: tag,
        // As written in the quotation (the group key compares it case-insensitively).
        room_name: clean(roomName),
        classification: normalizeClassification(frl, leafType),
        leaf: normalizeLeaf(leafs, frameType),
        door_size: normalizeDoorSize(leafHeight, leaf1Width, leaf2Width, leaf3Width),
        qty: qtyNum,
        source_row: r,
        hardware,
        extra_hinges: extraHinges,
        comments: [schedComments, menaComments].filter(Boolean).join(' | '),
        // Raw costs for now; turned into quantities once every row is read.
        activities: { ...activityRaw },
      };
    };

    // Out of scope: an exclusion marker in the door's own cells, or a comment
    // that starts with one. A comment that only mentions an item "by others"
    // (e.g. "CR Card Reader by others") keeps the door, with a warning.
    const cellMarks: Array<[string, string]> = [
      ['Door Type', doorType],
      ['Room Name', roomName],
      ['Frame Type', frameType],
      ['FRL', frl],
      ['QTY', qtyRaw],
    ];
    const commentMarks: Array<[string, string]> = [
      ['Door Schedule Comments', schedComments],
      ['Mena Contractors Comments', menaComments],
    ];
    const cellHit = cellMarks.find(([, v]) => isExcludedValue(v));
    const commentHit = commentMarks.find(([, v]) => isWholeDoorExclusionComment(v));
    const hit = cellHit ?? commentHit;
    if (hit) {
      excluded.push({
        row: r,
        rawRef,
        room_name: roomName,
        reason: `${hit[0]}: "${hit[1].length > 80 ? `${hit[1].slice(0, 80)}…` : hit[1]}"`,
        qty: qtyOk ? qtyNum : null,
        door: qtyOk && roomName ? makeDoor(true) : null,
      });
      continue;
    }
    const mention = commentMarks.find(([, v]) => isExcludedValue(v));
    if (mention && qtyOk) {
      issues.push({
        row: r,
        severity: 'warning',
        kind: 'row',
        message: `Kept: the comment mentions something by others / excluded, not the whole door — "${
          mention[1].length > 90 ? `${mention[1].slice(0, 90)}…` : mention[1]
        }"`,
        rawRef,
      });
    }

    // Rows without a valid positive integer QTY (e.g. "Door size changed" duplicate annotation rows or "." placeholders)
    if (isPlaceholder(qtyRaw)) {
      skippedCount++;
      continue;
    }

    if (!qtyOk) {
      issues.push({
        row: r,
        severity: 'warning',
        kind: 'row',
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
        kind: 'row',
        message: 'Missing Room Name for row with valid QTY',
        rawRef,
      });
      continue;
    }

    const door = makeDoor(false);

    if (!door.classification) {
      issues.push({
        row: r,
        severity: 'warning',
        kind: 'row',
        message: 'Could not determine fire rating classification from FRL/Leaf Type',
        rawRef,
      });
    }
    if (!door.leaf) {
      issues.push({
        row: r,
        severity: 'warning',
        kind: 'row',
        message: `Unrecognized leaf configuration "${leafs}"`,
        rawRef,
      });
    }
    if (!door.door_size) {
      issues.push({
        row: r,
        severity: 'warning',
        kind: 'row',
        message: 'Missing or invalid leaf dimensions (height/width)',
        rawRef,
      });
    }

    doors.push(door);
  }

  // Prep / install costs -> quantities (cost / the column's usual single cost),
  // then part of each door's hardware so doors in a group need the same parts.
  const allDoors = [...doors, ...excluded.flatMap((e) => (e.door ? [e.door] : []))];
  const leavesOf = (d: ParsedQuotationDoor) =>
    Math.max(1, (d.door_size?.split('x')[1] ?? '').split('+').filter(Boolean).length);
  const rates = activityRates(allDoors.map((d) => ({ raw: d.activities, leaves: leavesOf(d) })));
  for (const d of allDoors) {
    d.activities = activityQuantities(d.activities, leavesOf(d), rates);
    d.hardware = [d.hardware, activitiesToken(d.activities)].filter(Boolean).join(' · ');
  }

  const groups = groupDoors(doors);
  issues.push(...summaryIssues(doors, groups, excluded, new Set(), sheetQtyTotal, sheetQtyTotalRow));
  const totalDoorQty = doors.reduce((sum, d) => sum + d.qty, 0);

  const result: Omit<QuotationParseResult, 'report'> = {
    sheetName: ws.name,
    headerRow,
    totalDataRowsScanned,
    doors,
    groups,
    totalDoorQty,
    excludedCount: excluded.length,
    skippedCount,
    issues,
    excluded,
    sheetQtyTotal,
    sheetQtyTotalRow,
    includedRows: [],
    activityColumns: [...new Set(cols.activities.map(([key]) => key))],
  };
  return { ...result, report: buildReport(result) };
}
