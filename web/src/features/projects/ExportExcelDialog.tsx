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
  onExport: (values: { scheduleNo: string; sheetTitle: string }) => void
}

/**
 * Asks for the Schedule # (row 4 of the export), picked on the calendar-05
 * calendar (month/year dropdowns), and lets the user adjust the sheet title
 * (row 1). Both are remembered in this browser: the title for all projects,
 * the schedule date per project.
 */
export function ExportExcelDialog({
  open,
  onOpenChange,
  projectId,
  busy,
  error,
  onExport,
}: ExportExcelDialogProps) {
  const [scheduleDate, setScheduleDate] = useState<Date | undefined>(undefined)
  const [sheetTitle, setSheetTitle] = useState(DEFAULT_EXPORT_TITLE)
  const [touched, setTouched] = useState(false)

  useEffect(() => {
    if (!open) return
    setScheduleDate(parseScheduleDate(readStored(scheduleKey(projectId))))
    setSheetTitle(readStored(TITLE_KEY) || DEFAULT_EXPORT_TITLE)
    setTouched(false)
  }, [open, projectId])

  const scheduleNo = formatScheduleDate(scheduleDate)
  const missing = scheduleNo === ''

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    setTouched(true)
    if (missing) return
    writeStored(scheduleKey(projectId), serializeScheduleDate(scheduleDate))
    writeStored(TITLE_KEY, sheetTitle.trim() || DEFAULT_EXPORT_TITLE)
    onExport({ scheduleNo, sheetTitle: sheetTitle.trim() || DEFAULT_EXPORT_TITLE })
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

          {error && (
            <div role="alert" className="border border-neutral-950 bg-neutral-50 p-2.5 text-xs text-neutral-950">
              {error}
            </div>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              <Download className="h-3.5 w-3.5" />
              <span>{busy ? 'Exporting...' : 'Download'}</span>
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
