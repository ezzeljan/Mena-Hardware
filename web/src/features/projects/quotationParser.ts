import type ExcelJS from 'exceljs';
// Relative path (not '@/') so the parser also loads in the Playwright tests.
import { loadExcelJS } from '../../lib/loadExcelJS';
import { commentItems, NEEDS_CONFIRMATION } from './doorFlags';
import { fontColorOf, isGreenFill, isRedFill, themeColorsOf } from './rowColor';
import { makeGroupKey, parseGroupKey, typicalDoorOf } from './groupKey';
import {
  ACTIVITY_COLUMNS,
  ACTIVITY_LABEL,
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
  /** The Door Schedule Comments column ('' when none). */
  schedule_comments?: string;
  /** The Mena Contractors comments columns, joined with " | " ('' when none). */
  mena_comments?: string;
  /** Comments written in blue or red in the quotation, by text (the rest are black). */
  comment_colors?: Record<string, 'blue' | 'red'>;
  /** Parts its PREPARATION / INSTALLATION costs call for, with quantities (see doorActivities.ts). */
  activities: DoorActivities;
  /**
   * LOCK PREP / LOCK INST costs: "15", "25", or "25/70" when they differ
   * ('' when none or excluded). They say what lock the door needs (lockRules.ts).
   */
  lock_cost: string;
  /**
   * The prep / install cells as written, by item ("Closer" -> "44",
   * "Extra hinge" -> "9"); shown beside each item, not part of the group key.
   */
  prep_values?: Record<string, string>;
  /** On a green row: a door added in a variation. */
  variation: boolean;
}

/**
 * A variation row. Green ('added'): with a QTY it's a door added in the
 * variation; without one it isn't counted. Red ('removed'): the door is
 * excluded even with a QTY.
 */
export interface VariationRow {
  row: number;
  rawRef: string;
  room_name: string;
  qty: number | null;
  kind: 'added' | 'removed';
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
  /** LOCK PREP / LOCK INST of every door in the group (part of the hardware, so the same). */
  lock_cost: string;
  /** Each prep / install item's cell values across the group's doors ("22" or "22/44"). */
  prep_values?: Record<string, string>;
}

export interface ParseIssue {
  row: number;
  severity: 'warning' | 'error';
  message: string;
  rawRef?: string;
  /** 'row': about one row. 'total' / 'group': worked out from all doors (recomputed on include). */
  kind?: 'row' | 'total' | 'group';
  /** A room's doors split into door groups by hardware: each group (shown as its own row). */
  splits?: IssueSplit[];
}

export interface IssueSplit {
  position: number;
  door_tag: string;
  door_qty: number;
  source_rows: number[];
  hardware: string;
  prep_values?: Record<string, string>;
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
  /** Green (variation) rows, in sheet order. */
  variationRows: VariationRow[];
  /** Each HW column: its label in the hardware text ("Closer") and header in the sheet ("Self Closing"), in sheet order. */
  hardwareHeaders: Array<[label: string, header: string]>;
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
  /**
   * Every Mena Contractors comments column: the unnamed one(s) between Door
   * Schedule Comments and Mena Contractors Comments, then that column.
   */
  menaCommentCols: number[];
  extraHinge?: number;
  lockPrep?: number;
  lockInst?: number;
  qty: number;
  /** PREPARATION / INSTALLATION COST activity columns: [activity, column]. */
  activities: Array<[ActivityKey, number]>;
  /** Hardware columns found, in sheet order: [label, column]. */
  hardware: Array<[label: string, column: number, header: string]>;
}

/**
 * Hardware columns of the Mena door schedule and the short label shown for
 * each (headers as normalizeHeader gives them). Columns under an "HW" /
 * "HARDWARE" heading are hardware too, whatever they're called (labelled as
 * written).
 */
const HARDWARE_COLUMNS: Record<string, string> = {
  'self closing': 'Closer',
  closer: 'Closer',
  closers: 'Closer',
  'fire seal': 'Fire seal',
  'smoke seal': 'Smoke seal',
  'drop seal': 'Drop seal',
  hinge: 'Hinge',
  hinges: 'Hinge',
  handle: 'Handle',
  handles: 'Handle',
  lock: 'Lock',
  lockset: 'Lock',
  latch: 'Latch',
  bolt: 'Bolt',
  stop: 'Stop',
  stops: 'Stop',
  'door stop': 'Stop',
  'door stops': 'Stop',
  keying: 'Keying',
  'door grille': 'Grille',
  'electric strike': 'ES',
  'reed switch': 'Reed switch',
  kickplate: 'Kick plate',
  'kick plate': 'Kick plate',
  'kick plates': 'Kick plate',
  'card reader': 'Card reader',
  'door viewer': 'Viewer',
};

