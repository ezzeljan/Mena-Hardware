/// Background worker: parses a quotation workbook off the main thread so the
/// page stays responsive on large files. Used by parseQuotationInBackground().
import { parseQuotationWorkbook } from './quotationParser'

type WorkerScope = {
  onmessage: ((event: MessageEvent<ArrayBuffer>) => void) | null
  postMessage: (message: unknown) => void
}

const scope = self as unknown as WorkerScope

scope.onmessage = async (event) => {
  try {
    const result = await parseQuotationWorkbook(event.data, (progress) => scope.postMessage({ progress }))
    scope.postMessage({ ok: true, result })
  } catch (err) {
    scope.postMessage({
      ok: false,
      error: err instanceof Error ? err.message : 'Failed to parse quotation workbook.',
    })
  }
}
