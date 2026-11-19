import { useState } from 'react'
import type { Part } from '@/types/database'
import { SkuAutocomplete } from '@/features/standard-sets/SkuAutocomplete'
import { Input } from '@/components/ui/input'

export interface CellMove {
  dRow: number
  dCol: number
}

interface GridCellEditorProps {
  initialValue: string
  /** SKU column: autocomplete from the parts library. */
  isSku: boolean
  parts: Part[]
  alignRight?: boolean
  onCommit: (value: string, move?: CellMove) => void
  onCancel: () => void
  onSelectPart: (part: Part) => void
}

/**
 * The input shown while a grid cell is being edited. It keeps the typed text
 * in its own state, so typing only re-renders this cell instead of the whole
 * hardware grid.
 */
export function GridCellEditor({
  initialValue,
  isSku,
  parts,
  alignRight = false,
  onCommit,
  onCancel,
  onSelectPart,
}: GridCellEditorProps) {
  const [value, setValue] = useState(initialValue)

  if (isSku) {
    return (
      <div
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault()
            onCancel()
          } else if (e.key === 'Tab') {
            e.preventDefault()
            onCommit(value, { dRow: 0, dCol: e.shiftKey ? -1 : 1 })
          }
        }}
      >
        <SkuAutocomplete
          value={value}
          parts={parts}
          onChange={setValue}
          onSelectPart={onSelectPart}
          placeholder="SKU..."
        />
      </div>
    )
  }

  return (
    <Input
      autoFocus
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => onCommit(value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          onCommit(value, { dRow: 1, dCol: 0 })
        } else if (e.key === 'Tab') {
          e.preventDefault()
          onCommit(value, { dRow: 0, dCol: e.shiftKey ? -1 : 1 })
        } else if (e.key === 'Escape') {
          e.preventDefault()
          onCancel()
        }
      }}
      className={`h-6 px-1.5 text-xs font-mono rounded-none border-neutral-950 ${
        alignRight ? 'text-right' : ''
      }`}
    />
  )
}