/** Headings over the hardware columns (the row above the column headers). */
const HARDWARE_BAND = /^(hw|hardware|door hardware)$/;

/** Columns under an "HW" / "HARDWARE" heading in the rows just above the header row. */
function hardwareBandColumns(ws: ExcelJS.Worksheet, headerRow: number, maxCol: number): Set<number> {
  const cols = new Set<number>();
  for (let rr = Math.max(1, headerRow - 3); rr < headerRow; rr++) {
    const row = ws.getRow(rr);
    for (let c = 1; c <= maxCol; c++) {
      const cell = row.getCell(c);
      const text = normalizeHeader(cellToString(cell.isMerged ? cell.master : cell));
      if (HARDWARE_BAND.test(text)) cols.add(c);
    }
  }
  return cols;
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

function matchColumns(row: ExcelJS.Row, maxCol: number, hwBand: Set<number> = new Set()): ColumnMap | null {
  const found: Partial<ColumnMap> = {};
  const hardware: Array<[string, number, string]> = [];
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
    else if (found.qty && h === 'lock prep' && !found.lockPrep) found.lockPrep = c;
    else if (found.qty && h === 'lock inst' && !found.lockInst) found.lockInst = c;
    // Hardware is in the door schedule, left of QTY; the prep / install
    // costs are right of it (both can have a "Stop" or "Closer" column).
    else if (!found.qty && (h in HARDWARE_COLUMNS || hwBand.has(c))) {
      if (!seenHardware.has(h)) {
        seenHardware.add(h);
        // Under the HW heading but not a column we know: labelled as written.
        hardware.push([HARDWARE_COLUMNS[h] ?? raw, c, raw]);
      }
    } else if (h in ACTIVITY_COLUMNS) activities.push([ACTIVITY_COLUMNS[h], c]);
  }

  if (found.roomName && found.qty) {
    // The COMMENTS band: Door Schedule Comments, an unnamed column, Mena
    // Contractors Comments. The unnamed one is also Mena's.
    const menaCommentCols: number[] = [];
    if (found.menaComments) {
      if (found.scheduleComments && found.scheduleComments < found.menaComments) {
        for (let c = found.scheduleComments + 1; c < found.menaComments; c++) {
          if (!cellToString(row.getCell(c))) menaCommentCols.push(c);
        }
      }
      menaCommentCols.push(found.menaComments);
    }
    return { ...(found as ColumnMap), hardware, activities, menaCommentCols };
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
    // Wide enough for the prep / install columns (to about column 110).
    const maxCol = Math.min(160, ws.columnCount);

    for (let r = 1; r <= scanLimit; r++) {
      const cols = matchColumns(ws.getRow(r), maxCol, hardwareBandColumns(ws, r, maxCol));
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
 * Group doors into typical doors: the same room, classification, leaf, size
 * (height and widths) and hardware (the group key; see groupKey.ts). The door type doesn't change
 * the hardware, so doors of several door types in one room are one group that
 * lists them ("D-03 / D-04"). The room is compared ignoring capitals and
 * spacing; the group keeps it as first written. A door whose hardware differs
 * gets its own group.
 */
/** Item -> distinct values, joined with "/" ("22" + "44" -> "22/44"). */
export function joinValues(a: Record<string, string>, b: Record<string, string>): Record<string, string> {
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) {
    const seen = (out[k] ?? '').split('/').filter(Boolean);
    for (const x of v.split('/')) if (x && !seen.includes(x)) seen.push(x);
    out[k] = seen.join('/');
  }
  return out;
}

export function groupDoors(doors: ParsedQuotationDoor[]): ParsedDoorGroupPreview[] {
  const groupMap = new Map<string, ParsedDoorGroupPreview>();
  const roomsOf = new Map<string, Map<string, string>>(); // key -> ROOM -> room as first written
  const roomQty = new Map<string, Map<string, number>>(); // key -> ROOM -> doors
  const tagsOf = new Map<string, Map<string, string>>(); // key -> TAG -> tag as first written
  for (const d of doors) {
    const key = makeGroupKey({
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
    const tags = tagsOf.get(key) ?? new Map<string, string>();
    tagsOf.set(key, tags);
    const tag = d.door_tag.trim();
    if (tag && !tags.has(tag.toUpperCase())) tags.set(tag.toUpperCase(), tag);

    const existing = groupMap.get(key);
    if (existing) {
      existing.door_qty += d.qty;
      existing.source_rows.push(d.source_row);
      existing.prep_values = joinValues(existing.prep_values ?? {}, d.prep_values ?? {});
      existing.room_name = [...rooms.values()].join(' / ');
      existing.door_tag = [...tags.values()].join(' / ');
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
        lock_cost: d.lock_cost,
        prep_values: { ...d.prep_values },
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
  // Numbered A–Z by room name (then rating, leaf, size, first row), not in
  // the file's order, so every list and the export follow the same order.
  const text = (a: string | null, b: string | null) =>
    (a ?? '').localeCompare(b ?? '', undefined, { numeric: true, sensitivity: 'base' });
  return Array.from(groupMap.values())
    .sort(
      (a, b) =>
        text(a.room_name, b.room_name) ||
        text(a.classification, b.classification) ||
        text(a.leaf, b.leaf) ||
        text(a.door_size, b.door_size) ||
        a.source_rows[0] - b.source_rows[0]
    )
    .map((g, i) => ({ ...g, position: i + 1 }));
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

  // One room's doors split by hardware: say so, so the groups aren't a surprise.
  const byBase = new Map<string, ParsedDoorGroupPreview[]>();
  for (const g of groups) {
    const base = `${typicalDoorOf(g.group_key)} | ${parseGroupKey(g.group_key).room}`;
    byBase.set(base, [...(byBase.get(base) ?? []), g]);
  }
  for (const split of byBase.values()) {
    if (split.length < 2) continue;
    const g = split[0];
    issues.push({
      row: g.source_rows[0],
      severity: 'warning',
      kind: 'group',
      // With the size: several groups can share a room name.
      rawRef: [g.door_tag, g.room_name, g.door_size].filter(Boolean).join(' · '),
      message: `Split into ${split.length} door groups because the hardware differs.`,
      splits: split.map((s) => ({
        position: s.position,
        door_tag: s.door_tag,
        door_qty: s.door_qty,
        source_rows: [...s.source_rows],
        hardware: s.hardware,
        prep_values: s.prep_values,
      })),
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
    variationRowCount: r.variationRows.length,
    variationDoorsRemoved: r.variationRows.filter((v) => v.kind === 'removed').reduce((n, v) => n + (v.qty ?? 0), 0),
    variationDoorsAdded: r.doors.filter((d) => d.variation).reduce((n, d) => n + d.qty, 0),
    variationRows: r.variationRows.slice(0, 300),
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

/** Where parsing is up to, for a progress display. */
export type ParseStage = 'open' | 'sheet' | 'rows' | 'group';
export interface ParseProgress {
  stage: ParseStage;
  /** Rows read so far and in all (stage 'rows'). */
  done?: number;
  total?: number;
}

export async function parseQuotationWorkbook(
  buffer: ArrayBuffer | Uint8Array,
  onProgress?: (p: ParseProgress) => void,
): Promise<QuotationParseResult> {
  onProgress?.({ stage: 'open' });
  const ExcelJSLib = await loadExcelJS();
  const wb = new ExcelJSLib.Workbook();
  await wb.xlsx.load(buffer as ArrayBuffer);

  onProgress?.({ stage: 'sheet' });
  const { ws, headerRow, cols } = findQuotationSheet(wb);
  const rowTotal = Math.max(0, ws.rowCount - headerRow);
  onProgress?.({ stage: 'rows', done: 0, total: rowTotal });
  // About every 1% of the rows (enough for a smooth bar, not a message per row).
  const rowStep = Math.max(20, Math.ceil(rowTotal / 100));

  const doors: ParsedQuotationDoor[] = [];
  const issues: ParseIssue[] = [];
  const excluded: ExcludedQuotationRow[] = [];
  let skippedCount = 0;
  let totalDataRowsScanned = 0;
  let sheetQtyTotal: number | null = null;
  let sheetQtyTotalRow: number | null = null;

  const get = (row: ExcelJS.Row, col?: number) =>
    col ? cellToString(row.getCell(col)) : '';
  // Variation doors are on green rows (an RGB or a theme colour).
  const themeColors = themeColorsOf(
    String((wb as unknown as { _themes?: Record<string, string> })._themes?.theme1 ?? '')
  );
  const variationRows: VariationRow[] = [];

  for (let r = headerRow + 1; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    if (onProgress && (r - headerRow) % rowStep === 0) onProgress({ stage: 'rows', done: r - headerRow, total: rowTotal });

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
    // A comment typed once but merged across the comment columns is read once
    // (in the cell it starts in).
    const ownComment = (c?: number) => {
      if (!c) return '';
      const cell = row.getCell(c);
      return cell.isMerged && cell.master.address !== cell.address ? '' : get(row, c);
    };
    const menaComments = [...new Set(cols.menaCommentCols.map(ownComment).filter(Boolean))].join(' | ');
    // Comments in blue or red, by text (the rest are black).
    const commentColors: Record<string, 'blue' | 'red'> = {};
    for (const c of [cols.scheduleComments, ...cols.menaCommentCols]) {
      const text = ownComment(c).trim();
      const color = c && text ? fontColorOf(row.getCell(c), themeColors) : null;
      if (color && !commentColors[text]) commentColors[text] = color;
    }
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
    const rowCells = [cols.roomName, cols.doorType, cols.doorLevel].flatMap((c) => (c ? [row.getCell(c).fill] : []));
    const variation = rowCells.some((f) => isGreenFill(f, themeColors));
    const redRow = !variation && rowCells.some((f) => isRedFill(f, themeColors));
    if ((variation || redRow) && roomName) {
      variationRows.push({ row: r, rawRef, room_name: roomName, qty: qtyOk ? qtyNum : null, kind: redRow ? 'removed' : 'added' });
    }

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
      // A column and a comment can name the same item (Kick plate): once.
      .filter((v, i, all) => v && all.indexOf(v) === i)
      .join(' · ');

    const activityRaw: DoorActivities = {};
    const prepValues: Record<string, string> = {};
    for (const [key, col] of cols.activities) {
      const v = Number(get(row, col));
      if (Number.isFinite(v) && v > 0) {
        activityRaw[key] = Math.max(activityRaw[key] ?? 0, v);
        Object.assign(prepValues, joinValues(prepValues, { [ACTIVITY_LABEL[key]]: String(v) }));
      }
    }
    if (extraHinges) prepValues['Extra hinge'] = String(extraHingeRaw);

    // LOCK PREP / LOCK INST: the numbers say which lock (15 non-lockable, 25 mortice).
    const lockNum = (col?: number) => {
      const v = col ? get(row, col) : '';
      const n = Number(v);
      return v && Number.isFinite(n) && n > 0 ? String(n) : '';
    };
    const lockPrep = lockNum(cols.lockPrep);
    const lockInst = lockNum(cols.lockInst);
    const lockCost = !lockPrep && !lockInst ? '' : lockPrep === lockInst || !lockInst ? lockPrep : !lockPrep ? lockInst : `${lockPrep}/${lockInst}`;

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
        schedule_comments: schedComments,
        mena_comments: menaComments,
        comment_colors: { ...commentColors },
        // Raw costs for now; turned into quantities once every row is read.
        activities: { ...activityRaw },
        lock_cost: lockCost,
        prep_values: { ...prepValues },
        variation,
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
    // A red row is a door taken out in a variation, even with a QTY.
    const hit = cellHit ?? commentHit ?? (redRow ? (['Red row', 'excluded in variation'] as [string, string]) : undefined);
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

    // A comment that needs confirmation: the door is counted, but checked.
    const unsure = commentMarks.find(([, v]) => NEEDS_CONFIRMATION.test(v));
    if (unsure && qtyOk) {
      issues.push({
        row: r,
        severity: 'warning',
        kind: 'row',
        message: `Needs confirmation — counted, check with the builder: "${
          unsure[1].length > 90 ? `${unsure[1].slice(0, 90)}…` : unsure[1]
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
    d.hardware = [d.hardware, activitiesToken(d.activities), d.lock_cost ? `Lock prep: ${d.lock_cost}` : '']
      .filter(Boolean)
      .join(' · ');
  }

  onProgress?.({ stage: 'group' });
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
    hardwareHeaders: cols.hardware.map(([label, , header]) => [label, header] as [string, string]),
    variationRows,
  };
  return { ...result, report: buildReport(result) };
}
