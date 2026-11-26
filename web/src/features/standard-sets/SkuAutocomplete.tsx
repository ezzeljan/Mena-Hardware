import { useEffect, useMemo, useRef, useState } from 'react'
import type { Part } from '@/types/database'
import { Input } from '@/components/ui/input'
import { formatCurrency } from '@/lib/utils'

/** Options with this id prefix are generic set items, not parts (migration 027). */
export const GENERIC_OPTION_PREFIX = 'generic:'

interface SkuAutocompleteProps {
  id?: string
  value: string
  parts: Part[]
  onChange: (sku: string) => void
  onSelectPart: (part: Part) => void
  placeholder?: string
  /** Show each part's supplier (when parts from several suppliers are listed). */
  showSupplier?: boolean
}

export function SkuAutocomplete({
  id,
  value,
  parts,
  onChange,
  onSelectPart,
  placeholder = 'Type SKU or search library...',
  showSupplier = false,
}: SkuAutocompleteProps) {
  const [open, setOpen] = useState(false)
  const [highlightedIndex, setHighlightedIndex] = useState(0)
  const containerRef = useRef<HTMLDivElement | null>(null)

  const matches = useMemo(() => {
    const q = value.trim().toLowerCase()
    const activeParts = parts.filter((p) => p.active)
    if (!q) return activeParts.slice(0, 8)
    return activeParts
      .filter(
        (p) =>
          p.sku.toLowerCase().includes(q) ||
          p.description.toLowerCase().includes(q),
      )
      .slice(0, 8)
  }, [value, parts])

  useEffect(() => {
    setHighlightedIndex(0)
  }, [matches.length])

  useEffect(() => {
    function handleOutsideClick(e: MouseEvent) {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handleOutsideClick)
    return () => document.removeEventListener('mousedown', handleOutsideClick)
  }, [])

  const listboxId = id ? `${id}-listbox` : 'sku-autocomplete-listbox'
  const isListboxOpen = open && matches.length > 0
  const activeOption = isListboxOpen ? matches[highlightedIndex] : undefined

  return (
    <div ref={containerRef} className="relative">
      <Input
        id={id}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={isListboxOpen}
        aria-controls={listboxId}
        aria-activedescendant={
          activeOption ? `${listboxId}-opt-${activeOption.id}` : undefined
        }
        value={value}
        placeholder={placeholder}
        autoComplete="off"
        onFocus={() => setOpen(true)}
        onChange={(e) => {
          onChange(e.target.value)
          setOpen(true)
        }}
        onKeyDown={(e) => {
          if (!open || matches.length === 0) return
          if (e.key === 'ArrowDown') {
            e.preventDefault()
            setHighlightedIndex((prev) => (prev + 1) % matches.length)
          } else if (e.key === 'ArrowUp') {
            e.preventDefault()
            setHighlightedIndex(
              (prev) => (prev - 1 + matches.length) % matches.length,
            )
          } else if (e.key === 'Enter' && open) {
            const picked = matches[highlightedIndex]
            if (picked) {
              e.preventDefault()
              onSelectPart(picked)
              setOpen(false)
            }
          } else if (e.key === 'Escape') {
            setOpen(false)
          }
        }}
      />

      {isListboxOpen && (
        <ul
          id={listboxId}
          role="listbox"
          aria-label="Part suggestions"
          className="absolute z-50 mt-1 max-h-60 w-full overflow-auto rounded-md border border-neutral-300 bg-white py-1 shadow-lg text-xs"
        >
          {matches.map((part, idx) => {
            const isHighlighted = idx === highlightedIndex
            return (
              <li
                key={part.id}
                id={`${listboxId}-opt-${part.id}`}
                role="option"
                aria-selected={isHighlighted}
                onMouseDown={(e) => {
                  e.preventDefault()
                  onSelectPart(part)
                  setOpen(false)
                }}
                onMouseEnter={() => setHighlightedIndex(idx)}
                className={`px-3 py-2 cursor-pointer flex items-center justify-between gap-3 ${
                  isHighlighted
                    ? 'bg-neutral-950 text-white'
                    : 'text-neutral-900 hover:bg-neutral-100'
                }`}
              >
                <div className="min-w-0">
                  <div className="font-mono font-semibold">
                    {part.sku}
                    {showSupplier && part.suppliers?.name && (
                      <span
                        className={`ml-2 font-sans text-[10px] font-medium uppercase ${
                          isHighlighted ? 'text-neutral-300' : 'text-neutral-500'
                        }`}
                      >
                        {part.suppliers.name}
                      </span>
                    )}
                  </div>
                  <div
                    className={`truncate text-[11px] ${
                      isHighlighted ? 'text-neutral-300' : 'text-neutral-600'
                    }`}
                  >
                    {part.description}
                  </div>
                </div>
                <div className="font-mono shrink-0 text-[11px]">
                  {part.id.startsWith(GENERIC_OPTION_PREFIX)
                    ? 'Generic'
                    : part.unit_cost === null
                      ? 'No price'
                      : formatCurrency(Number(part.unit_cost))}
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
