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
  Folder,
  FolderOpen,
  FolderPlus,
  History,
  Pencil,
  Plus,
  PowerOff,
  RotateCcw,
  Search,
  Trash2,
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
import type { Supplier, Part, PartFolder, PartPriceHistory } from '@/types/database'
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
  const [supplierFilter, setSupplierFilter] = useState<string>('ALL')
  // 'ALL', 'UNFILED' or a folder id.
  const [folderFilter, setFolderFilter] = useState<string>('ALL')
  const [folderDialog, setFolderDialog] = useState<
    { kind: 'add' } | { kind: 'rename'; folder: PartFolder } | { kind: 'delete'; folder: PartFolder } | null
  >(null)
  const [folderName, setFolderName] = useState('')
  const [folderError, setFolderError] = useState<string | null>(null)
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
      supplier_id: '',
      description: '',
      unit_cost: '',
      active: true,
      folder_id: '',
      legend: '',
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

  const foldersQuery = useQuery({
    queryKey: ['part_folders'],
    queryFn: async (): Promise<PartFolder[]> => {
      const { data, error } = await supabase
        .from('part_folders')
        .select('id, name, position, created_at, updated_at')
        .order('position', { ascending: true })
        .order('name', { ascending: true })
      if (error) throw error
      return (data ?? []) as PartFolder[]
    },
  })
  const folders = useMemo(() => foldersQuery.data ?? [], [foldersQuery.data])
  const folderById = useMemo(() => new Map(folders.map((f) => [f.id, f])), [folders])

  const partsQuery = useQuery({
    queryKey: ['parts'],
    queryFn: (): Promise<Part[]> =>
      fetchAllRows<Part>((from, to) =>
        supabase
          .from('parts')
          .select(
            'id, sku, supplier_id, description, unit_cost, active, folder_id, legend, created_at, updated_at, suppliers(id, name, is_owner_supplied)',
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
      const folderId = parsed.folder_id === '' ? null : parsed.folder_id
      const legend = parsed.legend.trim()

      if (editingPart) {
        const { error } = await supabase
          .from('parts')
          .update({
            sku: parsed.sku.trim(),
            supplier_id: parsed.supplier_id,
            description: parsed.description.trim(),
            unit_cost: nullableCost,
            active: parsed.active,
            folder_id: folderId,
            legend,
          })
          .eq('id', editingPart.id)
        if (error) throw error
      } else {
        const { error } = await supabase.from('parts').insert({
          sku: parsed.sku.trim(),
          supplier_id: parsed.supplier_id,
          description: parsed.description.trim(),
          unit_cost: nullableCost,
          active: parsed.active,
          folder_id: folderId,
          legend,
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

  const saveFolderMutation = useMutation({
    mutationFn: async () => {
      if (!folderDialog) return
      if (folderDialog.kind === 'delete') {
        const { error } = await supabase.from('part_folders').delete().eq('id', folderDialog.folder.id)
        if (error) throw error
        return
      }
      const name = folderName.trim()
      if (!name) throw new Error('Enter a folder name.')
      if (name.length > 100) throw new Error('The folder name is too long.')
      const { error } =
        folderDialog.kind === 'add'
          ? await supabase.from('part_folders').insert({
              name,
              position: Math.max(0, ...folders.map((f) => f.position)) + 1,
            })
          : await supabase.from('part_folders').update({ name }).eq('id', folderDialog.folder.id)
      if (error) throw new Error(error.code === '23505' ? 'Another folder already has that name.' : error.message)
    },
    onSuccess: async () => {
      if (folderDialog?.kind === 'delete' && folderFilter === folderDialog.folder.id) setFolderFilter('ALL')
      setFolderDialog(null)
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['part_folders'] }),
        queryClient.invalidateQueries({ queryKey: ['parts'] }),
      ])
    },
    onError: (err: Error) => setFolderError(err.message),
  })

  // Parts that pass the search / supplier / active filters (before the folder filter).
  const searchedParts = useMemo(() => {
    const all = partsQuery.data ?? []
    const q = searchQuery.trim().toLowerCase()

    return all.filter((part) => {
      if (!showInactive && !part.active) return false
      if (
        supplierFilter !== 'ALL' &&
        part.supplier_id !== supplierFilter
      ) {
        return false
      }
      if (!q) return true
      const mfgName = part.suppliers?.name?.toLowerCase() ?? ''
      return (
        part.sku.toLowerCase().includes(q) ||
        part.description.toLowerCase().includes(q) ||
        (part.legend ?? '').toLowerCase().includes(q) ||
        mfgName.includes(q)
      )
    })
  }, [partsQuery.data, searchQuery, supplierFilter, showInactive])

  const folderCounts = useMemo(() => {
    const counts = new Map<string, number>()
    for (const part of searchedParts) {
      const k = part.folder_id && folderById.has(part.folder_id) ? part.folder_id : 'UNFILED'
      counts.set(k, (counts.get(k) ?? 0) + 1)
    }
    return counts
  }, [searchedParts, folderById])

  const filteredParts = useMemo(() => {
    if (folderFilter === 'ALL') return searchedParts
    if (folderFilter === 'UNFILED') {
      return searchedParts.filter((p) => !p.folder_id || !folderById.has(p.folder_id))
    }
    return searchedParts.filter((p) => p.folder_id === folderFilter)
  }, [searchedParts, folderFilter, folderById])

  const selectedFolder = folderById.get(folderFilter) ?? null

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
        id: 'legend',
        accessorFn: (row) => row.legend ?? '',
        header: 'Legend',
        cell: ({ row }) =>
          row.original.legend ? (
            <span className="font-mono text-xs font-medium text-neutral-800">{row.original.legend}</span>
          ) : (
            <span className="text-neutral-300">—</span>
          ),
      },
      {
        id: 'folder',
        accessorFn: (row) => (row.folder_id ? folderById.get(row.folder_id)?.name ?? '' : ''),
        header: 'Folder',
        cell: ({ row }) => {
          const f = row.original.folder_id ? folderById.get(row.original.folder_id) : undefined
          return f ? (
            <span className="whitespace-nowrap text-xs text-neutral-700">{f.name}</span>
          ) : (
            <span className="text-xs italic text-neutral-400">Unfiled</span>
          )
        },
      },
      {
        id: 'supplier',
        accessorFn: (row) => row.suppliers?.name ?? '',
        header: ({ column }) => (
          <button
            type="button"
            className="inline-flex items-center gap-1 font-semibold uppercase tracking-wider hover:text-neutral-950 cursor-pointer"
            onClick={() => column.toggleSorting(column.getIsSorted() === 'asc')}
          >
            <span>Supplier</span>
            <ArrowUpDown className="h-3 w-3" />
          </button>
        ),
        cell: ({ row }) => {
          const mfg = row.original.suppliers
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
                        supplier_id: part.supplier_id,
                        description: part.description,
                        unit_cost:
                          part.unit_cost === null || part.unit_cost === undefined
                            ? ''
                            : String(part.unit_cost),
                        active: part.active,
                        folder_id: part.folder_id ?? '',
                        legend: part.legend ?? '',
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
    [isAdmin, form, toggleActiveMutation, folderById],
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
    const defaultMfgId = suppliersQuery.data?.[0]?.id ?? ''
    form.reset({
      sku: '',
      supplier_id: defaultMfgId,
      description: '',
      unit_cost: '',
      active: true,
      // New parts go into the folder being viewed.
      folder_id: selectedFolder?.id ?? '',
      legend: '',
    })
    setDialogOpen(true)
  }

  const openFolderDialog = (next: NonNullable<typeof folderDialog>) => {
    setFolderError(null)
    setFolderName(next.kind === 'rename' ? next.folder.name : '')
    setFolderDialog(next)
  }

  // Folder pane entry.
  const folderButton = (id: string, label: string, count: number, icon: React.ReactNode) => {
    const active = folderFilter === id
    return (
      <button
        key={id}
        type="button"
        onClick={() => setFolderFilter(id)}
        aria-current={active ? 'true' : undefined}
        className={`flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm ${
          active ? 'bg-neutral-950 font-semibold text-white' : 'text-neutral-700 hover:bg-neutral-100'
        }`}
        data-testid="folder-item"
      >
        {icon}
        <span className="min-w-0 flex-1 truncate">{label}</span>
        <span className={`text-[11px] tabular-nums ${active ? 'text-neutral-300' : 'text-neutral-400'}`}>{count}</span>
      </button>
    )
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
            Door hardware by folder, with every supplier&rsquo;s parts, legends and unit costs. Parts with blank cost are marked &ldquo;No unit price&rdquo;.
          </p>
        </div>

        {isAdmin && (
          <Button onClick={openAddPartDialog} size="sm">
            <Plus className="h-4 w-4" />
            <span>Add Part</span>
          </Button>
        )}
      </div>

      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[15rem_minmax(0,1fr)]">
        {/* Folder pane */}
        <nav aria-label="Part folders" className="rounded-md border border-neutral-200 bg-white p-2 lg:sticky lg:top-4">
          <div className="flex items-center justify-between px-1.5 pb-2 pt-1">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-neutral-500">Folders</span>
            {isAdmin && (
              <button
                type="button"
                onClick={() => openFolderDialog({ kind: 'add' })}
                className="rounded p-1 text-neutral-500 hover:bg-neutral-100 hover:text-neutral-950"
                aria-label="New folder"
                title="New folder"
              >
                <FolderPlus className="h-4 w-4" />
              </button>
            )}
          </div>
          <div className="space-y-0.5">
            {folderButton('ALL', 'All parts', searchedParts.length, <Boxes className="h-4 w-4 shrink-0" />)}
            {folders.map((f) =>
              folderButton(
                f.id,
                f.name,
                folderCounts.get(f.id) ?? 0,
                folderFilter === f.id ? (
                  <FolderOpen className="h-4 w-4 shrink-0" />
                ) : (
                  <Folder className="h-4 w-4 shrink-0" />
                ),
              ),
            )}
            {folderButton(
              'UNFILED',
              'Unfiled',
              folderCounts.get('UNFILED') ?? 0,
              <Folder className="h-4 w-4 shrink-0 opacity-50" />,
            )}
          </div>
        </nav>

        <div className="min-w-0 space-y-4">
      {selectedFolder && (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="flex items-center gap-2 text-base font-semibold text-neutral-950">
            <FolderOpen className="h-4 w-4" />
            {selectedFolder.name}
          </h2>
          {isAdmin && (
            <div className="flex items-center gap-1.5">
              <Button variant="outline" size="sm" onClick={() => openFolderDialog({ kind: 'rename', folder: selectedFolder })}>
                <Pencil className="h-3.5 w-3.5" />
                <span>Rename</span>
              </Button>
              <Button variant="outline" size="sm" onClick={() => openFolderDialog({ kind: 'delete', folder: selectedFolder })}>
                <Trash2 className="h-3.5 w-3.5" />
                <span>Delete folder</span>
              </Button>
            </div>
          )}
        </div>
      )}

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
            aria-label="Filter by supplier"
            value={supplierFilter}
            onChange={(e) => setSupplierFilter(e.target.value)}
            className="h-9 rounded-md border border-neutral-300 bg-white px-3 text-sm text-neutral-950 focus:outline-none focus:ring-2 focus:ring-neutral-950"
          >
            <option value="ALL">All Suppliers</option>
            {suppliersQuery.data?.map((mfg) => (
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
        </div>
      </div>

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
                <Label htmlFor="part-supplier">Supplier</Label>
                <select
                  id="part-supplier"
                  {...form.register('supplier_id')}
                  className="flex h-9 w-full rounded-md border border-neutral-300 bg-white px-3 py-1 text-sm text-neutral-950 focus:outline-none focus:ring-2 focus:ring-neutral-950"
                >
                  <option value="">Select supplier...</option>
                  {suppliersQuery.data?.map((mfg) => (
                    <option key={mfg.id} value={mfg.id}>
                      {mfg.name} {mfg.is_owner_supplied ? '(OSM)' : ''}
                    </option>
                  ))}
                </select>
                {form.formState.errors.supplier_id && (
                  <p className="text-xs font-medium text-neutral-900">
                    {form.formState.errors.supplier_id.message}
                  </p>
                )}
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-[minmax(0,1fr)_8rem] gap-4">
              <div className="space-y-1.5">
                <Label htmlFor="part-folder">Folder</Label>
                <select
                  id="part-folder"
                  {...form.register('folder_id')}
                  className="flex h-9 w-full rounded-md border border-neutral-300 bg-white px-3 py-1 text-sm text-neutral-950 focus:outline-none focus:ring-2 focus:ring-neutral-950"
                >
                  <option value="">Unfiled</option>
                  {folders.map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="part-legend">Legend</Label>
                <Input id="part-legend" placeholder="e.g. F7" {...form.register('legend')} />
                {form.formState.errors.legend && (
                  <p className="text-xs font-medium text-neutral-900">{form.formState.errors.legend.message}</p>
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

      {/* Folder add / rename / delete */}
      <Dialog
        open={folderDialog !== null}
        onOpenChange={(open) => !open && !saveFolderMutation.isPending && setFolderDialog(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {folderDialog?.kind === 'add'
                ? 'New Folder'
                : folderDialog?.kind === 'rename'
                  ? 'Rename Folder'
                  : 'Delete Folder'}
            </DialogTitle>
            <DialogDescription>
              {folderDialog?.kind === 'delete'
                ? `Delete "${folderDialog.folder.name}"? Its ${folderCounts.get(folderDialog.folder.id) ?? 0} part(s) become unfiled; no parts are deleted.`
                : 'A folder groups a family of hardware, with parts from every supplier.'}
            </DialogDescription>
          </DialogHeader>
          {folderError && (
            <div role="alert" className="border border-neutral-950 bg-neutral-100 p-3 text-xs text-neutral-950">
              {folderError}
            </div>
          )}
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault()
              saveFolderMutation.mutate()
            }}
          >
            {folderDialog?.kind !== 'delete' && (
              <div className="space-y-1.5">
                <Label htmlFor="folder-name">Folder name</Label>
                <Input
                  id="folder-name"
                  autoFocus
                  placeholder="e.g. Lever furniture - round rose"
                  value={folderName}
                  onChange={(e) => setFolderName(e.target.value)}
                />
              </div>
            )}
            <DialogFooter>
              <Button type="button" variant="outline" disabled={saveFolderMutation.isPending} onClick={() => setFolderDialog(null)}>
                Cancel
              </Button>
              <Button type="submit" disabled={saveFolderMutation.isPending}>
                {saveFolderMutation.isPending
                  ? 'Saving...'
                  : folderDialog?.kind === 'delete'
                    ? 'Delete Folder'
                    : 'Save'}
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
