import { useEffect, useState } from 'react'
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

export interface NewQuoteChoice {
  builderName: string
  supplier: { id: string; name: string }
}

interface NewQuoteDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Builders that already have a quote in this project. */
  existingBuilders: string[]
  onConfirm: (choice: NewQuoteChoice) => void
}

/**
 * Step before the quotation upload: which builder the quote is for, and the
 * supplier of its first sheet. More supplier sheets are added in the grid.
 */
export function NewQuoteDialog({
  open,
  onOpenChange,
  existingBuilders,
  onConfirm,
}: NewQuoteDialogProps) {
  const suppliersQuery = useSupplierOptions(open)
  const [builder, setBuilder] = useState('')
  const [supplierId, setSupplierId] = useState('')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (open) {
      setBuilder('')
      setSupplierId('')
      setError(null)
    }
  }, [open])

  const submit = () => {
    const name = builder.trim()
    if (!name) {
      setError('Enter the builder this quote is for.')
      return
    }
    if (name.length > 200) {
      setError('The builder name is too long.')
      return
    }
    if (existingBuilders.some((b) => b.trim().toLowerCase() === name.toLowerCase())) {
      setError(
        `This project already has a quote for "${name}". Open it and use Re-import Quotation instead.`,
      )
      return
    }
    const supplier = suppliersQuery.data?.find((s) => s.id === supplierId)
    if (!supplier) {
      setError('Choose the supplier for the first sheet.')
      return
    }
    onConfirm({ builderName: name, supplier: { id: supplier.id, name: supplier.name } })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New Hardware Quote</DialogTitle>
          <DialogDescription>
            Each builder gets its own quote. Choose the builder first, then upload their quotation
            file.
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
          noValidate
          onSubmit={(e) => {
            e.preventDefault()
            submit()
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="new-quote-builder">Builder</Label>
            <Input
              id="new-quote-builder"
              autoFocus
              placeholder="e.g. Hutchinson Builders"
              value={builder}
              onChange={(e) => setBuilder(e.target.value)}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="new-quote-supplier">First supplier sheet</Label>
            <select
              id="new-quote-supplier"
              value={supplierId}
              onChange={(e) => setSupplierId(e.target.value)}
              className="flex h-9 w-full rounded-md border border-neutral-300 bg-white px-3 py-1 text-sm text-neutral-950 focus:outline-none focus:ring-2 focus:ring-neutral-950"
            >
              <option value="">
                {suppliersQuery.isLoading ? 'Loading suppliers...' : 'Select supplier...'}
              </option>
              {suppliersQuery.data?.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
            <p className="text-[11px] text-neutral-500">
              You can add a sheet for each other supplier from the grid.
            </p>
          </div>

          <DialogFooter className="pt-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit">Continue to upload</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
