import { describe, it, expect } from 'vitest';
import ExcelJS from 'exceljs';
import {
  parseQuotationWorkbook,
  normalizeClassification,
  normalizeLeaf,
  normalizeDoorSize,
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
      room_name: 'FIRE EGRESS - BASEMENT',
      classification: 'FIRE RATED',
      leaf: 'SINGLE',
      door_size: '2340x870',
      door_qty: 3,
    });
    expect(res.groups[1]).toMatchObject({
      room_name: 'BATHROOM',
      classification: 'NON RATED',
      leaf: 'CAVITY SINGLE',
      door_size: '2040x820',
      door_qty: 1,
    });
    expect(res.issues.some((i) => i.severity === 'error' && i.message.includes('Missing Room Name'))).toBe(true);
    expect(res.issues.some((i) => i.severity === 'warning' && i.message.includes('non-integer QTY'))).toBe(true);
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
});
