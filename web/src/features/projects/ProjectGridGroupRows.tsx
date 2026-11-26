import { useEffect, useRef, useState, type ReactNode } from 'react'
import { ArrowDown, ArrowUp, Flag, MessageSquare, Plus, Trash2, Split } from 'lucide-react'
import { formatCurrency } from '@/lib/utils'
import type { DoorGroup, ProjectLine } from '@/types/database'
import { DoorGroupPopover } from '@/features/projects/DoorGroupPopover'
import type { GroupQuoteInfo } from '@/features/projects/groupQuoteInfo'
import { Button } from '@/components/ui/button'

/** Editable grid columns: 0 sku, 1 description, 2 qty_per_door, 3 unit cost, 4 MHQT remarks. */
export type EditableCol = 0 | 1 | 2 | 3 | 4

/** Last editable column (keyboard navigation wraps after it). */
export const LAST_EDITABLE_COL: EditableCol = 4

/** Grid column headers, in the order of the NOVAS Template (door details first). */
export const GRID_COLUMNS: { label: string; align?: 'right' | 'center' }[] = [
  { label: 'ROOM NAME' },
  { label: 'DOOR TAG' },
  { label: 'DOOR SIZE' },
  { label: 'DOOR CLASSIFICATION' },
  { label: 'LEAFS' },
  { label: 'LEGEND' },
  { label: 'MANUFACTURER' },
  { label: 'PART NUMBER (SKU)' },
  { label: 'DESCRIPTION' },
  { label: 'QTY', align: 'right' },
  { label: 'COST', align: 'right' },
  { label: 'COST DOOR', align: 'right' },
  { label: 'PRICE', align: 'right' },
  { label: 'PRICE DOOR', align: 'right' },
  { label: 'HW PRICE PER DOOR TYPE', align: 'right' },
  { label: 'OVERALL HW PRICE PER TYPICAL DOOR', align: 'right' },
  { label: 'TOTAL ITEMS PER TYPICAL DOOR', align: 'center' },
  { label: 'MHQT REMARKS' },
]

/** Supplier of a line, from its Parts Library part. */
export interface LineSupplier {
  name: string
  ownerSupplied: boolean
  /** LEGEND column: the part's legend, else "MM" for owner-supplied parts. */
  legend: string
  /** The part is from another supplier than the sheet's. */
  other: boolean
}

/** One door group in the hardware grid: its header row and its line rows. */
interface GroupRowsFragmentProps {
  group: DoorGroup
  doorTag: string
  groupLines: ProjectLine[]
  markupFactor: number
  editable: boolean
  supplierOf: (line: ProjectLine) => LineSupplier | null
  /** PM comments on this door group. */
  commentCount: number
  onOpenComments?: () => void
  /** Scrolled to and highlighted (picked in the comments drawer). */
  highlighted?: boolean
  renderEditableCell: (
    line: ProjectLine,
    col: EditableCol,
    display: ReactNode,
    alignRight?: boolean,
  ) => ReactNode
  onAddLine: () => void
  onDeleteLine: (line: ProjectLine) => void
  /** Clears a line's review flag (the estimator has checked it). */
  onClearFlag?: (line: ProjectLine) => void
  onMoveLine: (line: ProjectLine, dir: -1 | 1) => void
  /** Ticked to merge with other groups (editable drafts only). */
  selected?: boolean
  onToggleSelect?: () => void
  /** The group was merged: split it back into the groups it was made from. */
  onUnmerge?: () => void
  /** What the quotation said about the group (the room name's popover); null when not kept. */
  quoteInfo?: GroupQuoteInfo | null
}

const CELL = 'border border-neutral-300 px-2 py-0.5'
const NUM = 'text-right font-mono text-xs whitespace-nowrap'
const dash = <span className="text-neutral-400">—</span>

