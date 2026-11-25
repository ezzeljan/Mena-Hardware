import { useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { ArrowLeft, Building2, Search } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { TableSkeleton } from '@/components/ui/skeleton'
import { fetchAllRows } from '@/lib/fetchAll'
import { formatCurrency } from '@/lib/utils'
import type { Part, PartFolder, Supplier } from '@/types/database'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'

const UNFILED = 'UNFILED'
const ALL = 'ALL'

/** One supplier's parts, with search, folder and active filters. */
export function SupplierProductsPage() {
  const { id = '' } = useParams<{ id: string }>()
  const [search, setSearch] = useState('')
  const [folderFilter, setFolderFilter] = useState<string>(ALL)
  const [showInactive, setShowInactive] = useState(false)

  const supplierQuery = useQuery({
    queryKey: ['suppliers', id],
    queryFn: async (): Promise<Supplier | null> => {
      const { data, error } = await supabase
        .from('suppliers')
        .select('id, name, is_owner_supplied, created_at, updated_at')
        .eq('id', id)
        .maybeSingle()
      if (error) throw error
      return data as Supplier | null
    },
    enabled: !!id,
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

  // Under ['parts'] so part edits elsewhere refresh this list too.
  const partsQuery = useQuery({
    queryKey: ['parts', 'supplier', id],
    queryFn: (): Promise<Part[]> =>
      fetchAllRows<Part>((from, to) =>
        supabase
          .from('parts')
          .select(
            'id, sku, supplier_id, description, unit_cost, active, folder_id, legend, created_at, updated_at',
          )
          .eq('supplier_id', id)
          .order('sku', { ascending: true })
          .order('id', { ascending: true })
          .range(from, to),
      ),
    enabled: !!id,
  })

  // Search + active filter, before the folder filter (so folder counts follow the search).
  const searched = useMemo(() => {
    const q = search.trim().toLowerCase()
    return (partsQuery.data ?? []).filter((p) => {
      if (!showInactive && !p.active) return false
      if (!q) return true
      return (
        p.sku.toLowerCase().includes(q) ||
        p.description.toLowerCase().includes(q) ||
        (p.legend ?? '').toLowerCase().includes(q)
      )
    })
  }, [partsQuery.data, search, showInactive])

  const counts = useMemo(() => {
    const m = new Map<string, number>()
    for (const p of searched) {
      const k = p.folder_id && folderById.has(p.folder_id) ? p.folder_id : UNFILED
      m.set(k, (m.get(k) ?? 0) + 1)
    }
    return m
  }, [searched, folderById])

  const shown = useMemo(() => {
    if (folderFilter === ALL) return searched
    return searched.filter(
      (p) => (p.folder_id && folderById.has(p.folder_id) ? p.folder_id : UNFILED) === folderFilter,
    )
  }, [searched, folderFilter, folderById])

  const total = partsQuery.data?.length ?? 0
  const activeTotal = partsQuery.data?.filter((p) => p.active).length ?? 0
  const supplier = supplierQuery.data

  return (
    <div className="space-y-6 max-w-6xl">
      <div className="border-b border-neutral-200 pb-4">
        <Link
          to="/suppliers"
          className="inline-flex items-center gap-1 text-xs font-medium text-neutral-600 hover:text-neutral-950"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          <span>Suppliers</span>
        </Link>
        <h1 className="mt-1 text-xl font-bold tracking-tight text-neutral-950 flex items-center gap-2">
          <Building2 className="h-5 w-5" />
          <span>
            {supplier?.name ?? (supplierQuery.isLoading ? 'Loading…' : 'Supplier not found')}
          </span>
          {supplier?.is_owner_supplied && <Badge variant="default">Owner-Supplied (OSM)</Badge>}
        </h1>
        {supplier && (
          <p className="text-sm text-neutral-600 mt-0.5">
            {activeTotal} active part{activeTotal === 1 ? '' : 's'}
            {total > activeTotal ? ` · ${total - activeTotal} inactive` : ''}
          </p>
        )}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 bg-neutral-50 p-3 border border-neutral-200 rounded-md">
        <div className="flex flex-wrap items-center gap-3 flex-1 min-w-[260px]">
          <div className="relative flex-1 max-w-sm">
            <Search className="h-4 w-4 absolute left-3 top-2.5 text-neutral-400" />
            <Input
              aria-label="Search this supplier's parts"
              placeholder="Search SKU, legend or description..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-9 bg-white"
            />
          </div>

          <select
            aria-label="Filter by folder"
            value={folderFilter}
            onChange={(e) => setFolderFilter(e.target.value)}
            className="h-9 rounded-md border border-neutral-300 bg-white px-3 text-sm text-neutral-950 focus:outline-none focus:ring-2 focus:ring-neutral-950"
          >
            <option value={ALL}>All folders ({searched.length})</option>
            {folders
              .filter((f) => counts.has(f.id) || folderFilter === f.id)
              .map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name} ({counts.get(f.id) ?? 0})
                </option>
              ))}
            {(counts.has(UNFILED) || folderFilter === UNFILED) && (
              <option value={UNFILED}>Unfiled ({counts.get(UNFILED) ?? 0})</option>
            )}
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
          Showing {shown.length} part{shown.length === 1 ? '' : 's'}
        </div>
      </div>

      {partsQuery.isLoading || supplierQuery.isLoading ? (
        <TableSkeleton rows={8} columns={6} label="Loading parts…" />
      ) : partsQuery.isError || supplierQuery.isError ? (
        <div
          role="alert"
          className="border border-neutral-950 bg-neutral-50 p-6 text-sm text-neutral-950"
        >
          Error loading parts: {((partsQuery.error ?? supplierQuery.error) as Error).message}
        </div>
      ) : !supplier ? (
        <div className="border border-neutral-200 p-10 text-center text-sm text-neutral-600">
          This supplier doesn't exist.{' '}
          <Link to="/suppliers" className="underline">
            Back to suppliers
          </Link>
        </div>
      ) : shown.length === 0 ? (
        <div className="border border-neutral-200 p-10 text-center text-sm text-neutral-600">
          {total === 0 ? 'This supplier has no parts yet.' : 'No parts match your current filters.'}
        </div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>SKU</TableHead>
              <TableHead>Legend</TableHead>
              <TableHead>Description</TableHead>
              <TableHead>Folder</TableHead>
              <TableHead className="text-right">Unit Cost</TableHead>
              <TableHead>Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {shown.map((p) => (
              <TableRow key={p.id} className={p.active ? undefined : 'text-neutral-400'}>
                <TableCell className="font-mono text-xs font-semibold">{p.sku}</TableCell>
                <TableCell className="text-xs">{p.legend || '—'}</TableCell>
                <TableCell className="text-sm">{p.description}</TableCell>
                <TableCell className="text-xs text-neutral-600">
                  {(p.folder_id && folderById.get(p.folder_id)?.name) || 'Unfiled'}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {p.unit_cost === null ? '—' : formatCurrency(Number(p.unit_cost))}
                </TableCell>
                <TableCell>
                  {p.active ? (
                    <Badge variant="outline">Active</Badge>
                  ) : (
                    <Badge variant="outline">Inactive</Badge>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  )
}
