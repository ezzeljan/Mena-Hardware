import { useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AlertCircle,
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  Pencil,
  Plus,
  Trash2,
} from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { fetchAllRows } from '@/lib/fetchAll'
import { useAuth } from '@/features/auth/AuthContext'
import {
  parseNullablePriceInput,
  standardSetLineSchema,
  standardSetSchema,
  type StandardSetFormValues,
  type StandardSetLineFormValues,
} from '@/lib/schemas'
import { formatCurrency } from '@/lib/utils'
import type { Part, StandardSet, StandardSetLine } from '@/types/database'
import { SkuAutocomplete } from './SkuAutocomplete'
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

export function StandardSetDetailPage() {
  const { id } = useParams<{ id: string }>()
  const { isAdmin } = useAuth()
  const queryClient = useQueryClient()

  const [headerDialogOpen, setHeaderDialogOpen] = useState(false)
  const [lineDialogOpen, setLineDialogOpen] = useState(false)
  const [editingLine, setEditingLine] = useState<StandardSetLine | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  const headerForm = useForm<StandardSetFormValues>({
    resolver: zodResolver(standardSetSchema),
    defaultValues: {
      room_name: '',
      classification: '',
      leaf: 'SINGLE',
      door_size: '',
      active: true,
    },
  })

  const lineForm = useForm<StandardSetLineFormValues>({
    resolver: zodResolver(standardSetLineSchema),
    defaultValues: {
      sku: '',
      description: '',
      qty: '1',
      unit_price: '',
    },
  })

  const setQuery = useQuery({
    queryKey: ['standard_set', id],
    enabled: !!id,
    queryFn: async (): Promise<StandardSet> => {
      const { data, error } = await supabase
        .from('standard_sets')
        .select(
          'id, room_name, classification, leaf, door_size, active, created_at, updated_at, standard_set_lines(id, set_id, position, sku, description, qty, unit_price, created_at, updated_at)',
        )
        .eq('id', id!)
        .single()
      if (error) throw error
      return data as unknown as StandardSet
    },
  })

  const partsQuery = useQuery({
    queryKey: ['parts', 'autocomplete'],
    queryFn: (): Promise<Part[]> =>
      fetchAllRows<Part>((from, to) =>
        supabase
          .from('parts')
          .select(
            'id, sku, supplier_id, description, unit_cost, active, created_at, updated_at',
          )
          .order('sku', { ascending: true })
          .order('id', { ascending: true })
          .range(from, to),
      ),
  })

  const sortedLines = useMemo(() => {
    const raw = setQuery.data?.standard_set_lines ?? []
    return [...raw].sort((a, b) => a.position - b.position)
  }, [setQuery.data])

  const updateHeaderMutation = useMutation({
    mutationFn: async (values: StandardSetFormValues) => {
      if (!id) return
      const parsed = standardSetSchema.parse(values)
      const { error } = await supabase
        .from('standard_sets')
        .update({
          room_name: parsed.room_name.trim(),
          classification: parsed.classification.trim(),
          leaf: parsed.leaf,
          door_size: parsed.door_size.trim(),
          active: parsed.active,
        })
        .eq('id', id)
      if (error) throw error
    },
    onSuccess: async () => {
      setHeaderDialogOpen(false)
      setActionError(null)
      await queryClient.invalidateQueries({ queryKey: ['standard_set', id] })
      await queryClient.invalidateQueries({ queryKey: ['standard_sets'] })
    },
    onError: (err: Error) => {
      setActionError(err.message)
    },
  })

  const saveLineMutation = useMutation({
    mutationFn: async (values: StandardSetLineFormValues) => {
      if (!id) return
      const parsed = standardSetLineSchema.parse(values)
      const qtyNum = Number(parsed.qty.trim())
      const nullablePrice = parseNullablePriceInput(parsed.unit_price)

      if (editingLine) {
        const { error } = await supabase
          .from('standard_set_lines')
          .update({
            sku: parsed.sku.trim(),
            description: parsed.description.trim(),
            qty: qtyNum,
            unit_price: nullablePrice,
          })
          .eq('id', editingLine.id)
        if (error) throw error
      } else {
        const nextPosition =
          sortedLines.length > 0
            ? Math.max(...sortedLines.map((l) => l.position)) + 1
            : 1

        const { error } = await supabase.from('standard_set_lines').insert({
          set_id: id,
          position: nextPosition,
          sku: parsed.sku.trim(),
          description: parsed.description.trim(),
          qty: qtyNum,
          unit_price: nullablePrice,
        })
        if (error) throw error
      }
    },
    onSuccess: async () => {
      setLineDialogOpen(false)
      setEditingLine(null)
      setActionError(null)
      await queryClient.invalidateQueries({ queryKey: ['standard_set', id] })
      await queryClient.invalidateQueries({ queryKey: ['standard_sets'] })
    },
    onError: (err: Error) => {
      setActionError(err.message)
    },
  })

  const deleteLineMutation = useMutation({
    mutationFn: async (lineId: string) => {
      const { error } = await supabase
        .from('standard_set_lines')
        .delete()
        .eq('id', lineId)
      if (error) throw error
    },
    onSuccess: async () => {
      setActionError(null)
      await queryClient.invalidateQueries({ queryKey: ['standard_set', id] })
      await queryClient.invalidateQueries({ queryKey: ['standard_sets'] })
    },
    onError: (err: Error) => {
      setActionError(err.message)
    },
  })

  const reorderLineMutation = useMutation({
    mutationFn: async ({
      lineA,
      lineB,
    }: {
      lineA: StandardSetLine
      lineB: StandardSetLine
    }) => {
      const { error } = await supabase.rpc('swap_standard_set_lines', {
        p_line_a: lineA.id,
        p_line_b: lineB.id,
      })
      if (error) throw error
    },
    onSuccess: async () => {
      setActionError(null)
      await queryClient.invalidateQueries({ queryKey: ['standard_set', id] })
    },
    onError: (err: Error) => {
      setActionError(err.message)
    },
  })

  if (setQuery.isLoading) {
    return (
      <div className="border border-neutral-200 p-10 text-center text-sm text-neutral-600">
        Loading standard set...
      </div>
    )
  }

  if (setQuery.isError || !setQuery.data) {
    return (
      <div className="space-y-4">
        <Button variant="outline" size="sm" asChild>
          <Link to="/standard-sets">
            <ArrowLeft className="h-3.5 w-3.5" />
            <span>Back to Standard Sets</span>
          </Link>
        </Button>
        <div
          role="alert"
          className="border border-neutral-950 bg-neutral-50 p-6 text-sm text-neutral-950"
        >
          Standard set not found or failed to load.
        </div>
      </div>
    )
  }

  const set = setQuery.data
  const unpricedCount = sortedLines.filter(
    (line) => line.unit_price === null || line.unit_price === undefined,
  ).length
  const totalSetCost = sortedLines.reduce((acc, line) => {
    if (line.unit_price === null || line.unit_price === undefined) return acc
    return acc + Number(line.qty) * Number(line.unit_price)
  }, 0)

  const currentSkuValue = lineForm.watch('sku')

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <Button variant="outline" size="sm" asChild>
          <Link to="/standard-sets">
            <ArrowLeft className="h-3.5 w-3.5" />
            <span>Back to Standard Sets</span>
          </Link>
        </Button>

        {isAdmin && (
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setActionError(null)
                headerForm.reset({
                  room_name: set.room_name,
                  classification: set.classification,
                  leaf: set.leaf,
                  door_size: set.door_size,
                  active: set.active,
                })
                setHeaderDialogOpen(true)
              }}
            >
              <Pencil className="h-3.5 w-3.5" />
              <span>Edit Set Info</span>
            </Button>

            <Button
              size="sm"
              onClick={() => {
                setEditingLine(null)
                setActionError(null)
                lineForm.reset({
                  sku: '',
                  description: '',
                  qty: '1',
                  unit_price: '',
                })
                setLineDialogOpen(true)
              }}
            >
              <Plus className="h-4 w-4" />
              <span>Add Part Line</span>
            </Button>
          </div>
        )}
      </div>

      {/* Set Header Summary Card */}
      <div className="border border-neutral-300 bg-neutral-50 p-5 rounded-md flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2.5">
            <h1 className="text-xl font-bold tracking-tight text-neutral-950">
              {set.room_name}
            </h1>
            <Badge
              variant={
                set.classification.includes('FIRE') ? 'default' : 'secondary'
              }
            >
              {set.classification.trim() || 'UNSPECIFIED'}
            </Badge>
            {set.leaf && <Badge variant="outline">{set.leaf}</Badge>}
            {!set.active && (
              <Badge variant="outline" className="text-neutral-400">
                Inactive
              </Badge>
            )}
          </div>
          <div className="text-xs text-neutral-600 mt-1.5 font-mono">
            Door Size: {set.door_size || '—'} &bull; {sortedLines.length} Line Item
            {sortedLines.length === 1 ? '' : 's'}
          </div>
        </div>

        <div className="text-left sm:text-right border-t sm:border-t-0 pt-3 sm:pt-0 border-neutral-200">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-neutral-500">
            Total Set Cost
          </div>
          <div className="text-xl font-bold font-mono text-neutral-950">
            {formatCurrency(totalSetCost)}
          </div>
          {unpricedCount > 0 && (
            <div className="text-[11px] font-medium text-neutral-600 mt-0.5">
              + {unpricedCount} unpriced item{unpricedCount === 1 ? '' : 's'}
            </div>
          )}
        </div>
      </div>

      {actionError && (
        <div
          role="alert"
          className="border border-neutral-950 bg-neutral-100 p-3 text-xs text-neutral-950"
        >
          {actionError}
        </div>
      )}

      {/* Set Lines Table */}
      {sortedLines.length === 0 ? (
        <div className="border border-neutral-200 p-10 text-center text-sm text-neutral-600">
          This standard set has no hardware lines yet.
        </div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-16">#</TableHead>
              <TableHead>Part Number (SKU)</TableHead>
              <TableHead>Hardware Description</TableHead>
              <TableHead className="text-right">Qty</TableHead>
              <TableHead className="text-right">Unit Price</TableHead>
              <TableHead className="text-right">Line Total</TableHead>
              {isAdmin && <TableHead className="text-right">Actions</TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {sortedLines.map((line, index) => {
              const prevLine = index > 0 ? sortedLines[index - 1] : null
              const nextLine =
                index < sortedLines.length - 1 ? sortedLines[index + 1] : null
              const hasUnitPrice =
                line.unit_price !== null && line.unit_price !== undefined
              const lineTotal = hasUnitPrice
                ? Number(line.qty) * Number(line.unit_price)
                : null

              return (
                <TableRow key={line.id}>
                  <TableCell className="font-mono text-xs text-neutral-500">
                    {index + 1}
                  </TableCell>
                  <TableCell className="font-mono text-xs font-semibold text-neutral-950">
                    {line.sku}
                  </TableCell>
                  <TableCell className="text-sm text-neutral-900">
                    {line.description}
                  </TableCell>
                  <TableCell className="text-right font-mono text-sm">
                    {Number(line.qty)}
                  </TableCell>
                  <TableCell className="text-right font-mono text-sm">
                    {hasUnitPrice ? (
                      formatCurrency(Number(line.unit_price))
                    ) : (
                      <Badge
                        variant="dashed"
                        className="gap-1 font-mono text-[11px]"
                      >
                        <AlertCircle className="h-3 w-3" />
                        <span>Blank (NULL)</span>
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-right font-mono text-sm font-medium">
                    {lineTotal === null ? '—' : formatCurrency(lineTotal)}
                  </TableCell>
                  {isAdmin && (
                    <TableCell className="text-right">
                      <div className="inline-flex items-center justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="icon"
                          title="Move line up"
                          disabled={!prevLine || reorderLineMutation.isPending}
                          onClick={() => {
                            if (prevLine) {
                              reorderLineMutation.mutate({
                                lineA: line,
                                lineB: prevLine,
                              })
                            }
                          }}
                        >
                          <ArrowUp className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          title="Move line down"
                          disabled={!nextLine || reorderLineMutation.isPending}
                          onClick={() => {
                            if (nextLine) {
                              reorderLineMutation.mutate({
                                lineA: line,
                                lineB: nextLine,
                              })
                            }
                          }}
                        >
                          <ArrowDown className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => {
                            setEditingLine(line)
                            setActionError(null)
                            lineForm.reset({
                              sku: line.sku,
                              description: line.description,
                              qty: String(line.qty),
                              unit_price:
                                line.unit_price === null ||
                                line.unit_price === undefined
                                  ? ''
                                  : String(line.unit_price),
                            })
                            setLineDialogOpen(true)
                          }}
                        >
                          <Pencil className="h-3.5 w-3.5" />
                          <span>Edit</span>
                        </Button>
                        <Button
                          variant="outline"
                          size="icon"
                          title="Delete line"
                          disabled={deleteLineMutation.isPending}
                          onClick={() => deleteLineMutation.mutate(line.id)}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </TableCell>
                  )}
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      )}

      {/* Edit Set Header Modal */}
      <Dialog open={headerDialogOpen} onOpenChange={setHeaderDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit Standard Set Details</DialogTitle>
            <DialogDescription>
              Update the room name, fire classification, leaf type, door size, or status.
            </DialogDescription>
          </DialogHeader>

          <form
            onSubmit={headerForm.handleSubmit((vals) =>
              updateHeaderMutation.mutate(vals),
            )}
            className="space-y-4"
            noValidate
          >
            <div className="space-y-1.5">
              <Label htmlFor="edit-room-name">Room Name</Label>
              <Input id="edit-room-name" {...headerForm.register('room_name')} />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label htmlFor="edit-classification">Classification</Label>
                <Input
                  id="edit-classification"
                  {...headerForm.register('classification')}
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="edit-leaf">Leaf</Label>
                <select
                  id="edit-leaf"
                  {...headerForm.register('leaf')}
                  className="flex h-9 w-full rounded-md border border-neutral-300 bg-white px-3 py-1 text-sm text-neutral-950 focus:outline-none focus:ring-2 focus:ring-neutral-950"
                >
                  <option value="SINGLE">SINGLE</option>
                  <option value="DOUBLE">DOUBLE</option>
                  <option value="CAVITY SINGLE">CAVITY SINGLE</option>
                  <option value="CAVITY DOUBLE">CAVITY DOUBLE</option>
                  <option value="TRIPLE">TRIPLE</option>
                  <option value="">Empty / Pivot</option>
                </select>
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="edit-door-size">Door Size</Label>
              <Input id="edit-door-size" {...headerForm.register('door_size')} />
            </div>

            <div className="flex items-center gap-2 pt-1">
              <input
                id="edit-set-active"
                type="checkbox"
                className="h-4 w-4 accent-neutral-950"
                {...headerForm.register('active')}
              />
              <Label htmlFor="edit-set-active" className="cursor-pointer">
                Standard Set is Active
              </Label>
            </div>

            <DialogFooter className="pt-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => setHeaderDialogOpen(false)}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={updateHeaderMutation.isPending}>
                {updateHeaderMutation.isPending ? 'Saving...' : 'Save Changes'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Add / Edit Line Modal with SKU Autocomplete */}
      <Dialog open={lineDialogOpen} onOpenChange={setLineDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {editingLine ? 'Edit Set Line' : 'Add Hardware Line to Set'}
            </DialogTitle>
            <DialogDescription>
              Search or autocomplete from the Parts Library. Leave Unit Price blank to keep it NULL (never defaults to 0).
            </DialogDescription>
          </DialogHeader>

          <form
            onSubmit={lineForm.handleSubmit((vals) =>
              saveLineMutation.mutate(vals),
            )}
            className="space-y-4"
            noValidate
          >
            <div className="space-y-1.5">
              <Label htmlFor="line-sku">Part Number (SKU) — Autocomplete</Label>
              <SkuAutocomplete
                id="line-sku"
                value={currentSkuValue}
                parts={partsQuery.data ?? []}
                onChange={(sku) =>
                  lineForm.setValue('sku', sku, { shouldValidate: true })
                }
                onSelectPart={(part) => {
                  lineForm.setValue('sku', part.sku, { shouldValidate: true })
                  lineForm.setValue('description', part.description, {
                    shouldValidate: true,
                  })
                  lineForm.setValue(
                    'unit_price',
                    part.unit_cost === null || part.unit_cost === undefined
                      ? ''
                      : String(part.unit_cost),
                    { shouldValidate: true },
                  )
                }}
              />
              {lineForm.formState.errors.sku && (
                <p className="text-xs font-medium text-neutral-900">
                  {lineForm.formState.errors.sku.message}
                </p>
              )}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="line-description">Hardware Description</Label>
              <Input
                id="line-description"
                placeholder="Hardware description"
                {...lineForm.register('description')}
              />
              {lineForm.formState.errors.description && (
                <p className="text-xs font-medium text-neutral-900">
                  {lineForm.formState.errors.description.message}
                </p>
              )}
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label htmlFor="line-qty">Quantity</Label>
                <Input
                  id="line-qty"
                  type="number"
                  step="any"
                  min="0.01"
                  {...lineForm.register('qty')}
                />
                {lineForm.formState.errors.qty && (
                  <p className="text-xs font-medium text-neutral-900">
                    {lineForm.formState.errors.qty.message}
                  </p>
                )}
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="line-unit-price">
                  Unit Price (Blank = NULL)
                </Label>
                <Input
                  id="line-unit-price"
                  type="number"
                  step="any"
                  min="0"
                  placeholder="Blank = NULL"
                  {...lineForm.register('unit_price')}
                />
                {lineForm.formState.errors.unit_price && (
                  <p className="text-xs font-medium text-neutral-900">
                    {lineForm.formState.errors.unit_price.message}
                  </p>
                )}
              </div>
            </div>

            <DialogFooter className="pt-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => setLineDialogOpen(false)}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={saveLineMutation.isPending}>
                {saveLineMutation.isPending ? 'Saving...' : 'Save Line'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  )
}
