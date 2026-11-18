import { useEffect, useState, type ReactNode } from 'react'
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react'
import { formatCurrency } from '@/lib/utils'
import type { DoorGroup, ProjectLine } from '@/types/database'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

/** Editable grid columns: 0 sku, 1 description, 2 qty_per_door, 3 unit_price. */
export type EditableCol = 0 | 1 | 2 | 3

/** One door group in the hardware grid: its header row and its line rows. */
interface GroupRowsFragmentProps {
  group: DoorGroup
  doorTag: string
  groupLines: ProjectLine[]
  groupCost: number
  markupFactor: number
  editable: boolean
  pmRemarksEditable: boolean
  onSavePmRemark: (remarks: string) => void
  renderEditableCell: (
    line: ProjectLine,
    col: EditableCol,
    display: ReactNode,
    alignRight?: boolean,
  ) => ReactNode
  onAddLine: () => void
  onDeleteLine: (line: ProjectLine) => void
  onMoveLine: (line: ProjectLine, dir: -1 | 1) => void
}

export function GroupRowsFragment({
  group,
  doorTag,
  groupLines,
  groupCost,
  markupFactor,
  editable,
  pmRemarksEditable,
  onSavePmRemark,
  renderEditableCell,
  onAddLine,
  onDeleteLine,
  onMoveLine,
}: GroupRowsFragmentProps) {
  const [editingRemark, setEditingRemark] = useState(false)
  const [remarkDraft, setRemarkDraft] = useState(group.pm_remarks || '')

  useEffect(() => {
    setRemarkDraft(group.pm_remarks || '')
  }, [group.pm_remarks])
  return (
    <>
      {/* Door Group Header Row (matches Excel DOOR HARDWARE SET sheet) */}
      <tr className="bg-neutral-100 font-semibold text-neutral-950">
        <td className="border border-neutral-300 px-2 py-1 whitespace-nowrap">
          {group.room_name}
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
        <td className="border border-neutral-300 px-2 py-1" />
        <td className="border border-neutral-300 px-2 py-1" />
        <td className="border border-neutral-300 px-2 py-1 text-right font-mono bg-neutral-200/70 whitespace-nowrap">
          DOOR QTY: {group.door_qty}
        </td>
        <td className="border border-neutral-300 px-2 py-1" />
        <td className="border border-neutral-300 px-2 py-1 text-right font-mono whitespace-nowrap">
          {formatCurrency(groupCost)}
        </td>
        <td className="border border-neutral-300 px-2 py-1 text-right font-mono whitespace-nowrap">
          {formatCurrency(groupCost * markupFactor)}
        </td>
        <td className="border border-neutral-300 p-0 text-xs text-neutral-700 whitespace-nowrap">
          {editingRemark && pmRemarksEditable ? (
            <Input
              autoFocus
              value={remarkDraft}
              onChange={(e) => setRemarkDraft(e.target.value)}
              onBlur={() => {
                setEditingRemark(false)
                if (remarkDraft.trim() !== (group.pm_remarks || '').trim()) {
                  onSavePmRemark(remarkDraft.trim())
                }
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.currentTarget.blur()
                } else if (e.key === 'Escape') {
                  setRemarkDraft(group.pm_remarks || '')
                  setEditingRemark(false)
                }
              }}
              className="h-6 px-1.5 text-xs rounded-none border-neutral-950 font-normal"
            />
          ) : (
            <div
              onClick={() => {
                if (pmRemarksEditable) {
                  setRemarkDraft(group.pm_remarks || '')
                  setEditingRemark(true)
                }
              }}
              className={`min-h-6 flex items-center px-2 font-normal ${
                pmRemarksEditable
                  ? 'cursor-text hover:bg-neutral-200/60'
                  : ''
              }`}
              title={pmRemarksEditable ? 'Click to edit PM remark' : undefined}
            >
              {group.pm_remarks || (
                pmRemarksEditable ? (
                  <span className="text-neutral-400">Add remark...</span>
                ) : null
              )}
            </div>
          )}
        </td>
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
        const lineCost =
          line.unit_price === null
            ? null
            : Number(line.qty_per_door) *
              Number(group.door_qty) *
              Number(line.unit_price)

        const isAdded = line.origin === 'added'
        const addedBg = isAdded ? 'bg-green-100/80' : ''

        return (
          <tr key={line.id} className="bg-white">
            <td className="border border-neutral-300 px-2 py-0.5" />
            <td className="border border-neutral-300 px-2 py-0.5" />
            <td className="border border-neutral-300 px-2 py-0.5" />
            <td className="border border-neutral-300 px-2 py-0.5" />
            <td className="border border-neutral-300 px-2 py-0.5" />
            <td className={`border border-neutral-300 p-0 whitespace-nowrap ${addedBg}`}>
              {renderEditableCell(
                line,
                0,
                <span className="font-mono text-xs font-medium text-neutral-950 whitespace-nowrap">
                  {line.sku || <span className="text-neutral-400">—</span>}
                </span>,
              )}
            </td>
            <td className={`border border-neutral-300 p-0 whitespace-nowrap ${addedBg}`}>
              {renderEditableCell(
                line,
                1,
                <span className="text-xs text-neutral-900 whitespace-nowrap">
                  {line.description || <span className="text-neutral-400">—</span>}
                </span>,
              )}
            </td>
            <td className={`border border-neutral-300 p-0 whitespace-nowrap ${addedBg}`}>
              {renderEditableCell(
                line,
                2,
                <span className="font-mono text-xs">{line.qty_per_door}</span>,
                true,
              )}
            </td>
            <td className={`border border-neutral-300 p-0 whitespace-nowrap ${addedBg}`}>
              {renderEditableCell(
                line,
                3,
                line.unit_price === null ? (
                  <span className="font-mono text-xs text-neutral-400">—</span>
                ) : (
                  <span className="font-mono text-xs">
                    {formatCurrency(line.unit_price)}
                  </span>
                ),
                true,
              )}
            </td>
            <td className={`border border-neutral-300 px-2 py-0.5 text-right font-mono text-xs text-neutral-900 whitespace-nowrap ${addedBg}`}>
              {lineCost === null ? (
                <span className="text-neutral-400">—</span>
              ) : (
                formatCurrency(lineCost)
              )}
            </td>
            <td className={`border border-neutral-300 px-2 py-0.5 text-right font-mono text-xs text-neutral-900 whitespace-nowrap ${addedBg}`}>
              {lineCost === null ? (
                <span className="text-neutral-400">—</span>
              ) : (
                formatCurrency(lineCost * markupFactor)
              )}
            </td>
            <td className={`border border-neutral-300 px-2 py-0.5 text-xs text-neutral-600 whitespace-nowrap ${addedBg}`} />
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
