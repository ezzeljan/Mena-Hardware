import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Building2, Pencil, Plus } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/features/auth/AuthContext'
import {
  supplierSchema,
  type SupplierFormValues,
} from '@/lib/schemas'
import type { Supplier } from '@/types/database'
import { Badge } from '@/components/ui/badge'
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'

export function SuppliersPage() {
  const { isAdmin } = useAuth()
  const queryClient = useQueryClient()
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editingMfg, setEditingMfg] = useState<Supplier | null>(null)
  const [formError, setFormError] = useState<string | null>(null)

  const form = useForm<SupplierFormValues>({
    resolver: zodResolver(supplierSchema),
    defaultValues: {
      name: '',
      is_owner_supplied: false,
    },
  })

  const suppliersQuery = useQuery({
    queryKey: ['suppliers'],
    queryFn: async (): Promise<Supplier[]> => {
      const { data, error } = await supabase
        .from('suppliers')
        .select('id, name, is_owner_supplied, created_at, updated_at')
        .order('name', { ascending: true })
      if (error) throw error
      return (data ?? []) as Supplier[]
    },
  })

  const saveMutation = useMutation({
    mutationFn: async (values: SupplierFormValues) => {
      const parsed = supplierSchema.parse(values)
      if (editingMfg) {
        const { error } = await supabase
          .from('suppliers')
          .update({
            name: parsed.name,
            is_owner_supplied: parsed.is_owner_supplied,
          })
          .eq('id', editingMfg.id)
        if (error) throw error
      } else {
        const { error } = await supabase.from('suppliers').insert({
          name: parsed.name,
          is_owner_supplied: parsed.is_owner_supplied,
        })
        if (error) throw error
      }
    },
    onSuccess: async () => {
      setDialogOpen(false)
      setEditingMfg(null)
      setFormError(null)
      await queryClient.invalidateQueries({ queryKey: ['suppliers'] })
      await queryClient.invalidateQueries({ queryKey: ['parts'] })
    },
    onError: (err: Error) => {
      setFormError(err.message)
    },
  })

  function openAddDialog() {
    setEditingMfg(null)
    setFormError(null)
    form.reset({ name: '', is_owner_supplied: false })
    setDialogOpen(true)
  }

  function openEditDialog(mfg: Supplier) {
    setEditingMfg(mfg)
    setFormError(null)
    form.reset({
      name: mfg.name,
      is_owner_supplied: mfg.is_owner_supplied,
    })
    setDialogOpen(true)
  }

  return (
    <div className="space-y-6 max-w-5xl">
      <div className="flex items-center justify-between border-b border-neutral-200 pb-4">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-neutral-950 flex items-center gap-2">
            <Building2 className="h-5 w-5" />
            <span>Suppliers</span>
          </h1>
          <p className="text-sm text-neutral-600 mt-0.5">
            Hardware brands and owner-supplied material sources (MM).
          </p>
        </div>

        {isAdmin && (
          <Button onClick={openAddDialog} size="sm">
            <Plus className="h-4 w-4" />
            <span>Add Supplier</span>
          </Button>
        )}
      </div>

      {suppliersQuery.isLoading ? (
        <div className="border border-neutral-200 p-8 text-center text-sm text-neutral-600">
          Loading suppliers...
        </div>
      ) : suppliersQuery.isError ? (
        <div
          role="alert"
          className="border border-neutral-950 bg-neutral-50 p-6 text-sm text-neutral-950"
        >
          Error loading suppliers: {(suppliersQuery.error as Error).message}
        </div>
      ) : (suppliersQuery.data?.length ?? 0) === 0 ? (
        <div className="border border-neutral-200 p-8 text-center text-sm text-neutral-600">
          No suppliers found. Run the seed script or add a supplier.
        </div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Supplier Name</TableHead>
              <TableHead>Supply Type</TableHead>
              <TableHead>Last Updated</TableHead>
              {isAdmin && <TableHead className="text-right">Actions</TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {suppliersQuery.data?.map((mfg) => (
              <TableRow key={mfg.id}>
                <TableCell className="font-semibold tracking-tight">
                  {mfg.name}
                </TableCell>
                <TableCell>
                  {mfg.is_owner_supplied ? (
                    <Badge variant="default">
                      Owner-Supplied (OSM)
                    </Badge>
                  ) : (
                    <Badge variant="outline">Standard Supplier</Badge>
                  )}
                </TableCell>
                <TableCell className="text-xs text-neutral-600">
                  {new Date(mfg.updated_at).toLocaleDateString()}
                </TableCell>
                {isAdmin && (
                  <TableCell className="text-right">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => openEditDialog(mfg)}
                    >
                      <Pencil className="h-3.5 w-3.5" />
                      <span>Edit</span>
                    </Button>
                  </TableCell>
                )}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {editingMfg ? 'Edit Supplier' : 'Add Supplier'}
            </DialogTitle>
            <DialogDescription>
              Mark owner-supplied suppliers (such as MM) when the materials are already owned by the company.
            </DialogDescription>
          </DialogHeader>

          {formError && (
            <div
              role="alert"
              className="border border-neutral-950 bg-neutral-100 p-3 text-xs text-neutral-950"
            >
              {formError}
            </div>
          )}

          <form
            onSubmit={form.handleSubmit((vals) => saveMutation.mutate(vals))}
            className="space-y-4"
            noValidate
          >
            <div className="space-y-1.5">
              <Label htmlFor="mfg-name">Supplier Name</Label>
              <Input
                id="mfg-name"
                placeholder="e.g. NOVAS"
                {...form.register('name')}
              />
              {form.formState.errors.name && (
                <p className="text-xs font-medium text-neutral-900">
                  {form.formState.errors.name.message}
                </p>
              )}
            </div>

            <div className="flex items-center gap-2.5 pt-1">
              <input
                id="mfg-owner-supplied"
                type="checkbox"
                className="h-4 w-4 accent-neutral-950 rounded-xs border-neutral-400"
                {...form.register('is_owner_supplied')}
              />
              <Label htmlFor="mfg-owner-supplied" className="cursor-pointer">
                Owner-Supplied Material (Company Owned)
              </Label>
            </div>

            <DialogFooter className="pt-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => setDialogOpen(false)}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={saveMutation.isPending}>
                {saveMutation.isPending ? 'Saving...' : 'Save Supplier'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  )
}
