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
    // Numbered A–Z by room name: Bathroom, then Fire Egress.
    expect(res.groups.map((g) => g.position)).toEqual([1, 2]);
    expect(res.groups[1]).toMatchObject({
      door_tag: 'D65a',
      room_name: 'Fire Egress - Basement',
      classification: 'FIRE RATED',
      leaf: 'SINGLE',
      door_size: '2340x870',
      door_qty: 3,
    });
    expect(res.groups[0]).toMatchObject({
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
    expect(d19[0].group_key).toBe('* | WASTE | FIRE RATED | SINGLE | 2340x920 | Closer · Grille: DG');
    const split = res.issues.find((i) => i.kind === 'group' && i.message.startsWith('Split into 2 door groups'));
    // Each door group it was split into, for its own row in the Issues tab.
    expect(split?.splits?.map((g) => g.hardware)).toEqual(expect.arrayContaining(['Closer · Grille: DG']));
    expect(split?.splits).toHaveLength(2);
    // Items the comments ask for are part of the door's hardware.
    expect(res.doors[0].hardware).toBe('Closer · ES: ES RS · Card reader · Kick plate');

    // Including the excluded row back brings the total in line.
    const inc = applyRowInclusions(res, [9]);
    expect(inc.totalDoorQty).toBe(5);
    expect(inc.excludedCount).toBe(1);
    expect(inc.includedRows).toEqual([9]);
    expect(inc.groups.map((g) => g.door_tag)).toEqual(['D20', 'D19', 'D19', 'D61c']);
    expect(inc.issues.some((i) => i.kind === 'total')).toBe(false);
    // ...and un-including it goes back; the original parse is unchanged.
    expect(applyRowInclusions(inc, []).totalDoorQty).toBe(4);
    expect(res.totalDoorQty).toBe(4);
  });

  it('reads EXTRA HINGE (FR): 9 = one hinge; part of the hardware, so doors with and without split', async () => {
    const headers = ['Door Level', 'Door Type', 'Door Apt #', 'Room Name', 'Frame Type', 'FRL', 'Leaf Type', 'Leaf Height', 'Leaf 1 Width', 'Leaf 2 Width', 'Leafs', 'Self Closing', 'QTY', 'EXTRA HINGE (FR)'];
    const rows: (string | number | null)[][] = [
      ['L1', 'D63', 'C', 'Fire Stair', 'F', '-/120/30', 'FR2', 2340, 870, '-', 1, 'Y', 2, 9],
      ['L1', 'D63', 'C', 'Fire Stair', 'F', '-/120/30', 'FR2', 2340, 870, '-', 1, 'Y', 1, null],
      ['L1', 'D61', 'C', 'Waste', 'F', '-/120/30', 'FR2', 2340, 920, 920, 2, 'Y', 1, 18],
    ];
    const res = await parseQuotationWorkbook(await buildSampleWorkbook('Quotation Test', headers, rows));
    expect(res.groups.map((g) => [g.door_tag, g.door_qty, g.extra_hinges, g.hardware])).toEqual([
      ['D63', 2, 1, 'Closer · Extra hinge ×1'],
      ['D63', 1, 0, 'Closer'],
      ['D61', 1, 2, 'Closer · Extra hinge ×2'],
    ]);
    // No such column: unknown (sizing falls back to the height rule).
    const plain = await parseQuotationWorkbook(
      await buildSampleWorkbook('Quotation Test', headers.slice(0, 13), rows.map((r) => r.slice(0, 13)))
    );
    expect(plain.groups[0].extra_hinges).toBeNull();
  });

  it('treats N / No / 0 hardware cells as none, and checks against the largest SUM (not a subtotal)', async () => {
    const headers = ['Door Level', 'Door Type', 'Door Apt #', 'Room Name', 'Frame Type', 'FRL', 'Leaf Type', 'Leaf Height', 'Leaf 1 Width', 'Leaf 2 Width', 'Leafs', 'Lock', 'Bolt', 'QTY'];
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Quotation');
    ws.addRow(['MENA']);
    ws.addRow(['DOOR SCHEDULE']);
    ws.addRow(['LOCATION']);
    ws.addRow(headers);
    const grand = ws.addRow([]);
    grand.getCell(14).value = { formula: 'SUM(N6:N20)', result: 3 } as ExcelJS.CellFormulaValue;
    ws.addRow(['L1', 'D02', 'A', 'Bedroom', 'ST', '-/-/-', 'SC1', 2040, 820, '-', 1, 'Y', 'N', 1]);
    ws.addRow(['L1', 'D02', 'B', 'Bedroom', 'ST', '-/-/-', 'SC1', 2040, 820, '-', 1, 'Y', '-', 1]);
    const sub = ws.addRow(['L1 subtotal']);
    sub.getCell(14).value = { formula: 'SUM(N6:N7)', result: 2 } as ExcelJS.CellFormulaValue;
    ws.addRow(['L2', 'D02', 'C', 'Bedroom', 'ST', '-/-/-', 'SC1', 2040, 820, '-', 1, 'Y', 'No', 1]);
    const res = await parseQuotationWorkbook((await wb.xlsx.writeBuffer()) as ArrayBuffer);
    expect(res.groups).toHaveLength(1);
    expect(res.groups[0]).toMatchObject({ hardware: 'Lock', door_qty: 3 });
    expect(res.sheetQtyTotal).toBe(3);
    expect(res.issues.some((i) => i.kind === 'total')).toBe(false);
  });

  it('reads PREPARATION / INSTALLATION costs as parts with quantities; doors with different ones split', async () => {
    const headers = ['Door Level', 'Door Type', 'Door Apt #', 'Room Name', 'Frame Type', 'FRL', 'Leaf Type', 'Leaf Height', 'Leaf 1 Width', 'Leaf 2 Width', 'Leafs', 'QTY', 'CLOSER', 'STOP', 'CONC SEAL PREP', 'FRAME SEAL INST'];
    const rows: (string | number | null)[][] = [
      ['L1', 'D63', 'C', 'Fire Stair', 'F', '-/120/30', 'FR2', 2040, 870, '-', 1, 2, 22, 7, 32, 26],
      ['L2', 'D63', 'C', 'Fire Stair', 'F', '-/120/30', 'FR2', 2040, 870, '-', 1, 1, 22, null, 32, 26],
      ['L1', 'D61', 'C', 'Waste', 'F', '-/120/30', 'FR2', 2040, 920, 920, 2, 1, 44, 14, 64, 38],
    ];
    const res = await parseQuotationWorkbook(await buildSampleWorkbook('Quotation Test', headers, rows));
    expect(res.activityColumns.sort()).toEqual(['closer', 'dropseal', 'frameseal', 'stop']);
    expect(res.groups.map((g) => [g.door_tag, g.door_qty, g.activities])).toEqual([
      ['D63', 2, { closer: 1, stop: 1, dropseal: 1, frameseal: 1 }],
      ['D63', 1, { closer: 1, dropseal: 1, frameseal: 1 }],
      ['D61', 1, { closer: 2, stop: 2, dropseal: 2, frameseal: 1 }],
    ]);
    expect(res.groups[2].hardware).toBe('Prep: Stop ×2, Closer ×2, Drop seal ×2, Frame seal');
  });

  it('reads every column under the HW heading; a Stop left of QTY is hardware, right of it a cost', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Quotation Test');
    ws.addRow(['MENA CONTRACTORS PTY LTD']);
    ws.addRow(['DOOR SCHEDULE']);
    // Row 3: "HW" over columns 12-15 (Hinge, Stop, Reed Switch, Pull Handle).
    const band: (string | null)[] = Array(17).fill(null);
    band[11] = 'HW';
    ws.addRow(band);
    ws.mergeCells(3, 12, 3, 15);
    ws.addRow(['Door Level', 'Door Type', 'Door Apt #', 'Room Name', 'Frame Type', 'FRL', 'Leaf Type', 'Leaf Height', 'Leaf 1 Width', 'Leaf 2 Width', 'Leafs', 'Hinge', 'Stop', 'Reed Switch', 'Pull Handle', 'QTY', 'STOP']);
    ws.addRow([]);
    ws.addRow(['L1', 'D-03', 'A1', 'Linen', 'ST', '-/-/-', 'SC1', 2040, 770, '-', 1, 'BH', 'YES', '-', 'PH1', 1, null]);
    ws.addRow(['L2', 'D-03', 'A2', 'Linen', 'ST', '-/-/-', 'SC1', 2040, 770, '-', 1, 'BH', '-', '-', 'PH1', 1, null]);
    ws.addRow(['L3', 'D-03', 'A3', 'Linen', 'ST', '-/-/-', 'SC1', 2040, 770, '-', 1, 'BH', 'YES', 'YES', 'PH1', 1, 7]);
    const res = await parseQuotationWorkbook((await wb.xlsx.writeBuffer()) as ArrayBuffer);
    expect(res.activityColumns).toEqual(['stop']);
    expect(res.doors.map((d) => d.hardware)).toEqual([
      'Hinge: BH · Stop · Pull Handle: PH1',
      'Hinge: BH · Pull Handle: PH1',
      'Hinge: BH · Stop · Reed switch · Pull Handle: PH1 · Prep: Stop',
    ]);
    // The door stop splits the group.
    expect(res.groups).toHaveLength(3);
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

  it('merges door types with the same specs and hardware (door type is not a hardware factor)', async () => {
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

    expect(res.groups).toHaveLength(1);
    expect(res.groups[0]).toMatchObject({
      door_tag: 'DR-002 / DR-003',
      room_name: 'Residential Bathroom',
      door_qty: 6,
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
    expect(res.groups[0].group_key).toBe('* | APARTMENTS - BEDROOM | NON RATED | SINGLE | 2340x870');
  });

  it('merges door types in the same room with the same specs and hardware; other rooms stay apart', async () => {
    const headers = ['Door Level', 'Door Type', 'Door Apt #', 'Room Name', 'Frame Type', 'FRL', 'Leaf Type', 'Leaf Height', 'Leaf 1 Width', 'Leaf 2 Width', 'Leafs', 'Self Closing', 'Bolt', 'QTY'];
    const rows: (string | number | null)[][] = [
      ['L1', 'D62a', 'C', 'Services cupboard', 'ST', '-/-/-', 'SC1', 2340, 620, 620, 2, 'Y', 'Y', 1],
      ['B1', 'D62a', 'C', 'Services cupboard - B1 & B2', 'ST', '-/-/-', 'SC1', 2340, 620, 620, 2, 'Y', 'Y', 3],
      ['L2', 'D62a', 'C', 'SERVICES CUPBOARD', 'ST', '-/-/-', 'SC1', 2340, 620, 620, 2, 'Y', 'Y', 1],
      // Same door type, other size: its own group.
      ['L3', 'D62a', 'C', 'Services cupboard', 'ST', '-/-/-', 'SC1', 2340, 720, 720, 2, 'Y', 'Y', 1],
      // Other door types and rooms, same specs and hardware: one group.
      ['L4', '-', 'C', 'Store', 'ST', '-/-/-', 'SC1', 2040, 820, '-', 1, '-', '-', 1],
      ['L4', 'D07', 'C', 'Plant', 'ST', '-/-/-', 'SC1', 2040, 820, '-', 1, '-', '-', 2],
      // Same size as those, but a closer: its own group.
      ['L5', 'D07', 'C', 'Plant', 'ST', '-/-/-', 'SC1', 2040, 820, '-', 1, 'Y', '-', 1],
    ];
    const res = await parseQuotationWorkbook(await buildSampleWorkbook('Quotation Test', headers, rows));
    expect(res.groups.map((g) => [g.door_tag, g.room_name, g.door_qty])).toEqual([
      // A–Z by room; "SERVICES CUPBOARD" is the same room in other capitals.
      ['D07', 'Plant', 2],
      ['D07', 'Plant', 1],
      ['D62a', 'Services cupboard', 2],
      ['D62a', 'Services cupboard', 1],
      ['D62a', 'Services cupboard - B1 & B2', 3],
      ['', 'Store', 1],
    ]);
    expect(res.groups[2].group_key).toBe('* | SERVICES CUPBOARD | NON RATED | DOUBLE | 2340x620+620 | Closer · Bolt');
    expect(res.groups[5].group_key).toBe('* | STORE | NON RATED | SINGLE | 2040x820');
  });

  it('merges door types in one room (door type is not a hardware factor)', async () => {
    const headers = ['Door Level', 'Door Type', 'Door Apt #', 'Room Name', 'Frame Type', 'FRL', 'Leaf Type', 'Leaf Height', 'Leaf 1 Width', 'Leaf 2 Width', 'Leafs', 'QTY'];
    const rows: (string | number | null)[][] = [
      ['L1', 'D-04', 'A1', 'LINEN/ BROOM', 'ST', '-/-/-', 'SC1', 2040, 770, '-', 1, 1],
      ['L2', 'D-03', 'B1', 'LINEN/ BROOM', 'ST', '-/-/-', 'SC1', 2040, 770, '-', 1, 10],
    ];
    const res = await parseQuotationWorkbook(await buildSampleWorkbook('Quotation Test', headers, rows));
    expect(res.groups).toHaveLength(1);
    expect(res.groups[0]).toMatchObject({ door_tag: 'D-04 / D-03', room_name: 'LINEN/ BROOM', door_qty: 11 });
  });
});

describe('comments columns', () => {
  it('reads Door Schedule Comments, and the unnamed column after it with Mena Contractors Comments', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Quotation Test');
    ws.addRow(['MENA CONTRACTORS PTY LTD']);
    ws.addRow(['DOOR SCHEDULE']);
    ws.addRow(['', '', '', '', '', '', '', '', '', '', '', 'COMMENTS', 'COMMENTS', 'COMMENTS']);
    ws.addRow(['Door Level', 'Door Type', 'Door Apt #', 'Room Name', 'Frame Type', 'FRL', 'Leaf Type', 'Leaf Height', 'Leaf 1 Width', 'Leaf 2 Width', 'Leafs', 'Door Schedule Comments', '', 'Mena Contractors Comments', 'QTY']);
    ws.addRow([]);
    const row = ws.addRow(['L1', 'D-01', 'A1', 'Store', 'ST', '-/-/-', 'SC1', 2040, 820, '-', 1, 'Paint door', 'Door size changed', 'Check on site', 1]);
    row.getCell(13).font = { color: { argb: 'FFFF0000' } };
    row.getCell(14).font = { color: { argb: 'FF0070C0' } };
    row.getCell(12).font = { color: { argb: 'FF000000' } };
    const res = await parseQuotationWorkbook((await wb.xlsx.writeBuffer()) as ArrayBuffer);
    expect(res.doors[0]).toMatchObject({
      schedule_comments: 'Paint door',
      mena_comments: 'Door size changed | Check on site',
      comments: 'Paint door | Door size changed | Check on site',
      // Black isn't listed.
      comment_colors: { 'Door size changed': 'red', 'Check on site': 'blue' },
    });
  });
});

