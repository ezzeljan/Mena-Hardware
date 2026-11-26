/**
 * How a door group's quotation details read, on the import page and in the
 * Hardware grid's door group popover: its hardware (Builder HW columns, items
 * the comments ask for, prep / install), its comments, and the rules' notes.
 */
import { Check } from 'lucide-react'
import { hardwareParts } from '@/features/projects/hardwareParts'
import { groupNotes } from '@/features/projects/noteGroups'
import type { ParsedQuotationDoor } from '@/features/projects/quotationParser'

/** A door's comments as parsed (or as saved with the door group). */
export type CommentSource = Pick<ParsedQuotationDoor, 'schedule_comments' | 'mena_comments' | 'comment_colors'>

export function ItemList({ items, className = 'text-neutral-600', testId }: { items: string[]; className?: string; testId: string }) {
  if (items.length === 0) return <span className="text-neutral-400">—</span>
  return (
    <ul className={`space-y-0.5 text-[11px] ${className}`} data-testid={testId}>
      {items.map((t, i) => (
        <li key={`${t}-${i}`} className="whitespace-nowrap">
          {t}
        </li>
      ))}
    </ul>
  )
}

/**
 * A door's hardware, one item per line, in groups: "Builder" (the door
 * schedule's HW columns, named as in the quotation; a YES shows a check mark),
 * items the comments ask for, then "Prep / Install" (the PREPARATION /
 * INSTALLATION items).
 */
export function HardwareCell({
  hardware,
  headers,
  prepValues,
  part = 'all',
  className = 'text-neutral-600',
}: {
  hardware: string | null | undefined
  headers: Array<[string, string]>
  prepValues?: Record<string, string>
  /** 'builder': the HW columns and comment items only; 'prep': prep / install only (own table columns). */
  part?: 'all' | 'builder' | 'prep'
  className?: string
}) {
  const parts = hardwareParts(hardware ?? '', headers, prepValues)
  const builder = part === 'prep' ? [] : parts.builder
  const comments = part === 'prep' ? [] : parts.comments
  const prep = part === 'builder' ? [] : parts.prep
  if (builder.length === 0 && comments.length === 0 && prep.length === 0) {
    return <span className="text-neutral-400">—</span>
  }
  // In its own column the column header names the part, so no group heading.
  const titled = part === 'all'
  return (
    <div className="space-y-1">
      {builder.length > 0 && (
        <div>
          {titled && <div className="text-[10px] font-semibold uppercase tracking-wider text-neutral-400">Builder</div>}
          <ul className={`space-y-0.5 text-[11px] ${className}`} data-testid="hardware-items">
            {builder.map((b) => (
              <li key={b.header} className="flex items-center gap-1 whitespace-nowrap">
                {b.value === null ? (
                  <>
                    <Check className="h-3 w-3 shrink-0 text-green-700" aria-label="Yes" />
                    {b.header}
                  </>
                ) : (
                  <>
                    {b.header}: <span className="font-mono font-semibold">{b.value}</span>
                  </>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      {comments.length > 0 && (
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-wider text-neutral-400">From Comments</div>
          <ItemList items={comments} className={className} testId="comment-items" />
        </div>
      )}
      {prep.length > 0 && (
        <div className={builder.length + comments.length > 0 ? 'border-t border-dashed border-neutral-300 pt-1' : ''}>
          {titled && <div className="text-[10px] font-semibold uppercase tracking-wider text-neutral-400">Prep / Install</div>}
          <ItemList items={prep} className={className} testId="prep-items" />
        </div>
      )}
    </div>
  )
}

/**
 * A door's or group's quotation comments, each once, in two groups: Door
 * Schedule Comments, then Mena Contractors Comments.
 */
export function CommentsCell({ doors }: { doors: Array<CommentSource | undefined> }) {
  const distinct = (texts: Array<string | undefined>) => [
    ...new Set(texts.flatMap((c) => (c ?? '').split(' | ')).map((c) => c.trim()).filter(Boolean)),
  ]
  const schedule = distinct(doors.map((d) => d?.schedule_comments))
  const mena = distinct(doors.map((d) => d?.mena_comments))
  // As coloured in the quotation: blue, red or black.
  // A comment's colour on the doors that have it; 'mixed' when they differ.
  const colorOf = (c: string): 'blue' | 'red' | 'black' | 'mixed' => {
    const having = doors.filter((d) =>
      [d?.schedule_comments, d?.mena_comments].some((t) => (t ?? '').split(' | ').map((x) => x.trim()).includes(c)),
    )
    const colors = new Set(having.map((d) => d?.comment_colors?.[c] ?? 'black'))
    return colors.size > 1 ? 'mixed' : ([...colors][0] ?? 'black')
  }
  const COLOR_CLASS = {
    blue: 'text-blue-700',
    red: 'text-red-600',
    black: 'text-neutral-900',
    mixed: 'text-neutral-900 border-l-2 border-amber-400 pl-1',
  } as const
  if (schedule.length === 0 && mena.length === 0) return <span className="text-neutral-400">—</span>
  const group = (title: string, items: string[], testId: string, divided: boolean) => (
    <div className={divided ? 'border-t border-dashed border-neutral-300 pt-1' : ''} data-testid={testId}>
      <div className="text-[10px] font-semibold uppercase tracking-wider text-neutral-400">{title}</div>
      {items.map((c) => {
        const color = colorOf(c)
        return (
          <div
            key={c}
            className={`line-clamp-3 ${COLOR_CLASS[color]}`}
            title={color === 'mixed' ? `${c} (a different colour on some doors in the quotation)` : c}
            data-color={color}
          >
            {c}
          </div>
        )
      })}
    </div>
  )
  return (
    <div className="max-w-xs space-y-1 text-[11px] text-neutral-700" data-testid="row-comments">
      {schedule.length > 0 && group('Door Schedule Comments', schedule, 'schedule-comments', false)}
      {mena.length > 0 && group('Mena Contractors Comments', mena, 'mena-comments', schedule.length > 0)}
    </div>
  )
}

/**
 * A group's notes (what the rules changed), one per line under a heading;
 * `grouped`: under what caused them ("LOCK PREP 25 (lockable)", "Hinge").
 */
export function NoteList({
  title,
  notes,
  testId,
  grouped = false,
}: {
  title: string
  notes: string[]
  testId: string
  grouped?: boolean
}) {
  const groups = grouped ? groupNotes(notes) : [{ cause: '', items: notes }]
  return (
    <div className="mt-1.5 text-[11px] text-neutral-700" data-testid={testId}>
      {title && <div className="font-semibold text-neutral-950">{title}</div>}
      <div className="mt-0.5 space-y-1">
        {groups.map((g) => (
          <div key={g.cause || '-'} data-testid="note-group">
            {g.cause && <div className="font-medium text-neutral-800">{g.cause}</div>}
            <ul className="list-disc space-y-0.5 pl-4 marker:text-neutral-400">
              {g.items.map((n, i) => (
                <li key={`${i}-${n}`}>{n}</li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </div>
  )
}
