import type { QuotationParseResult } from './quotationParser'

type WorkerReply = { ok: true; result: QuotationParseResult } | { ok: false; error: string }

/** The file itself could not be parsed (wrong layout, not a quotation, ...). */
export class QuotationParseError extends Error {}

function parseInWorker(buffer: ArrayBuffer): Promise<QuotationParseResult> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./quotationParser.worker.ts', import.meta.url), {
      type: 'module',
    })
    const finish = () => worker.terminate()
    worker.onmessage = (event: MessageEvent<WorkerReply>) => {
      finish()
      if (event.data.ok) resolve(event.data.result)
      else reject(new QuotationParseError(event.data.error))
    }
    // The worker itself failed to start or crashed (not a problem with the file).
    worker.onerror = (event) => {
      event.preventDefault()
      finish()
      reject(new Error(event.message || 'Quotation worker failed'))
    }
    // Transfer the bytes instead of copying them.
    worker.postMessage(buffer, [buffer])
  })
}

async function parseOnMainThread(buffer: ArrayBuffer): Promise<QuotationParseResult> {
  const { parseQuotationWorkbook } = await import('./quotationParser')
  return parseQuotationWorkbook(buffer)
}

/**
 * Parses a quotation .xlsx in a background worker so large files don't freeze
 * the page. Falls back to parsing on the page if workers aren't available or
 * the worker can't start; errors about the file itself are passed through.
 */
export async function parseQuotationInBackground(
  buffer: ArrayBuffer,
): Promise<QuotationParseResult> {
  if (typeof Worker === 'undefined') return parseOnMainThread(buffer)
  // Keep a copy: the original is handed over to the worker.
  const fallbackCopy = buffer.slice(0)
  try {
    return await parseInWorker(buffer)
  } catch (err) {
    if (err instanceof QuotationParseError) throw err
    console.warn('Quotation worker unavailable, parsing on the page instead:', err)
    return parseOnMainThread(fallbackCopy)
  }
}
