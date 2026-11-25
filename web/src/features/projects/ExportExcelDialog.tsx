import { useEffect, useState } from 'react'
import { CalendarDays, Download } from 'lucide-react'
import MonthAndYearCalendar from '@/components/shadcn-space/calendar/calendar-05'
import { formatScheduleDate, parseScheduleDate, serializeScheduleDate } from '@/lib/scheduleDate'
import { DEFAULT_EXPORT_TITLE } from '@/features/projects/projectExcelExport'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

const TITLE_KEY = 'mh.export.title'
const scheduleKey = (projectId: string) => `mh.export.schedule-date.${projectId}`

// Browser storage can be unavailable; remembering values is only a convenience.
function readStored(key: string): string | null {
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}
function writeStored(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value)
  } catch {
    /* ignore */
  }
}

interface ExportExcelDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  projectId: string
  busy: boolean
  error: string | null
  /** The version's supplier sheets; with more than one, the user picks which to export. */
  sheets?: { id: string; name: string }[]
  onExport: (values: { scheduleNo: string; sheetTitle: string; sheetIds: string[] }) => void
}

/**
 * Asks for the Schedule # (row 4 of the export), picked on the calendar-05
 * calendar (month/year dropdowns), and lets the user adjust the sheet title
 * (row 1). Both are remembered in this browser: the title for all projects,
 * the schedule date per project. With several supplier sheets, the user ticks
 * which ones go into the file (all by default).
 */
export function ExportExcelDialog({
  open,
  onOpenChange,
  projectId,
  busy,
  error,
  sheets = [],
  onExport,
}: ExportExcelDialogProps) {
  const [scheduleDate, setScheduleDate] = useState<Date | undefined>(undefined)
  const [sheetTitle, setSheetTitle] = useState(DEFAULT_EXPORT_TITLE)
  const [touched, setTouched] = useState(false)
  const [chosen, setChosen] = useState<Set<string>>(new Set())
  const sheetKey = sheets.map((s) => s.id).join(',')

  useEffect(() => {
    if (!open) return
    setScheduleDate(parseScheduleDate(readStored(scheduleKey(projectId))))
    setSheetTitle(readStored(TITLE_KEY) || DEFAULT_EXPORT_TITLE)
    setTouched(false)
    setChosen(new Set(sheetKey ? sheetKey.split(',') : []))
  }, [open, projectId, sheetKey])

  const scheduleNo = formatScheduleDate(scheduleDate)
  const missing = scheduleNo === ''
  const chooseSheets = sheets.length > 1
  const noSheet = chooseSheets && chosen.size === 0

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    setTouched(true)
    if (missing || noSheet) return
    writeStored(scheduleKey(projectId), serializeScheduleDate(scheduleDate))
    writeStored(TITLE_KEY, sheetTitle.trim() || DEFAULT_EXPORT_TITLE)
    onExport({
      scheduleNo,
      sheetTitle: sheetTitle.trim() || DEFAULT_EXPORT_TITLE,
      // In tab order.
      sheetIds: chooseSheets ? sheets.filter((s) => chosen.has(s.id)).map((s) => s.id) : sheets.map((s) => s.id),
    })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={submit} className="space-y-4">
          <DialogHeader>
            <DialogTitle>Export Excel</DialogTitle>
            <DialogDescription>
              These fill the header rows of the exported schedule.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-1.5">
            <Label>Schedule #</Label>
            <div
              data-testid="export-schedule-value"
              className="flex h-9 items-center gap-2 rounded-md border border-neutral-300 bg-neutral-50 px-3 text-sm text-neutral-950"
            >
              <CalendarDays className="h-4 w-4 text-neutral-500" />
              <span className={missing ? 'text-neutral-500' : 'font-medium'}>
                {missing ? 'Pick a date' : scheduleNo}
              </span>
            </div>
            <div className="flex justify-center">
              <MonthAndYearCalendar selected={scheduleDate} onSelect={setScheduleDate} />
            </div>
            {touched && missing && (
              <p role="alert" className="text-xs font-medium text-neutral-950">
                Pick the schedule date to export.
              </p>
            )}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="export-sheet-title">Sheet Title</Label>
            <Input
              id="export-sheet-title"
              value={sheetTitle}
              onChange={(e) => setSheetTitle(e.target.value)}
            />
          </div>

          {chooseSheets && (
            <fieldset className="space-y-1.5">
              <legend className="text-sm font-medium text-neutral-950">Supplier Sheets</legend>
              <div className="space-y-1 rounded-md border border-neutral-200 p-2">
                {sheets.map((s) => (
                  <label key={s.id} className="flex items-center gap-2 text-sm text-neutral-900">
                    <input
                      type="checkbox"
                      className="h-3.5 w-3.5 accent-neutral-950"
                      checked={chosen.has(s.id)}
                      onChange={(e) =>
                        setChosen((prev) => {
                          const next = new Set(prev)
                          if (e.target.checked) next.add(s.id)
                          else next.delete(s.id)
                          return next
                        })
                      }
                    />
                    <span>{s.name}</span>
                  </label>
                ))}
              </div>
              {touched && noSheet && (
                <p role="alert" className="text-xs font-medium text-neutral-950">
                  Tick at least one sheet to export.
                </p>
              )}
            </fieldset>
          )}

          {error && (
            <div role="alert" className="border border-neutral-950 bg-neutral-50 p-2.5 text-xs text-neutral-950">
              {error}
            </div>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || noSheet}>
              <Download className="h-3.5 w-3.5" />
              <span>{busy ? 'Exporting...' : 'Download'}</span>
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