export function GroupRowsFragment({
  group,
  doorTag,
  groupLines,
  markupFactor,
  editable,
  supplierOf,
  commentCount,
  onOpenComments,
  highlighted = false,
  renderEditableCell,
  onAddLine,
  onDeleteLine,
  onMoveLine,
  onClearFlag,
  selected = false,
  onToggleSelect,
  onUnmerge,
  quoteInfo = null,
}: GroupRowsFragmentProps) {
  const rowRef = useRef<HTMLTableRowElement | null>(null)
  const roomRef = useRef<HTMLButtonElement | null>(null)
  const [detailsOpen, setDetailsOpen] = useState(false)
  const flaggedCount = groupLines.filter((l) => l.review_flag?.trim()).length

  useEffect(() => {
    if (highlighted) rowRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }, [highlighted])

  // Template formulas: Cost Door = QTY × Cost; Price = Cost × (1 + markup);
  // Price Door = QTY × Price; per door type = Σ Price Door; overall = door qty × that.
  const doorQty = Number(group.door_qty)
  const costPerDoor = groupLines.reduce(
    (sum, l) => (l.unit_price === null ? sum : sum + Number(l.qty_per_door) * Number(l.unit_price)),
    0,
  )
  const pricePerDoor = costPerDoor * markupFactor

  return (
    <>
      {/* Door Group Header Row (matches Excel DOOR HARDWARE SET sheet) */}
      <tr
        ref={rowRef}
        className={`font-semibold text-neutral-950 transition-colors ${highlighted ? 'bg-amber-100' : 'bg-neutral-100'
          }`}
        data-group-id={group.id}
      >
        <td className="border border-neutral-300 px-2 py-1 whitespace-nowrap">
          <span className="inline-flex items-center gap-2">
            {onToggleSelect && (
              <input
                type="checkbox"
                className="h-3.5 w-3.5 accent-neutral-950"
                checked={selected}
                onChange={onToggleSelect}
                aria-label={`Select ${group.room_name} to merge`}
                title="Select to merge with other door groups"
              />
            )}
            {/* The quotation's details, flagged lines and the import's notes. */}
            <button
              ref={roomRef}
              type="button"
              onClick={() => setDetailsOpen((o) => !o)}
              className="underline decoration-neutral-400 decoration-dotted underline-offset-2 hover:decoration-neutral-950"
              aria-expanded={detailsOpen}
              aria-haspopup="dialog"
              title="Show what the quotation says, flagged lines and suggestions"
            >
              {group.room_name}
            </button>
            {flaggedCount > 0 && (
              <span
                className="inline-flex items-center gap-0.5 rounded-full bg-orange-100 px-1.5 py-px text-[10px] font-semibold text-orange-700"
                title={`${flaggedCount} line${flaggedCount === 1 ? '' : 's'} flagged for review`}
              >
                <Flag className="h-2.5 w-2.5" aria-hidden="true" />
                {flaggedCount}
              </span>
            )}
            {detailsOpen && roomRef.current && (
              <DoorGroupPopover
                group={group}
                info={quoteInfo}
                lines={groupLines}
                anchor={roomRef.current}
                onClose={() => setDetailsOpen(false)}
              />
            )}
            {onUnmerge && (
              <button
                type="button"
                onClick={onUnmerge}
                className="inline-flex items-center gap-1 rounded border border-neutral-300 bg-white px-1.5 py-px text-[10px] font-semibold text-neutral-700 hover:bg-neutral-50"
                title={`Merged from ${(group.merged_from ?? []).map((p) => `${p.room_name} (${Number(p.door_qty)})`).join(', ')}`}
                aria-label={`Unmerge ${group.room_name}`}
              >
                <Split className="h-2.5 w-2.5" />
                Unmerge
              </button>
            )}
            {onOpenComments && commentCount > 0 && (
              <button
                type="button"
                onClick={onOpenComments}
                className="inline-flex items-center gap-0.5 rounded-full bg-neutral-950 px-1.5 py-px text-[10px] font-semibold text-white hover:bg-neutral-700"
                aria-label={`${commentCount} PM comment${commentCount === 1 ? '' : 's'} on ${group.room_name}`}
                title="Show PM comments"
              >
                <MessageSquare className="h-2.5 w-2.5" />
                {commentCount}
              </button>
            )}
          </span>
        </td>
        <td className="border border-neutral-300 px-2 py-1 whitespace-nowrap font-normal text-neutral-700">
          {doorTag}
        </td>
        <td className="border border-neutral-300 px-2 py-1 whitespace-nowrap font-mono">
          {group.door_size || ''}
        </td>
        <td className="border border-neutral-300 px-2 py-1 whitespace-nowrap">
          {group.classification || ''}
        </td>
        <td className="border border-neutral-300 px-2 py-1 whitespace-nowrap">
          {group.leaf || ''}
        </td>
        {/* LEGEND: only the parts' legends (the quotation's hardware is in the room name's popover). */}
        <td className="border border-neutral-300 px-2 py-1" />
        <td className="border border-neutral-300 px-2 py-1" />
        <td className="border border-neutral-300 px-2 py-1" />
        {/* As in the Excel export: the label in DESCRIPTION, only the number in QTY. */}
        <td className="border border-neutral-300 px-2 py-1 text-right font-mono whitespace-nowrap">
          DOOR QTY:
        </td>
        <td className="border border-neutral-300 px-2 py-1 text-right font-mono bg-neutral-200/70 whitespace-nowrap">
          {group.door_qty}
        </td>
        <td className="border border-neutral-300 px-2 py-1" />
        <td className="border border-neutral-300 px-2 py-1 text-right font-mono whitespace-nowrap">
          {formatCurrency(costPerDoor)}
        </td>
        <td className="border border-neutral-300 px-2 py-1" />
        <td className="border border-neutral-300 px-2 py-1 text-right font-mono whitespace-nowrap">
          {formatCurrency(pricePerDoor)}
        </td>
        <td className="border border-neutral-300 px-2 py-1 text-right font-mono font-normal whitespace-nowrap">
          {formatCurrency(pricePerDoor)}
        </td>
        <td className="border border-neutral-300 px-2 py-1 text-right font-mono whitespace-nowrap bg-sky-100/70">
          {formatCurrency(doorQty * pricePerDoor)}
        </td>
        <td className="border border-neutral-300 px-2 py-1" />
        <td className="border border-neutral-300 px-2 py-1" />
        {editable && (
          <td className="border border-neutral-300 px-1 py-0.5 text-center">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-6 px-1.5 text-[11px]"
              onClick={onAddLine}
            >
              <Plus className="h-3 w-3" />
              <span>Add</span>
            </Button>
          </td>
        )}
      </tr>

      {/* Hardware Line Rows directly beneath */}
      {groupLines.map((line, idx) => {
        const qty = Number(line.qty_per_door)
        const cost = line.unit_price === null ? null : Number(line.unit_price)
        const price = cost === null ? null : cost * markupFactor
        const maker = supplierOf(line)

        const isAdded = line.origin === 'added'
        const addedBg = isAdded ? 'bg-green-100/80' : ''
        const noPriceBg = cost === null ? 'bg-amber-50' : addedBg

        const flag = line.review_flag?.trim() ?? ''

        return (
          <tr
            key={line.id}
            className={flag ? 'bg-orange-50' : 'bg-white'}
            data-flagged={flag ? 'true' : undefined}
          >
            <td className={`${CELL} whitespace-nowrap`}>
              {/* Flagged on import (e.g. a set part the quotation doesn't price): check, then clear. */}
              {flag && (
                <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-orange-700" title={flag}>
                  <Flag className="h-3 w-3" aria-hidden="true" />
                  <span>Check</span>
                  {editable && onClearFlag && (
                    <button
                      type="button"
                      className="ml-1 rounded border border-orange-300 bg-white px-1 text-[10px] font-medium text-orange-800 hover:bg-orange-100"
                      aria-label={`Clear flag: ${flag}`}
                      title={`${flag} — click when checked`}
                      onClick={() => onClearFlag(line)}
                    >
                      Clear
                    </button>
                  )}
                </span>
              )}
            </td>
            <td className={CELL} />
            <td className={CELL} />
            <td className={CELL} />
            <td className={CELL} />
            <td className={`${CELL} text-xs font-medium text-neutral-700 whitespace-nowrap ${addedBg}`}>
              {maker?.legend ?? ''}
            </td>
            <td className={`${CELL} text-xs text-neutral-700 whitespace-nowrap ${addedBg}`}>
              {maker?.name ?? ''}
              {maker?.other && (
                <span
                  className="ml-1.5 rounded border border-amber-300 bg-amber-50 px-1 py-px text-[10px] font-semibold uppercase text-amber-800"
                  title="This part is from another supplier than the sheet's"
                  data-testid="other-supplier-badge"
                >
                  Other supplier
                </span>
              )}
            </td>
            <td className={`border border-neutral-300 p-0 whitespace-nowrap ${addedBg}`}>
              {renderEditableCell(
                line,
                0,
                <span className="font-mono text-xs font-medium text-neutral-950 whitespace-nowrap">
                  {line.sku || dash}
                </span>,
              )}
            </td>
            <td className={`border border-neutral-300 p-0 whitespace-nowrap ${addedBg}`}>
              {renderEditableCell(
                line,
                1,
                <span className="text-xs text-neutral-900 whitespace-nowrap">
                  {line.description || dash}
                </span>,
              )}
            </td>
            <td className={`border border-neutral-300 p-0 whitespace-nowrap ${addedBg}`}>
              {renderEditableCell(line, 2, <span className="font-mono text-xs">{line.qty_per_door}</span>, true)}
            </td>
            <td className={`border border-neutral-300 p-0 whitespace-nowrap ${noPriceBg}`}>
              {renderEditableCell(
                line,
                3,
                cost === null ? (
                  <span className="font-mono text-xs text-neutral-400">—</span>
                ) : (
                  <span className="font-mono text-xs">{formatCurrency(cost)}</span>
                ),
                true,
              )}
            </td>
            <td className={`${CELL} ${NUM} text-neutral-900 ${noPriceBg}`}>
              {cost === null ? dash : formatCurrency(qty * cost)}
            </td>
            <td className={`${CELL} ${NUM} text-neutral-900 ${noPriceBg}`}>
              {price === null ? dash : formatCurrency(price)}
            </td>
            <td className={`${CELL} ${NUM} text-neutral-900 ${noPriceBg}`}>
              {price === null ? dash : formatCurrency(qty * price)}
            </td>
            <td className={CELL} />
            <td className={CELL} />
            <td className={`${CELL} text-center font-mono text-xs text-neutral-900`}>
              {qty * doorQty}
            </td>
            <td className="border border-neutral-300 p-0 whitespace-nowrap">
              {renderEditableCell(
                line,
                4,
                <span
                  className="block max-w-[16rem] truncate text-xs text-neutral-800"
                  title={line.mhqt_remarks || undefined}
                >
                  {line.mhqt_remarks || ''}
                </span>,
              )}
            </td>
            {editable && (
              <td className="border border-neutral-300 px-1 py-0.5 text-center">
                <div className="inline-flex items-center gap-0.5">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-5 w-5"
                    disabled={idx === 0}
                    aria-label="Move line up"
                    onClick={() => onMoveLine(line, -1)}
                  >
                    <ArrowUp className="h-3 w-3" />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-5 w-5"
                    disabled={idx === groupLines.length - 1}
                    aria-label="Move line down"
                    onClick={() => onMoveLine(line, 1)}
                  >
                    <ArrowDown className="h-3 w-3" />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-5 w-5"
                    aria-label="Delete line"
                    onClick={() => onDeleteLine(line)}
                  >
                    <Trash2 className="h-3 w-3" />
                  </Button>
                </div>
              </td>
            )}
          </tr>
        )
      })}
    </>
  )
}
