import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, Search, Shapes, X } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { fetchAllRows } from '@/lib/fetchAll'
import { useAuth } from '@/features/auth/AuthContext'
import { TableSkeleton } from '@/components/ui/skeleton'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import type { GenericItem, GenericPreference } from '@/features/projects/genericParts'

interface PartRow {
  id: string
  sku: string
  description: string
  supplier_id: string
  folder_id: string | null
  active: boolean
}

/**
 * Generic set items ("PASSAGE SET LEVER ROUND") and each supplier's preferred
 * part for them: what a quotation import quotes the item with for that
 * supplier (genericParts.ts). Everyone reads; admins change the preferred parts.
 */
export function GenericItemsPage() {
  const { isAdmin } = useAuth()
  const queryClient = useQueryClient()
  const [search, setSearch] = useState('')
  const [error, setError] = useState<string | null>(null)

  const dataQuery = useQuery({
    queryKey: ['generic_items', 'page'],
    queryFn: async () => {
      const [items, prefs, folders, suppliers, parts] = await Promise.all([
        supabase
          .from('generic_items')
          .select('id, code, description, folder_id, active')
          .order('description'),
        supabase.from('generic_item_parts').select('generic_id, supplier_id, part_id'),
        supabase.from('part_folders').select('id, name'),
        supabase.from('suppliers').select('id, name').order('name'),
        fetchAllRows<PartRow>((from, to) =>
          supabase
            .from('parts')
            .select('id, sku, description, supplier_id, folder_id, active')
            .order('sku')
            .order('id')
            .range(from, to),
        ),
      ])
      for (const r of [items, prefs, folders, suppliers]) if (r.error) throw r.error
      const list = <T,>(d: unknown) => (Array.isArray(d) ? (d as T[]) : [])
      return {
        items: list<GenericItem>(items.data),
        prefs: list<GenericPreference>(prefs.data),
        folders: new Map(
          list<{ id: string; name: string }>(folders.data).map((f) => [f.id, f.name]),
        ),
        suppliers: new Map(
          list<{ id: string; name: string }>(suppliers.data).map((s) => [s.id, s.name]),
        ),
        parts,
      }
    },
  })

  const setPreferred = useMutation({
    mutationFn: async ({ genericId, part }: { genericId: string; part: PartRow }) => {
      const { error: e } = await supabase
        .from('generic_item_parts')
        .upsert(
          { generic_id: genericId, supplier_id: part.supplier_id, part_id: part.id },
          { onConflict: 'generic_id,supplier_id' },
        )
      if (e) throw e
    },
    onSuccess: async () => {
      setError(null)
      await queryClient.invalidateQueries({ queryKey: ['generic_items'] })
    },
    onError: (e: Error) => setError(e.message),
  })

  const removePreferred = useMutation({
    mutationFn: async (p: GenericPreference) => {
      const { error: e } = await supabase
        .from('generic_item_parts')
        .delete()
        .eq('generic_id', p.generic_id)
        .eq('supplier_id', p.supplier_id)
      if (e) throw e
    },
    onSuccess: async () => {
      setError(null)
      await queryClient.invalidateQueries({ queryKey: ['generic_items'] })
    },
    onError: (e: Error) => setError(e.message),
  })

  const data = dataQuery.data
  const partById = useMemo(() => new Map((data?.parts ?? []).map((p) => [p.id, p])), [data])
  // Each folder's active parts, by supplier then part number: worked out once
  // (not per row on every render or keystroke in the search box).
  const partsByFolder = useMemo(() => {
    const map = new Map<string, PartRow[]>()
    for (const p of data?.parts ?? []) {
      if (!p.active || !p.folder_id) continue
      const list = map.get(p.folder_id)
      if (list) list.push(p)
      else map.set(p.folder_id, [p])
    }
    const supplierName = (id: string) => data?.suppliers.get(id) ?? ''
    for (const list of map.values()) {
      list.sort((a, b) => supplierName(a.supplier_id).localeCompare(supplierName(b.supplier_id)) || a.sku.localeCompare(b.sku))
    }
    return map
  }, [data])
  const prefsByItem = useMemo(() => {
    const map = new Map<string, GenericPreference[]>()
    for (const p of data?.prefs ?? []) map.set(p.generic_id, [...(map.get(p.generic_id) ?? []), p])
    return map
  }, [data])
  const rows = useMemo(() => {
    const q = search.trim().toLowerCase()
    return (data?.items ?? []).filter(
      (g) => !q || g.code.toLowerCase().includes(q) || g.description.toLowerCase().includes(q),
    )
  }, [data, search])

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 border-b border-neutral-200 pb-4">
        <Button variant="outline" size="sm" asChild className="w-fit">
          <Link to="/standard-sets">
            <ArrowLeft className="h-4 w-4" />
            <span>Standard Sets</span>
          </Link>
        </Button>
        <div>
          <h1 className="flex items-center gap-2 text-xl font-bold tracking-tight text-neutral-950">
            <Shapes className="h-5 w-5" />
            <span>Generic Items</span>
          </h1>
          <p className="mt-0.5 text-sm text-neutral-600">
            Standard sets name generic items. When a quotation is imported, each one becomes the
            quote supplier&apos;s preferred part below; with none, the supplier&apos;s closest part
            in the same folder.
          </p>
        </div>
      </div>

      <div className="relative max-w-sm">
        <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-neutral-400" />
        <Input
          className="pl-8"
          placeholder="Search code or name..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      {error && (
        <div className="border border-red-300 bg-red-50 p-3 text-xs text-red-800">{error}</div>
      )}

      {dataQuery.isLoading ? (
        <TableSkeleton rows={8} columns={4} />
      ) : dataQuery.isError ? (
        <div className="text-sm text-red-700">Couldn&apos;t load the generic items.</div>
      ) : (
        <div className="border border-neutral-200">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Code</TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Folder</TableHead>
                <TableHead>Preferred part per supplier</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((g) => {
                const prefs = prefsByItem.get(g.id) ?? []
                const options = (g.folder_id && partsByFolder.get(g.folder_id)) || []
                return (
                  <TableRow key={g.id} className="align-top" data-testid="generic-item-row">
                    <TableCell className="font-mono text-xs font-semibold text-neutral-950">
                      {g.code}
                    </TableCell>
                    <TableCell className="text-sm text-neutral-900">{g.description}</TableCell>
                    <TableCell className="text-xs text-neutral-600">
                      {(g.folder_id && data?.folders.get(g.folder_id)) || '—'}
                    </TableCell>
                    <TableCell className="space-y-1.5">
                      {prefs.length === 0 && (
                        <div className="text-xs text-neutral-400">None yet</div>
                      )}
                      {prefs.map((p) => {
                        const part = partById.get(p.part_id)
                        return (
                          <div key={p.supplier_id} className="flex items-start gap-2 text-xs">
                            <span className="w-36 shrink-0 font-medium uppercase text-neutral-500">
                              {data?.suppliers.get(p.supplier_id) ?? '—'}
                            </span>
                            <span className="min-w-0">
                              <span className="font-mono font-semibold text-neutral-950">
                                {part?.sku ?? '—'}
                              </span>
                              <span className="ml-1.5 text-neutral-600">{part?.description}</span>
                            </span>
                            {isAdmin && (
                              <button
                                type="button"
                                className="ml-auto text-neutral-400 hover:text-neutral-950"
                                title="Remove this preferred part"
                                onClick={() => removePreferred.mutate(p)}
                              >
                                <X className="h-3.5 w-3.5" />
                              </button>
                            )}
                          </div>
                        )
                      })}
                      {isAdmin && options.length > 0 && (
                        <select
                          className="mt-1 h-8 w-full max-w-md border border-neutral-300 bg-white px-2 text-xs"
                          value=""
                          aria-label={`Set the preferred part for ${g.description}`}
                          onChange={(e) => {
                            const part = partById.get(e.target.value)
                            if (part) setPreferred.mutate({ genericId: g.id, part })
                          }}
                        >
                          <option value="">Set a supplier&apos;s preferred part…</option>
                          {options.map((p) => (
                            <option key={p.id} value={p.id}>
                              {data?.suppliers.get(p.supplier_id) ?? '—'} · {p.sku} ·{' '}
                              {p.description}
                            </option>
                          ))}
                        </select>
                      )}
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  )
}
