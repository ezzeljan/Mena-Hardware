import type ExcelJS from 'exceljs'

type ExcelJSModule = typeof ExcelJS

let pending: Promise<ExcelJSModule> | null = null

/**
 * Loads ExcelJS (~1 MB) only when a workbook is actually read or written, so it
 * is not part of the bundle every page downloads. Loaded once, then reused.
 */
export function loadExcelJS(): Promise<ExcelJSModule> {
  pending ??= import('exceljs').then(
    (mod) =>
      (mod as unknown as { default?: ExcelJSModule }).default ??
      (mod as unknown as ExcelJSModule),
  )
  return pending
}
