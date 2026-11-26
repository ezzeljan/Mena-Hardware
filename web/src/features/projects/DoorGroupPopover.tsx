/**
 * The Hardware grid's door group popover (click the room name): what the
 * quotation said about the group (doors, Builder HW, prep / install values,
 * comments), the lines flagged for review, and the import rules' notes (what
 * they changed, and hardware to consider).
 */
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Flag, X } from 'lucide-react'
import type { DoorGroup, ProjectLine } from '@/types/database'
import type { GroupQuoteInfo } from '@/features/projects/groupQuoteInfo'
import { groupKeyHardware } from '@/features/projects/groupKey'
import { CommentsCell, HardwareCell, NoteList } from '@/features/projects/quotationDisplay'

const WIDTH = 420
const GAP = 6
const MARGIN = 12

function Section({ title, children, testId }: { title: string; children: ReactNode; testId: string }) {
  return (
    <section className="border-t border-neutral-200 px-4 py-3" data-testid={testId}>
      <h3 className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-neutral-500">{title}</h3>
      {children}
    </section>
  )
}

export function DoorGroupPopover({
  group,
  info,
  lines,
  anchor,
  onClose,
}: {
  group: DoorGroup
  /** Saved with the upload; null for groups imported before it was kept. */
  info: GroupQuoteInfo | null
  /** The group's lines on the sheet shown. */
  lines: ProjectLine[]
  anchor: HTMLElement
  onClose: () => void
}) {
  const panelRef = useRef<HTMLDivElement | null>(null)
  const [pos, setPos] = useState<{ top: number; left: number; maxHeight: number } | null>(null)

  // Below the room name (above it when there's more room there), kept on screen.
  useLayoutEffect(() => {
    const place = () => {
      const r = anchor.getBoundingClientRect()
      const below = window.innerHeight - r.bottom - GAP - MARGIN
      const above = r.top - GAP - MARGIN
      const height = panelRef.current?.offsetHeight ?? 0
      const openAbove = height > below && above > below
      const maxHeight = Math.max(160, openAbove ? above : below)
      const shown = Math.min(height, maxHeight)
      const left = Math.min(Math.max(MARGIN, r.left), window.innerWidth - WIDTH - MARGIN)
      setPos({ top: openAbove ? r.top - GAP - shown : r.bottom + GAP, left, maxHeight })
    }
    place()
    window.addEventListener('resize', place)
    // Again when its content changes size (the details finish loading).
    const ro = new ResizeObserver(place)
    for (const child of Array.from(panelRef.current?.children ?? [])) ro.observe(child)
    return () => {
      window.removeEventListener('resize', place)
      ro.disconnect()
    }
  }, [anchor])

  // Closes on Escape, a click outside, or scrolling the page / grid.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node
      if (!panelRef.current?.contains(t) && !anchor.contains(t)) onClose()
    }
    const onScroll = (e: Event) => {
      if (!panelRef.current?.contains(e.target as Node)) onClose()
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('mousedown', onDown)
    window.addEventListener('scroll', onScroll, true)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('mousedown', onDown)
      window.removeEventListener('scroll', onScroll, true)
    }
  }, [anchor, onClose])

  const hardware = info?.hardware || groupKeyHardware(group.group_key)
  const flagged = lines.filter((l) => l.review_flag?.trim())
  const specs = [group.classification, group.leaf, group.door_size].filter(Boolean).join(' · ')

  return createPortal(
    <div
      ref={panelRef}
      role="dialog"
      aria-label={`${group.room_name} details`}
      data-testid="door-group-popover"
      className="fixed z-50 overflow-y-auto border border-neutral-300 bg-white text-xs text-neutral-800 shadow-xl"
      style={{
        width: WIDTH,
        top: pos?.top ?? -9999,
        left: pos?.left ?? -9999,
        maxHeight: pos?.maxHeight,
      }}
    >
      <header className="flex items-start justify-between gap-3 px-4 py-3">
        <div>
          <div className="text-sm font-semibold text-neutral-950">{group.room_name}</div>
          {specs && <div className="font-mono text-[11px] text-neutral-500">{specs}</div>}
          <div className="mt-0.5 text-[11px] text-neutral-600">
            {Number(group.door_qty)} door{Number(group.door_qty) === 1 ? '' : 's'}
            {info && info.doors.length > 0 && <> · {info.doors.join(', ')}</>}
          </div>
          {group.match_reason && <div className="mt-0.5 text-[11px] text-neutral-500">{group.match_reason}</div>}
        </div>
        <button
          type="button"
          onClick={onClose}
          className="p-0.5 text-neutral-500 hover:text-neutral-950"
          aria-label="Close"
        >
          <X className="h-4 w-4" />
        </button>
      </header>

      <Section title="From the quotation" testId="popover-quotation">
        <HardwareCell hardware={hardware} headers={info?.headers ?? []} prepValues={info?.prep_values} />
        {info && info.comments.length > 0 && (
          <div className="mt-2">
            <CommentsCell doors={info.comments} />
          </div>
        )}
        {!info && (
          <p className="mt-1.5 text-[11px] text-neutral-500">
            Imported before the quotation&apos;s comments and values were kept: re-import to see them.
          </p>
        )}
      </Section>

      <Section title={`Flagged for review (${flagged.length})`} testId="popover-flagged">
        {flagged.length === 0 ? (
          <p className="text-[11px] text-neutral-500">Nothing flagged on this sheet.</p>
        ) : (
          <ul className="space-y-1">
            {flagged.map((l) => (
              <li key={l.id} className="flex gap-1.5 text-[11px]">
                <Flag className="mt-0.5 h-3 w-3 shrink-0 text-orange-600" aria-hidden="true" />
                <span>
                  <span className="font-mono font-semibold text-neutral-950">{l.sku}</span>{' '}
                  <span className="text-neutral-700">{l.review_flag}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      {info && info.notes.length > 0 && (
        <Section title="Changes and suggestions" testId="popover-notes">
          <div className="-mt-1.5">
            <NoteList title="" notes={info.notes} testId="popover-note-list" grouped />
          </div>
        </Section>
      )}
    </div>,
    document.body,
  )
}
