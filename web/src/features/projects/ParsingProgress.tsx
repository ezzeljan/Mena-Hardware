import { useEffect, useState } from 'react'
import { Check, FileSpreadsheet, Loader2 } from 'lucide-react'
import type { ParseStage } from '@/features/projects/quotationParser'

/** The parser's stages, then matching door groups to standard sets (on the page). */
export type ImportStage = ParseStage | 'match'

export interface ImportProgress {
  stage: ImportStage
  done?: number
  total?: number
}

const STEPS: Array<{ stage: ImportStage; label: string }> = [
  { stage: 'open', label: 'Reading the workbook' },
  { stage: 'sheet', label: 'Finding the door schedule' },
  { stage: 'rows', label: 'Reading door rows' },
  { stage: 'group', label: 'Grouping doors' },
  { stage: 'match', label: 'Matching door sets' },
]

const sizeText = (bytes: number) =>
  bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`

/**
 * What the import is doing while a quotation is parsed: the file, an overall
 * progress bar and each step (rows counted as they're read).
 */
export function ParsingProgress({
  fileName,
  fileSize,
  progress,
}: {
  fileName: string
  fileSize: number
  progress: ImportProgress
}) {
  const current = STEPS.findIndex((s) => s.stage === progress.stage)

  // Opening the workbook has no progress of its own: the bar eases towards 35%
  // over a time that grows with the file's size.
  const [opened, setOpened] = useState(false)
  useEffect(() => {
    const t = requestAnimationFrame(() => setOpened(true))
    return () => cancelAnimationFrame(t)
  }, [])
  const openSeconds = Math.min(8, Math.max(1.2, (fileSize / (1024 * 1024)) * 1.5))
  const rowShare = progress.total ? Math.min(1, (progress.done ?? 0) / progress.total) : 0
  const percent =
    progress.stage === 'open'
      ? opened ? 35 : 3
      : progress.stage === 'sheet'
        ? 38
        : progress.stage === 'rows'
          ? 40 + 50 * rowShare
          : progress.stage === 'group'
            ? 92
            : 97

  return (
    <div className="space-y-4" data-testid="parsing-progress" aria-live="polite">
      <div className="rounded-md border border-neutral-200 bg-white p-5">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-neutral-100">
            <FileSpreadsheet className="h-5 w-5 text-neutral-700" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium text-neutral-950" title={fileName}>
              {fileName}
            </div>
            <div className="text-xs text-neutral-500">{sizeText(fileSize)} · parsed on this computer, nothing saved yet</div>
          </div>
          {/* Opening has no real progress, so no number (the bar eases on its own). */}
          {progress.stage !== 'open' && (
            <div className="font-mono text-sm font-semibold text-neutral-950 tabular-nums">{Math.round(percent)}%</div>
          )}
        </div>

        <div
          className="mt-4 h-1.5 w-full overflow-hidden rounded-full bg-neutral-100"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(percent)}
          aria-label="Parsing the quotation"
        >
          <div
            className="h-full rounded-full bg-neutral-950 ease-out motion-safe:transition-[width]"
            style={{
              width: `${percent}%`,
              transitionDuration: progress.stage === 'open' ? `${openSeconds}s` : '150ms',
            }}
          />
        </div>

        <ol className="mt-4 space-y-2">
          {STEPS.map((s, i) => {
            const state = i < current ? 'done' : i === current ? 'current' : 'pending'
            return (
              <li
                key={s.stage}
                className={`flex items-center gap-2 text-xs ${
                  state === 'pending' ? 'text-neutral-400' : 'text-neutral-800'
                }`}
                data-state={state}
              >
                {state === 'done' ? (
                  <Check className="h-3.5 w-3.5 shrink-0 text-green-700" aria-hidden />
                ) : state === 'current' ? (
                  <Loader2 className="h-3.5 w-3.5 shrink-0 motion-safe:animate-spin" aria-hidden />
                ) : (
                  <span className="mx-[3px] h-2 w-2 shrink-0 rounded-full border border-neutral-300" aria-hidden />
                )}
                <span className={state === 'current' ? 'font-medium' : ''}>
                  {s.label}
                  {s.stage === 'rows' && state === 'current' && progress.total ? (
                    <span className="ml-1 font-mono tabular-nums text-neutral-500">
                      {progress.done ?? 0}/{progress.total}
                    </span>
                  ) : null}
                </span>
              </li>
            )
          })}
        </ol>
      </div>

    </div>
  )
}
