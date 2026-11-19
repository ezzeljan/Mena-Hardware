import { useMemo, useState } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type SortingState,
} from '@tanstack/react-table'
import {
  AlertCircle,
  ArrowUpDown,
  Boxes,
  History,
  Pencil,
  Plus,
  PowerOff,
  RotateCcw,
  Search,
} from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { fetchAllRows } from '@/lib/fetchAll'
import { useAuth } from '@/features/auth/AuthContext'
import {
  parseNullablePriceInput,
  partFormSchema,
  type PartFormValues,
} from '@/lib/schemas'
import { formatCurrency } from '@/lib/utils'
import type { Manufacturer, Part, PartPriceHistory } from '@/types/database'
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

export function PartsLibraryPage() {
  const { isAdmin } = useAuth()
  const queryClient = useQueryClient()

  const [searchQuery, setSearchQuery] = useState('')
  const [manufacturerFilter, setManufacturerFilter] = useState<string>('ALL')
  const [showInactive, setShowInactive] = useState<boolean>(false)
  const [sorting, setSorting] = useState<SortingState>([
    { id: 'sku', desc: false },
  ])

  const [dialogOpen, setDialogOpen] = useState(false)
  const [editingPart, setEditingPart] = useState<Part | null>(null)
  const [historyPart, setHistoryPart] = useState<Part | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  const form = useForm<PartFormValues>({
    resolver: zodResolver(partFormSchema),
    defaultValues: {
      sku: '',
      manufacturer_id: '',
      description: '',
      unit_cost: '',
      active: true,
    },
  })

  const manufacturersQuery = useQuery({
    queryKey: ['manufacturers'],
    queryFn: async (): Promise<Manufacturer[]> => {
      const { data, error } = await supabase
        .from('manufacturers')
        .select('id, name, is_owner_supplied, created_at, updated_at')
        .order('name', { ascending: true })
      if (error) throw error
      return (data ?? []) as Manufacturer[]
    },
  })

  const partsQuery = useQuery({
    queryKey: ['parts'],
    queryFn: (): Promise<Part[]> =>
      fetchAllRows<Part>((from, to) =>
        supabase
          .from('parts')
          .select(
            'id, sku, manufacturer_id, description, unit_cost, active, created_at, updated_at, manufacturers(id, name, is_owner_supplied)',
          )
          .order('sku', { ascending: true })
          .order('id', { ascending: true })
          .range(from, to),
      ),
  })

  const priceHistoryQuery = useQuery({
    queryKey: ['part_price_history', historyPart?.id],
    enabled: !!historyPart,
    queryFn: async (): Promise<PartPriceHistory[]> => {
      if (!historyPart) return []
      const { data, error } = await supabase
        .from('part_price_history')
        .select('id, part_id, unit_cost, effective_from, changed_by')
        .eq('part_id', historyPart.id)
        .order('effective_from', { ascending: false })
      if (error) throw error
      return (data ?? []) as PartPriceHistory[]
    },
  })

  const savePartMutation = useMutation({
    mutationFn: async (values: PartFormValues) => {
      const parsed = partFormSchema.parse(values)
      const nullableCost = parseNullablePriceInput(parsed.unit_cost)

      if (editingPart) {
        const { error } = await supabase
          .from('parts')
          .update({
            sku: parsed.sku.trim(),
            manufacturer_id: parsed.manufacturer_id,
            description: parsed.description.trim(),
            unit_cost: nullableCost,
            active: parsed.active,
          })
          .eq('id', editingPart.id)
        if (error) throw error
      } else {
        const { error } = await supabase.from('parts').insert({
          sku: parsed.sku.trim(),
          manufacturer_id: parsed.manufacturer_id,
          description: parsed.description.trim(),
          unit_cost: nullableCost,
          active: parsed.active,
        })
        if (error) throw error
      }
    },
    onSuccess: async () => {
      setDialogOpen(false)
      setEditingPart(null)
      setFormError(null)
      await queryClient.invalidateQueries({ queryKey: ['parts'] })
    },
    onError: (err: Error) => {
      setFormError(err.message)
    },
  })

  const toggleActiveMutation = useMutation({
    mutationFn: async (part: Part) => {
      const { error } = await supabase
        .from('parts')
        .update({ active: !part.active })
        .eq('id', part.id)
      if (error) throw error
    },
    onSuccess: async () => {
      setActionError(null)
      await queryClient.invalidateQueries({ queryKey: ['parts'] })
    },
    onError: (err: Error) => {
      setActionError(err.message)
    },
  })

  const filteredParts = useMemo(() => {
    const all = partsQuery.data ?? []
    const q = searchQuery.trim().toLowerCase()

    return all.filter((part) => {
      if (!showInactive && !part.active) return false
      if (
        manufacturerFilter !== 'ALL' &&
        part.manufacturer_id !== manufacturerFilter
      ) {
        return false
      }
      if (!q) return true
      const mfgName = part.manufacturers?.name?.toLowerCase() ?? ''
      return (
        part.sku.toLowerCase().includes(q) ||
        part.description.toLowerCase().includes(q) ||
        mfgName.includes(q)
      )
    })
  }, [partsQuery.data, searchQuery, manufacturerFilter, showInactive])

  const columns = useMemo<ColumnDef<Part>[]>(
    () => [
      {
        accessorKey: 'sku',
        header: ({ column }) => (
          <button
            type="button"
            className="inline-flex items-center gap-1 font-semibold uppercase tracking-wider hover:text-neutral-950 cursor-pointer"
            onClick={() => column.toggleSorting(column.getIsSorted() === 'asc')}
          >
            <span>SKU</span>
            <ArrowUpDown className="h-3 w-3" />
          </button>
        ),
        cell: ({ row }) => (
          <span className="font-mono text-xs font-semibold text-neutral-950">
            {row.original.sku}
          </span>
        ),
      },
      {
        id: 'manufacturer',
        accessorFn: (row) => row.manufacturers?.name ?? '',
        header: ({ column }) => (
          <button
            type="button"
            className="inline-flex items-center gap-1 font-semibold uppercase tracking-wider hover:text-neutral-950 cursor-pointer"
            onClick={() => column.toggleSorting(column.getIsSorted() === 'asc')}
          >
            <span>Manufacturer</span>
            <ArrowUpDown className="h-3 w-3" />
          </button>
        ),
        cell: ({ row }) => {
          const mfg = row.original.manufacturers
          return (
            <div className="flex items-center gap-1.5">
              <Badge variant={mfg?.is_owner_supplied ? 'default' : 'outline'}>
                {mfg?.name ?? '—'}
              </Badge>
              {mfg?.is_owner_supplied && (
                <span className="text-[10px] font-medium uppercase tracking-wider text-neutral-500">
                  OSM
                </span>
              )}
            </div>
          )
        },
      },
      {
        accessorKey: 'description',
        header: ({ column }) => (
          <button
            type="button"
            className="inline-flex items-center gap-1 font-semibold uppercase tracking-wider hover:text-neutral-950 cursor-pointer"
            onClick={() => column.toggleSorting(column.getIsSorted() === 'asc')}
          >
            <span>Description</span>
            <ArrowUpDown className="h-3 w-3" />
          </button>
        ),
        cell: ({ row }) => (
          <span className="text-sm text-neutral-900">
            {row.original.description}
          </span>
        ),
      },
      {
        accessorKey: 'unit_cost',
        header: ({ column }) => (
          <button
            type="button"
            className="inline-flex items-center gap-1 font-semibold uppercase tracking-wider hover:text-neutral-950 cursor-pointer"
            onClick={() => column.toggleSorting(column.getIsSorted() === 'asc')}
          >
            <span>Unit Cost</span>
            <ArrowUpDown className="h-3 w-3" />
          </button>
        ),
        cell: ({ row }) => {
          const cost = row.original.unit_cost
          if (cost === null || cost === undefined) {
            return (
              <Badge
                variant="dashed"
                className="gap-1 font-mono text-[11px]"
                data-testid="no-unit-price-marker"
              >
                <AlertCircle className="h-3 w-3" />
                <span>No unit price</span>
              </Badge>
            )
          }
          return (
            <span className="font-mono text-sm font-medium text-neutral-950">
              {formatCurrency(Number(cost))}
            </span>
          )
        },
      },
      {
        accessorKey: 'active',
        header: 'Status',
        cell: ({ row }) =>
          row.original.active ? (
            <Badge variant="secondary">Active</Badge>
          ) : (
            <Badge variant="outline" className="text-neutral-400">
              Inactive
            </Badge>
          ),
      },
      {
        id: 'actions',
        header: () => <div className="text-right">Actions</div>,
        cell: ({ row }) => {
          const part = row.original
          return (
            <div className="flex items-center justify-end gap-1.5">
              <Button
                variant="ghost"
                size="sm"
                title="View price history"
                onClick={() => setHistoryPart(part)}
              >
                <History className="h-3.5 w-3.5" />
              </Button>
              {isAdmin && (
                <>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setEditingPart(part)
                      setFormError(null)
                      form.reset({
                        sku: part.sku,
                        manufacturer_id: part.manufacturer_id,
                        description: part.description,
                        unit_cost:
                          part.unit_cost === null || part.unit_cost === undefined
                            ? ''
                            : String(part.unit_cost),
                        active: part.active,
                      })
                      setDialogOpen(true)
                    }}
                  >
                    <Pencil className="h-3.5 w-3.5" />
                    <span>Edit</span>
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    title={part.active ? 'Deactivate part' : 'Reactivate part'}
                    disabled={toggleActiveMutation.isPending}
                    onClick={() => {
                      if (
                        part.active &&
                        !window.confirm(`Deactivate part ${part.sku}?`)
                      ) {
                        return
                      }
                      toggleActiveMutation.mutate(part)
                    }}
                  >
                    {part.active ? (
                      <>
                        <PowerOff className="h-3.5 w-3.5" />
                        <span>Deactivate</span>
                      </>
                    ) : (
                      <>
                        <RotateCcw className="h-3.5 w-3.5" />
                        <span>Activate</span>
                      </>
                    )}
                  </Button>
                </>
              )}
            </div>
          )
        },
      },
    ],
    [isAdmin, form, toggleActiveMutation],
  )

  const table = useReactTable({
    data: filteredParts,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    initialState: {
      pagination: {
        pageSize: 15,
      },
    },
  })

  function openAddPartDialog() {
    setEditingPart(null)
    setFormError(null)
    const defaultMfgId = manufacturersQuery.data?.[0]?.id ?? ''
    form.reset({
      sku: '',
      manufacturer_id: defaultMfgId,
      description: '',
      unit_cost: '',
      active: true,
    })
    setDialogOpen(true)
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-neutral-200 pb-4">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-neutral-950 flex items-center gap-2">
            <Boxes className="h-5 w-5" />
            <span>Parts Library</span>
          </h1>
          <p className="text-sm text-neutral-600 mt-0.5">
            Master catalog of door hardware items, SKUs, and unit costs. Parts with blank cost are marked &ldquo;No unit price&rdquo;.
          </p>
        </div>

        {isAdmin && (
          <Button onClick={openAddPartDialog} size="sm">
            <Plus className="h-4 w-4" />
            <span>Add Part</span>
          </Button>
        )}
      </div>

      {/* Filters Bar */}
      <div className="flex flex-wrap items-center justify-between gap-3 bg-neutral-50 p-3 border border-neutral-200 rounded-md">
        <div className="flex flex-wrap items-center gap-3 flex-1 min-w-[260px]">
          <div className="relative flex-1 max-w-sm">
            <Search className="h-4 w-4 absolute left-3 top-2.5 text-neutral-400" />
            <Input
              aria-label="Search parts by SKU or description"
              placeholder="Search SKU or description..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-9 bg-white"
            />
          </div>

          <select
            aria-label="Filter by manufacturer"
            value={manufacturerFilter}
            onChange={(e) => setManufacturerFilter(e.target.value)}
            className="h-9 rounded-md border border-neutral-300 bg-white px-3 text-sm text-neutral-950 focus:outline-none focus:ring-2 focus:ring-neutral-950"
          >
            <option value="ALL">All Manufacturers</option>
            {manufacturersQuery.data?.map((mfg) => (
              <option key={mfg.id} value={mfg.id}>
                {mfg.name} {mfg.is_owner_supplied ? '(OSM)' : ''}
              </option>
            ))}
          </select>

          <label className="inline-flex items-center gap-2 text-xs font-medium text-neutral-700 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={showInactive}
              onChange={(e) => setShowInactive(e.target.checked)}
              className="h-4 w-4 accent-neutral-950"
            />
            <span>Show inactive parts</span>
          </label>
        </div>

        <div className="text-xs font-medium text-neutral-600">
          Showing {filteredParts.length} part{filteredParts.length === 1 ? '' : 's'}
        </div>
      </div>

      {actionError && (
        <div
          role="alert"
          className="border border-neutral-950 bg-neutral-100 p-3 text-xs font-medium text-neutral-950"
        >
          Action failed: {actionError}
        </div>
      )}

      {/* Table State */}
      {partsQuery.isLoading ? (
        <div className="border border-neutral-200 p-10 text-center text-sm text-neutral-600">
          Loading parts library...
        </div>
      ) : partsQuery.isError ? (
        <div
          role="alert"
          className="border border-neutral-950 bg-neutral-50 p-6 text-sm text-neutral-950"
        >
          Error loading parts library: {(partsQuery.error as Error).message}
        </div>
      ) : filteredParts.length === 0 ? (
        <div className="border border-neutral-200 p-10 text-center text-sm text-neutral-600">
          No parts match your current filters.
        </div>
      ) : (
        <>
          <Table>
            <TableHeader>
              {table.getHeaderGroups().map((headerGroup) => (
                <TableRow key={headerGroup.id}>
                  {headerGroup.headers.map((header) => (
                    <TableHead key={header.id}>
                      {header.isPlaceholder
                        ? null
                        : flexRender(
                            header.column.columnDef.header,
                            header.getContext(),
                          )}
                    </TableHead>
                  ))}
                </TableRow>
              ))}
            </TableHeader>
            <TableBody>
              {table.getRowModel().rows.map((row) => (
                <TableRow
                  key={row.id}
                  className={!row.original.active ? 'opacity-60' : undefined}
                >
                  {row.getVisibleCells().map((cell) => (
                    <TableCell key={cell.id}>
                      {flexRender(
                        cell.column.columnDef.cell,
                        cell.getContext(),
                      )}
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>

          {/* Pagination */}
          <div className="flex items-center justify-between border-t border-neutral-200 pt-3 text-xs text-neutral-600">
            <div>
              Page {table.getState().pagination.pageIndex + 1} of{' '}
              {Math.max(1, table.getPageCount())}
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => table.previousPage()}
                disabled={!table.getCanPreviousPage()}
              >
                Previous
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => table.nextPage()}
                disabled={!table.getCanNextPage()}
              >
                Next
              </Button>
            </div>
          </div>
        </>
      )}

      {/* Add / Edit Part Modal */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {editingPart ? `Edit Part (${editingPart.sku})` : 'Add New Part'}
            </DialogTitle>
            <DialogDescription>
              Leave Unit Cost blank when a part intentionally has no unit price (stores NULL, never 0).
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
            onSubmit={form.handleSubmit((vals) => savePartMutation.mutate(vals))}
            className="space-y-4"
            noValidate
          >
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label htmlFor="part-sku">Part Number (SKU)</Label>
                <Input
                  id="part-sku"
                  placeholder="e.g. 6125SSS"
                  {...form.register('sku')}
                />
                {form.formState.errors.sku && (
                  <p className="text-xs font-medium text-neutral-900">
                    {form.formState.errors.sku.message}
                  </p>
                )}
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="part-manufacturer">Manufacturer</Label>
                <select
                  id="part-manufacturer"
                  {...form.register('manufacturer_id')}
                  className="flex h-9 w-full rounded-md border border-neutral-300 bg-white px-3 py-1 text-sm text-neutral-950 focus:outline-none focus:ring-2 focus:ring-neutral-950"
                >
                  <option value="">Select manufacturer...</option>
                  {manufacturersQuery.data?.map((mfg) => (
                    <option key={mfg.id} value={mfg.id}>
                      {mfg.name} {mfg.is_owner_supplied ? '(OSM)' : ''}
                    </option>
                  ))}
                </select>
                {form.formState.errors.manufacturer_id && (
                  <p className="text-xs font-medium text-neutral-900">
                    {form.formState.errors.manufacturer_id.message}
                  </p>
                )}
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="part-description">Hardware Description</Label>
              <Input
                id="part-description"
                placeholder="e.g. NOVAS 6000 SERIES VESTIBULE LOCK 60MM BACKSET SSS"
                {...form.register('description')}
              />
              {form.formState.errors.description && (
                <p className="text-xs font-medium text-neutral-900">
                  {form.formState.errors.description.message}
                </p>
              )}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="part-unit-cost">
                Unit Cost (Leave blank for &ldquo;No unit price&rdquo;)
              </Label>
              <Input
                id="part-unit-cost"
                type="number"
                step="any"
                min="0"
                placeholder="Blank = No unit price (NULL)"
                {...form.register('unit_cost')}
              />
              {form.formState.errors.unit_cost && (
                <p className="text-xs font-medium text-neutral-900">
                  {form.formState.errors.unit_cost.message}
                </p>
              )}
            </div>

            <div className="flex items-center gap-2 pt-1">
              <input
                id="part-active"
                type="checkbox"
                className="h-4 w-4 accent-neutral-950"
                {...form.register('active')}
              />
              <Label htmlFor="part-active" className="cursor-pointer">
                Part is Active
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
              <Button type="submit" disabled={savePartMutation.isPending}>
                {savePartMutation.isPending ? 'Saving...' : 'Save Part'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Price History Modal */}
      <Dialog
        open={!!historyPart}
        onOpenChange={(open) => {
          if (!open) setHistoryPart(null)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              Price History — {historyPart?.sku}
            </DialogTitle>
            <DialogDescription>
              {historyPart?.description}
            </DialogDescription>
          </DialogHeader>

          {priceHistoryQuery.isLoading ? (
            <div className="py-6 text-center text-sm text-neutral-600">
              Loading price history...
            </div>
          ) : (priceHistoryQuery.data?.length ?? 0) === 0 ? (
            <div className="py-6 text-center text-sm text-neutral-600 border border-neutral-200 bg-neutral-50">
              No unit cost changes recorded yet.
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Effective From</TableHead>
                  <TableHead>New Unit Cost</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {priceHistoryQuery.data?.map((entry) => (
                  <TableRow key={entry.id}>
                    <TableCell className="text-xs text-neutral-700">
                      {new Date(entry.effective_from).toLocaleString()}
                    </TableCell>
                    <TableCell className="font-mono text-xs font-medium">
                      {entry.unit_cost === null
                        ? 'No unit price (NULL)'
                        : formatCurrency(Number(entry.unit_cost))}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => setHistoryPart(null)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
