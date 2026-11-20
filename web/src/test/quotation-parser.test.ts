import { describe, it, expect } from 'vitest';
import ExcelJS from 'exceljs';
import {
  parseQuotationWorkbook,
  normalizeClassification,
  normalizeLeaf,
  normalizeDoorSize,
  isExcludedValue,
  isWholeDoorExclusionComment,
  applyRowInclusions,
} from '@/features/projects/quotationParser';

async function buildSampleWorkbook(
  sheetName: string,
  headers: string[],
  rows: (string | number | null)[][]
): Promise<ArrayBuffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(sheetName);
  ws.addRow(['MENA CONTRACTORS PTY LTD']);
  ws.addRow(['DOOR SCHEDULE']);
  ws.addRow(['LOCATION']);
  ws.addRow(headers);
  ws.addRow([]); // subtotal row
  for (const r of rows) {
    ws.addRow(r);
  }
  const buf = await wb.xlsx.writeBuffer();
  return buf as ArrayBuffer;
}

describe('quotationParser helpers', () => {
  it('treats EXCLUDED / Ex. / BY OTHERS markers as out of scope', () => {
    expect(isExcludedValue('EXCLUDED')).toBe(true);
    expect(isExcludedValue('Ex.')).toBe(true);
    expect(isExcludedValue('(Ex.)')).toBe(true);
    expect(isExcludedValue('BY OTHERS')).toBe(true);
    expect(isExcludedValue('Supplied by others')).toBe(true);
    expect(isExcludedValue('By Other')).toBe(true);
    expect(isExcludedValue('UNIT ENTRY')).toBe(false);
    expect(isExcludedValue('EXIT STAIR')).toBe(false);
    expect(isExcludedValue('OTHERS STORE')).toBe(false);
  });

  it('only treats a comment as excluding the door when it starts with the marker', () => {
    expect(isWholeDoorExclusionComment('EXCLUDED')).toBe(true);
    expect(isWholeDoorExclusionComment('Ex. GLAZED')).toBe(true);
    expect(isWholeDoorExclusionComment('(Ex.) existing')).toBe(true);
    expect(isWholeDoorExclusionComment('By others')).toBe(true);
    expect(isWholeDoorExclusionComment('Door supplied by others')).toBe(true);
    expect(isWholeDoorExclusionComment('Supply & install by others')).toBe(true);
    expect(isWholeDoorExclusionComment('CR Card Reader by others. Allowance for kick plate install')).toBe(false);
    expect(isWholeDoorExclusionComment('Exit door, closer')).toBe(false);
    expect(isWholeDoorExclusionComment('External grade hardware')).toBe(false);
    expect(isWholeDoorExclusionComment('')).toBe(false);
  });

  it('derives FIRE RATED vs NON RATED from FRL and leaf type', () => {
    expect(normalizeClassification('-/120/30', 'FR2')).toBe('FIRE RATED');
    expect(normalizeClassification('-/60/30', 'FD')).toBe('FIRE RATED');
    expect(normalizeClassification('-/-/-', 'SC1')).toBe('NON RATED');
    expect(normalizeClassification('-', 'SC')).toBe('NON RATED');
    expect(normalizeClassification('', 'FD')).toBe('FIRE RATED');
  });

  it('normalizes leaf counts including cavity sliders', () => {
    expect(normalizeLeaf('1', 'F (Metal Sng Reb)')).toBe('SINGLE');
    expect(normalizeLeaf('Double', 'ST')).toBe('DOUBLE');
    expect(normalizeLeaf('Triple', 'ST')).toBe('TRIPLE');
    expect(normalizeLeaf('1', 'Pocket Slider')).toBe('CAVITY SINGLE');
    expect(normalizeLeaf('1', 'CS')).toBe('CAVITY SINGLE');
  });

  it('formats door_size for single and multi-leaf doors', () => {
    expect(normalizeDoorSize('2340', '870', '-', '')).toBe('2340x870');
    expect(normalizeDoorSize('2040', '720', '720', '-')).toBe('2040x720+720');
    expect(normalizeDoorSize('Ex.', '920', '', '')).toBeNull();
  });
});