describe('merged comment cells', () => {
  it('a Door Schedule comment merged into the middle column is not read as a Mena comment too', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Quotation Test');
    ws.addRow(['MENA CONTRACTORS PTY LTD']);
    ws.addRow(['DOOR SCHEDULE']);
    ws.addRow(['LOCATION']);
    ws.addRow(['Door Level', 'Door Type', 'Door Apt #', 'Room Name', 'Frame Type', 'FRL', 'Leaf Type', 'Leaf Height', 'Leaf 1 Width', 'Leaf 2 Width', 'Leafs', 'Door Schedule Comments', '', 'Mena Contractors Comments', 'QTY']);
    ws.addRow([]);
    ws.addRow(['L1', 'D-01', 'A1', 'Store', 'ST', '-/-/-', 'SC1', 2040, 820, '-', 1, 'Door size changed', '', '', 1]);
    ws.mergeCells('L6:M6');
    const res = await parseQuotationWorkbook((await wb.xlsx.writeBuffer()) as ArrayBuffer);
    expect(res.doors[0]).toMatchObject({ schedule_comments: 'Door size changed', mena_comments: '' });
  });
});

describe('parse progress', () => {
  it('reports open, sheet, rows (counted) and group, in order', async () => {
    const headers = ['Door Level', 'Door Type', 'Door Apt #', 'Room Name', 'Frame Type', 'FRL', 'Leaf Type', 'Leaf Height', 'Leaf 1 Width', 'Leaf 2 Width', 'Leafs', 'QTY'];
    const rows = Array.from({ length: 45 }, (_, i) => ['L1', `D-${i}`, 'A1', 'Store', 'ST', '-/-/-', 'SC1', 2040, 820, '-', 1, 1]);
    const seen: string[] = [];
    let lastRows = 0;
    await parseQuotationWorkbook(await buildSampleWorkbook('Quotation Test', headers, rows), (p) => {
      if (seen[seen.length - 1] !== p.stage) seen.push(p.stage);
      if (p.stage === 'rows') {
        expect(p.done ?? 0).toBeGreaterThanOrEqual(lastRows);
        lastRows = p.done ?? 0;
        expect(p.total).toBeGreaterThanOrEqual(45);
      }
    });
    expect(seen).toEqual(['open', 'sheet', 'rows', 'group']);
    expect(lastRows).toBeGreaterThan(0);
  });
});
