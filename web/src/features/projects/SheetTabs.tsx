import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Pencil, Plus, Trash2 } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import type { QuoteSheet } from '@/types/database'
import { useSupplierOptions } from '@/features/projects/useSuppliers'
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

interface SheetTabsProps {
  versionId: string
  sheets: QuoteSheet[]
  activeSheetId: string | null
  onSelect: (sheetId: string) => void
  /** Draft of an open quote, and the user can edit content. */
  editable: boolean
  /** PM comments per sheet (shown on the tabs). */
  commentCounts?: Map<string, number>
  /** Saves pending grid edits; resolves false if some could not be saved. */
  savePendingEdits: () => Promise<boolean>
}

type DialogState =
  | { kind: 'add' }
  | { kind: 'rename'; sheet: QuoteSheet }
  | { kind: 'remove'; sheet: QuoteSheet }
  | null

/**
 * Excel-style sheet tabs under the grid: one per supplier. In a draft the team
 * adds a sheet for another supplier (the door groups' lines are copied from a
 * sheet), renames sheets and removes them (a quote keeps at least one).
 */
export function SheetTabs({
  versionId,
  sheets,
  activeSheetId,
  onSelect,
  editable,
  commentCounts,
  savePendingEdits,
}: SheetTabsProps) {
  const queryClient = useQueryClient()
  const suppliersQuery = useSupplierOptions(editable)
  const [dialog, setDialog] = useState<DialogState>(null)
  const [supplierId, setSupplierId] = useState('')
  const [name, setName] = useState('')
  const [copyFrom, setCopyFrom] = useState('')
  const [error, setError] = useState<string | null>(null)

  const openDialog = (next: NonNullable<DialogState>) => {
    setError(null)
    if (next.kind === 'add') {
      setSupplierId('')
      setName('')
      setCopyFrom(activeSheetId ?? sheets[0]?.id ?? '')
    } else if (next.kind === 'rename') {
      setName(next.sheet.name)
    }
    setDialog(next)
  }

  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['quote_sheets'] }),
      queryClient.invalidateQueries({ queryKey: ['project_lines', versionId] }),
    ])
  }

  const usedSuppliers = new Set(sheets.map((s) => s.supplier_id))
  const availableSuppliers = (suppliersQuery.data ?? []).filter((s) => !usedSuppliers.has(s.id))

  const addMutation = useMutation({
    mutationFn: async (): Promise<string> => {
      if (!supplierId) throw new Error('Choose the supplier for the new sheet.')
      // The new sheet copies lines from the database: save grid edits first.
      if (!(await savePendingEdits())) {
        throw new Error('Some grid edits could not be saved. Fix the save error first.')
      }
      const { data, error } = await supabase.rpc('add_quote_sheet', {
        p_version_id: versionId,
        p_supplier_id: supplierId,
        p_name: name.trim() || null,
        p_source_sheet_id: copyFrom || null,
      })
      if (error) {
        throw new Error(
          error.code === '23505'
            ? 'That supplier or sheet name is already used in this quote.'
            : error.message,
        )
      }
      return data as string
    },
    onSuccess: async (sheetId) => {
      await refresh()
      setDialog(null)
      onSelect(sheetId)
    },
    onError: (err: Error) => setError(err.message),
  })

  const renameMutation = useMutation({
    mutationFn: async (sheet: QuoteSheet) => {
      const next = name.trim()
      if (!next) throw new Error('Enter a sheet name.')
      if (next.length > 100) throw new Error('The sheet name is too long.')
      const { data, error } = await supabase
        .from('quote_sheets')
        .update({ name: next })
        .eq('id', sheet.id)
        .select('id')
      if (error)
        throw new Error(
          error.code === '23505' ? 'Another sheet already has that name.' : error.message,
        )
      if (!data || data.length === 0) throw new Error('You cannot rename this sheet.')
    },
    onSuccess: async () => {
      await refresh()
      setDialog(null)
    },
    onError: (err: Error) => setError(err.message),
  })

  const removeMutation = useMutation({
    mutationFn: async (sheet: QuoteSheet) => {
      const { data, error } = await supabase
        .from('quote_sheets')
        .delete()
        .eq('id', sheet.id)
        .select('id')
      if (error) throw error
      if (!data || data.length === 0) throw new Error('You cannot remove this sheet.')
    },
    onSuccess: async (_d, sheet) => {
      setDialog(null)
      if (sheet.id === activeSheetId) {
        const next = sheets.find((s) => s.id !== sheet.id)
        if (next) onSelect(next.id)
      }
      await refresh()
    },
    onError: (err: Error) => setError(err.message),
  })

  const busy = addMutation.isPending || renameMutation.isPending || removeMutation.isPending

  return (
    <>
      <div
        role="tablist"
        aria-label="Supplier sheets"
        className="flex flex-wrap items-stretch gap-0.5 border border-t-0 border-neutral-400 bg-neutral-100 px-1 pb-1"
        data-testid="sheet-tabs"
      >
        {sheets.map((sheet) => {
          const active = sheet.id === activeSheetId
          const count = commentCounts?.get(sheet.id) ?? 0
          return (
            <div
              key={sheet.id}
              className={`flex items-center rounded-b-md border border-t-0 text-xs ${
                active
                  ? 'border-neutral-400 bg-white font-semibold text-neutral-950 shadow-sm'
                  : 'border-transparent text-neutral-600 hover:bg-white/70'
              }`}
            >
              <button
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => onSelect(sheet.id)}
                className="px-3 py-1.5 focus:outline-none focus-visible:ring-2 focus-visible:ring-neutral-950"
                data-testid="sheet-tab"
              >
                {sheet.name}
                {count > 0 && (
                  <span className="ml-1.5 rounded-full bg-sky-100 px-1.5 text-[10px] font-semibold text-sky-800">
                    {count}
                  </span>
                )}
              </button>
              {active && editable && (
                <span className="flex items-center gap-0.5 pr-1.5">
                  <button
                    type="button"
                    aria-label={`Rename the ${sheet.name} sheet`}
                    onClick={() => openDialog({ kind: 'rename', sheet })}
                    className="rounded p-0.5 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-950"
                  >
                    <Pencil className="h-3 w-3" />
                  </button>
                  {sheets.length > 1 && (
                    <button
                      type="button"
                      aria-label={`Remove the ${sheet.name} sheet`}
                      onClick={() => openDialog({ kind: 'remove', sheet })}
                      className="rounded p-0.5 text-neutral-400 hover:bg-neutral-100 hover:text-red-700"
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  )}
                </span>
              )}
            </div>
          )
        })}
        {editable && (
          <button
            type="button"
            onClick={() => openDialog({ kind: 'add' })}
            className="ml-1 flex items-center gap-1 rounded-b-md px-2.5 py-1.5 text-xs font-medium text-neutral-700 hover:bg-white hover:text-neutral-950"
            aria-label="Add a supplier sheet"
            data-testid="add-sheet"
          >
            <Plus className="h-3.5 w-3.5" />
            <span>Add sheet</span>
          </button>
        )}
      </div>

      <Dialog open={dialog !== null} onOpenChange={(o) => !o && !busy && setDialog(null)}>
        <DialogContent>
          {dialog?.kind === 'add' && (
            <>
              <DialogHeader>
                <DialogTitle>Add Supplier Sheet</DialogTitle>
                <DialogDescription>
                  The new sheet gets the same door groups and parts as the sheet you copy from.
                  Parts from another supplier are flagged in the grid so you can swap them.
                </DialogDescription>
              </DialogHeader>
              {error && (
                <div
                  role="alert"
                  className="border border-neutral-950 bg-neutral-100 p-3 text-xs text-neutral-950"
                >
                  {error}
                </div>
              )}
              <form
                className="space-y-4"
                onSubmit={(e) => {
                  e.preventDefault()
                  addMutation.mutate()
                }}
              >
                <div className="space-y-1.5">
                  <Label htmlFor="add-sheet-supplier">Supplier</Label>
                  <select
                    id="add-sheet-supplier"
                    value={supplierId}
                    onChange={(e) => setSupplierId(e.target.value)}
                    className="flex h-9 w-full rounded-md border border-neutral-300 bg-white px-3 py-1 text-sm text-neutral-950 focus:outline-none focus:ring-2 focus:ring-neutral-950"
                  >
                    <option value="">
                      {suppliersQuery.isLoading
                        ? 'Loading suppliers...'
                        : availableSuppliers.length === 0
                          ? 'Every supplier already has a sheet'
                          : 'Select supplier...'}
                    </option>
                    {availableSuppliers.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="add-sheet-name">Sheet name (optional)</Label>
                  <Input
                    id="add-sheet-name"
                    placeholder="Defaults to the supplier name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="add-sheet-copy">Copy door groups and parts from</Label>
                  <select
                    id="add-sheet-copy"
                    value={copyFrom}
                    onChange={(e) => setCopyFrom(e.target.value)}
                    className="flex h-9 w-full rounded-md border border-neutral-300 bg-white px-3 py-1 text-sm text-neutral-950 focus:outline-none focus:ring-2 focus:ring-neutral-950"
                  >
                    {sheets.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                </div>
                <DialogFooter>
                  <Button
                    type="button"
                    variant="outline"
                    disabled={busy}
                    onClick={() => setDialog(null)}
                  >
                    Cancel
                  </Button>
                  <Button type="submit" disabled={busy || !supplierId}>
                    {addMutation.isPending ? 'Adding...' : 'Add Sheet'}
                  </Button>
                </DialogFooter>
              </form>
            </>
          )}

          {dialog?.kind === 'rename' && (
            <>
              <DialogHeader>
                <DialogTitle>Rename Sheet</DialogTitle>
                <DialogDescription>
                  The supplier stays the same; only the tab name changes.
                </DialogDescription>
              </DialogHeader>
              {error && (
                <div
                  role="alert"
                  className="border border-neutral-950 bg-neutral-100 p-3 text-xs text-neutral-950"
                >
                  {error}
                </div>
              )}
              <form
                className="space-y-4"
                onSubmit={(e) => {
                  e.preventDefault()
                  renameMutation.mutate(dialog.sheet)
                }}
              >
                <div className="space-y-1.5">
                  <Label htmlFor="rename-sheet-name">Sheet name</Label>
                  <Input
                    id="rename-sheet-name"
                    autoFocus
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                  />
                </div>
                <DialogFooter>
                  <Button
                    type="button"
                    variant="outline"
                    disabled={busy}
                    onClick={() => setDialog(null)}
                  >
                    Cancel
                  </Button>
                  <Button type="submit" disabled={busy}>
                    {renameMutation.isPending ? 'Saving...' : 'Save'}
                  </Button>
                </DialogFooter>
              </form>
            </>
          )}

          {dialog?.kind === 'remove' && (
            <>
              <DialogHeader>
                <DialogTitle>Remove Sheet</DialogTitle>
                <DialogDescription>
                  Remove the <strong>{dialog.sheet.name}</strong> sheet and all of its hardware
                  lines from this draft? Earlier versions keep their copy.
                </DialogDescription>
              </DialogHeader>
              {error && (
                <div
                  role="alert"
                  className="border border-neutral-950 bg-neutral-100 p-3 text-xs text-neutral-950"
                >
                  {error}
                </div>
              )}
              <DialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  disabled={busy}
                  onClick={() => setDialog(null)}
                >
                  Cancel
                </Button>
                <Button
                  type="button"
                  disabled={busy}
                  onClick={() => removeMutation.mutate(dialog.sheet)}
                >
                  {removeMutation.isPending ? 'Removing...' : 'Remove Sheet'}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}