describe('parseQuotationWorkbook', () => {
  it('parses valid rows, excludes Ex./EXCLUDED rows, and groups matching doors', async () => {
    const headers = [
      'Door Level',
      'Door Type',
      'Door Apt #',
      'Room Name',
      'Frame Type',
      'FRL',
      'Leaf Type',
      'Leaf Height',
      'Leaf 1 Width',
      'Leaf 2 Width',
      'Leafs',
      'Door Schedule Comments',
      'Mena Contractors Comments',
      'QTY',
    ];
    const rows: (string | number | null)[][] = [
      ['Basement 02'], // section header
      ['Basement 02', 'D65a', 'FS', 'Fire Egress - Basement', 'F (Metal Sng Reb)', '-/120/30', 'FR2', 2340, 870, '-', 1, '', '', 1],
      ['Basement 01', 'D65a', 'FS', 'Fire Egress - Basement', 'F (Metal Sng Reb)', '-/120/30', 'FR2', 2340, 870, '-', 1, '', '', 2],
      ['Basement 02', 'D35 (Ex.)', 'COMMON', 'VIP Storage (Ex.)', 'Ex.', 'Ex.', 'SC1', 2340, 920, '-', 1, 'EXCLUDED', '', 'Ex.'],
      ['Level 1', 'D10', 'E01', 'Bathroom', 'CS', '-/-/-', 'HC', 2040, 820, '-', 1, '', '', 1],
      ['Level 1', 'D11', 'E02', '', 'ST', '-/-/-', 'SC', 2040, 820, '-', 1, '', '', 1], // missing room name
      ['Level 1', 'D12', 'E03', 'Lobby', 'ST', '-/-/-', 'SC', 2040, 920, '-', 1, '', '', '1.5'], // non-integer qty
    ];

    const buf = await buildSampleWorkbook('Quotation STL 7sept', headers, rows);
    const res = await parseQuotationWorkbook(buf);

    expect(res.sheetName).toBe('Quotation STL 7sept');
    expect(res.headerRow).toBe(4);
    expect(res.doors).toHaveLength(3);
    expect(res.totalDoorQty).toBe(4);
    expect(res.excludedCount).toBe(1);
    expect(res.groups).toHaveLength(2);
    expect(res.groups[0]).toMatchObject({
      door_tag: 'D65a',
      room_name: 'Fire Egress - Basement',
      classification: 'FIRE RATED',
      leaf: 'SINGLE',
      door_size: '2340x870',
      door_qty: 3,
    });
    expect(res.groups[1]).toMatchObject({
      door_tag: 'D10',
      room_name: 'Bathroom',
      classification: 'NON RATED',
      leaf: 'CAVITY SINGLE',
      door_size: '2040x820',
      door_qty: 1,
    });
    expect(res.issues.some((i) => i.severity === 'error' && i.message.includes('Missing Room Name'))).toBe(true);
    expect(res.issues.some((i) => i.severity === 'warning' && i.message.includes('non-integer QTY'))).toBe(true);
  });

  it('keeps a door whose comment only mentions an item by others, and checks the sheet total', async () => {
    const headers = [
      'Door Level', 'Door Type', 'Door Apt #', 'Room Name', 'Frame Type', 'FRL', 'Leaf Type',
      'Leaf Height', 'Leaf 1 Width', 'Leaf 2 Width', 'Leafs', 'Self Closing', 'Door Grille',
      'Electric Strike', 'Door Schedule Comments', 'Mena Contractors Comments', 'QTY',
    ];
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Quotation STL 7sept');
    ws.addRow(['MENA CONTRACTORS PTY LTD']);
    ws.addRow(['DOOR SCHEDULE']);
    ws.addRow(['LOCATION']);
    ws.addRow(headers);
    // Row 5: the sheet's own total of the QTY column (cached result 5).
    const totalRow = ws.addRow([]);
    totalRow.getCell(17).value = { formula: 'SUM(Q6:Q20)', result: 5 } as ExcelJS.CellFormulaValue;
    const fire = ['L1', 'D61c', 'COMMON', 'Waste Room', 'F', '-/120/30', 'FR2', 2340, 920, 920, 2, 'Y'];
    ws.addRow([...fire, '-', 'ES RS', '', 'CR Card Reader by others. Allowance for kick plate install', 1]);
    ws.addRow(['L1', 'D19', 'COMMON', 'Waste', 'F', '-/120/30', 'FR2', 2340, 920, '-', 1, 'Y', 'DG', '-', '', '', 2]);
    ws.addRow(['L2', 'D19', 'COMMON', 'Waste', 'F', '-/120/30', 'FR2', 2340, 920, '-', 1, 'Y', '-', '-', '', '', 1]);
    ws.addRow(['L2', 'D20', 'COMMON', 'Plant', 'F', '-/120/30', 'FR2', 2040, 920, '-', 1, 'Y', '-', '-', '', 'Door by others', 1]);
    ws.addRow(['L2', 'D35 (Ex.)', 'COMMON', 'VIP Storage (Ex.)', 'Ex.', 'Ex.', 'SC1', 2340, 920, '-', 1, '-', '-', '-', 'EXCLUDED', 'Ex. GLAZED', 'Ex.']);
    const res = await parseQuotationWorkbook((await wb.xlsx.writeBuffer()) as ArrayBuffer);

    // "CR Card Reader by others" is about one item: the door stays, with a warning.
    expect(res.doors.map((d) => d.door_tag)).toEqual(['D61c', 'D19', 'D19']);
    expect(res.issues.some((i) => i.row === 6 && i.message.startsWith('Kept:'))).toBe(true);

    // "Door by others" and the Ex. row are excluded, with the reason.
    expect(res.excluded.map((e) => [e.row, e.qty])).toEqual([[9, 1], [10, null]]);
    expect(res.excluded[0].reason).toContain('Mena Contractors Comments');
    expect(res.excluded[1].reason).toContain('Door Type');

    // Sheet total 5, read 4: an error naming the excluded row that has a QTY.
    expect(res.sheetQtyTotal).toBe(5);
    expect(res.totalDoorQty).toBe(4);
    const total = res.issues.find((i) => i.kind === 'total');
    expect(total?.severity).toBe('error');
    expect(total?.message).toContain('row 9 (1)');

    // Doors with different hardware are split into their own groups (D19: grille vs none).
    const d19 = res.groups.filter((g) => g.door_tag === 'D19');
    expect(d19.map((g) => [g.door_qty, g.hardware])).toEqual([
      [2, 'Closer · Grille: DG'],
      [1, 'Closer'],
    ]);
    expect(d19[0].group_key).toBe('D19 | * | FIRE RATED | SINGLE | 2340x920 | Closer · Grille: DG');
    expect(res.issues.some((i) => i.kind === 'group' && i.message.startsWith('Split into 2 door groups'))).toBe(true);
    // Items the comments ask for are part of the door's hardware.
    expect(res.doors[0].hardware).toBe('Closer · ES: ES RS · Card reader · Kick plate');

    // Including the excluded row back brings the total in line.
    const inc = applyRowInclusions(res, [9]);
    expect(inc.totalDoorQty).toBe(5);
    expect(inc.excludedCount).toBe(1);
    expect(inc.includedRows).toEqual([9]);
    expect(inc.groups.map((g) => g.door_tag)).toEqual(['D61c', 'D19', 'D19', 'D20']);
    expect(inc.issues.some((i) => i.kind === 'total')).toBe(false);
    // ...and un-including it goes back; the original parse is unchanged.
    expect(applyRowInclusions(inc, []).totalDoorQty).toBe(4);
    expect(res.totalDoorQty).toBe(4);
  });

  it('throws a clear error when no Door Schedule sheet is found', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Summary');
    ws.addRow(['Just a summary']);
    const buf = (await wb.xlsx.writeBuffer()) as ArrayBuffer;
    await expect(parseQuotationWorkbook(buf)).rejects.toThrow(
      /Could not find a quotation Door Schedule sheet/
    );
  });

  it('separates door groups when door tags differ for the same room attributes', async () => {
    const headers = [
      'Door Level',
      'Door Type',
      'Door Apt #',
      'Room Name',
      'Frame Type',
      'FRL',
      'Leaf Type',
      'Leaf Height',
      'Leaf 1 Width',
      'Leaf 2 Width',
      'Leafs',
      'QTY',
    ];
    const rows: (string | number | null)[][] = [
      ['Level 1', 'DR-002', 'A1', 'Residential Bathroom', 'ST', '-/-/-', 'SC1', 2040, 820, '-', 1, 2],
      ['Level 1', 'DR-003', 'A2', 'Residential Bathroom', 'ST', '-/-/-', 'SC1', 2040, 820, '-', 1, 3],
      ['Level 2', 'DR-002', 'B1', 'Residential Bathroom', 'ST', '-/-/-', 'SC1', 2040, 820, '-', 1, 1],
    ];

    const buf = await buildSampleWorkbook('Quotation Test', headers, rows);
    const res = await parseQuotationWorkbook(buf);

    expect(res.groups).toHaveLength(2);
    expect(res.groups[0]).toMatchObject({
      door_tag: 'DR-002',
      room_name: 'Residential Bathroom',
      door_qty: 3,
    });
    expect(res.groups[1]).toMatchObject({
      door_tag: 'DR-003',
      room_name: 'Residential Bathroom',
      door_qty: 3,
    });
  });

  it('keeps room names as written; spelling in other capitals joins the same group', async () => {
    const headers = ['Door Level', 'Door Type', 'Door Apt #', 'Room Name', 'Frame Type', 'FRL', 'Leaf Type', 'Leaf Height', 'Leaf 1 Width', 'Leaf 2 Width', 'Leafs', 'QTY'];
    const rows: (string | number | null)[][] = [
      ['Level 1', 'D02', 'A1', 'Apartments - Bedroom', 'ST', '-/-/-', 'SC1', 2340, 870, '-', 1, 2],
      ['Level 2', 'D02', 'B1', 'APARTMENTS -  BEDROOM', 'ST', '-/-/-', 'SC1', 2340, 870, '-', 1, 1],
    ];
    const res = await parseQuotationWorkbook(await buildSampleWorkbook('Quotation Test', headers, rows));
    expect(res.doors.map((d) => d.room_name)).toEqual(['Apartments - Bedroom', 'APARTMENTS - BEDROOM']);
    expect(res.groups).toHaveLength(1);
    expect(res.groups[0]).toMatchObject({ room_name: 'Apartments - Bedroom', door_qty: 3 });
    expect(res.groups[0].group_key).toBe('D02 | * | NON RATED | SINGLE | 2340x870');
  });

  it('merges one door type with the same hardware and size across rooms; room names joined', async () => {
    const headers = ['Door Level', 'Door Type', 'Door Apt #', 'Room Name', 'Frame Type', 'FRL', 'Leaf Type', 'Leaf Height', 'Leaf 1 Width', 'Leaf 2 Width', 'Leafs', 'Self Closing', 'Bolt', 'QTY'];
    const rows: (string | number | null)[][] = [
      ['L1', 'D62a', 'C', 'Services cupboard', 'ST', '-/-/-', 'SC1', 2340, 620, 620, 2, 'Y', 'Y', 1],
      ['B1', 'D62a', 'C', 'Services cupboard - B1 & B2', 'ST', '-/-/-', 'SC1', 2340, 620, 620, 2, 'Y', 'Y', 3],
      ['L2', 'D62a', 'C', 'SERVICES CUPBOARD', 'ST', '-/-/-', 'SC1', 2340, 620, 620, 2, 'Y', 'Y', 1],
      // Same door type, other size: its own group.
      ['L3', 'D62a', 'C', 'Services cupboard', 'ST', '-/-/-', 'SC1', 2340, 720, 720, 2, 'Y', 'Y', 1],
      // No door type: grouped per room, not merged.
      ['L4', '-', 'C', 'Store', 'ST', '-/-/-', 'SC1', 2040, 820, '-', 1, '-', '-', 1],
      ['L4', '-', 'C', 'Plant', 'ST', '-/-/-', 'SC1', 2040, 820, '-', 1, '-', '-', 1],
    ];
    const res = await parseQuotationWorkbook(await buildSampleWorkbook('Quotation Test', headers, rows));
    expect(res.groups.map((g) => [g.room_name, g.door_qty])).toEqual([
      ['Services cupboard / Services cupboard - B1 & B2', 5],
      ['Services cupboard', 1],
      ['Store', 1],
      ['Plant', 1],
    ]);
    expect(res.groups[0].group_key).toBe('D62a | * | NON RATED | DOUBLE | 2340x620+620 | Closer · Bolt');
    // Matched on the room with the most doors (3 of 5).
    expect(res.groups[0].match_room).toBe('Services cupboard - B1 & B2');
    expect(res.groups[2].group_key).toBe('— | STORE | NON RATED | SINGLE | 2040x820');
  });
});
