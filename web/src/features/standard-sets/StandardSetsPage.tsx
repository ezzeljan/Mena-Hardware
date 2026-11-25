import { useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronRight, Layers, Plus, Search } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { TableSkeleton } from '@/components/ui/skeleton'
import { useAuth } from '@/features/auth/AuthContext'
import {
  standardSetSchema,
  type StandardSetFormValues,
} from '@/lib/schemas'
import { formatCurrency } from '@/lib/utils'
import type { StandardSet } from '@/types/database'
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

export function StandardSetsPage() {
  const { isAdmin } = useAuth()
  const navigate = useNavigate()
  const queryClient = useQueryClient()

  const [searchQuery, setSearchQuery] = useState('')
  const [classificationFilter, setClassificationFilter] = useState<string>('ALL')
  const [leafFilter, setLeafFilter] = useState<string>('ALL')
  const [showInactive, setShowInactive] = useState<boolean>(false)

  const [createDialogOpen, setCreateDialogOpen] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  const form = useForm<StandardSetFormValues>({
    resolver: zodResolver(standardSetSchema),
    defaultValues: {
      room_name: '',
      classification: 'FIRE RATED',
      leaf: 'SINGLE',
      door_size: '2040 x 920',
      active: true,
    },
  })

  const setsQuery = useQuery({
    queryKey: ['standard_sets'],
    queryFn: async (): Promise<StandardSet[]> => {
      const { data, error } = await supabase
        .from('standard_sets')
        .select(
          'id, room_name, classification, leaf, door_size, active, created_at, updated_at, standard_set_lines(id, qty, unit_price)',
        )
        .order('room_name', { ascending: true })
      if (error) throw error
      return (data ?? []) as unknown as StandardSet[]
    },
  })

  const createSetMutation = useMutation({
    mutationFn: async (values: StandardSetFormValues): Promise<string> => {
      const parsed = standardSetSchema.parse(values)
      const { data, error } = await supabase
        .from('standard_sets')
        .insert({
          room_name: parsed.room_name.trim(),
          classification: parsed.classification.trim(),
          leaf: parsed.leaf,
          door_size: parsed.door_size.trim(),
          active: parsed.active,
        })
        .select('id')
        .single()
      if (error) throw error
      return (data as { id: string }).id
    },
    onSuccess: async (newId) => {
      setCreateDialogOpen(false)
      setFormError(null)
      await queryClient.invalidateQueries({ queryKey: ['standard_sets'] })
      navigate(`/standard-sets/${newId}`)
    },
    onError: (err: Error) => {
      setFormError(err.message)
    },
  })

  const uniqueClassifications = useMemo(() => {
    const set = new Set<string>()
    for (const item of setsQuery.data ?? []) {
      const c = item.classification.trim()
      if (c) set.add(c)
    }
    return Array.from(set).sort()
  }, [setsQuery.data])

  const filteredSets = useMemo(() => {
    const all = setsQuery.data ?? []
    const q = searchQuery.trim().toLowerCase()

    return all.filter((s) => {
      if (!showInactive && !s.active) return false
      if (
        classificationFilter !== 'ALL' &&
        s.classification.trim() !== classificationFilter
      ) {
        return false
      }
      if (leafFilter !== 'ALL') {
        if (leafFilter === 'EMPTY' && s.leaf !== '') return false
        if (leafFilter !== 'EMPTY' && s.leaf !== leafFilter) return false
      }
      if (!q) return true
      return (
        s.room_name.toLowerCase().includes(q) ||
        s.classification.toLowerCase().includes(q) ||
        s.leaf.toLowerCase().includes(q) ||
        s.door_size.toLowerCase().includes(q)
      )
    })
  }, [
    setsQuery.data,
    searchQuery,
    classificationFilter,
    leafFilter,
    showInactive,
  ])

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-neutral-200 pb-4">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-neutral-950 flex items-center gap-2">
            <Layers className="h-5 w-5" />
            <span>Standard Hardware Sets</span>
          </h1>
          <p className="text-sm text-neutral-600 mt-0.5">
            Standard door hardware schedules by room type, fire classification, and leaf configuration.
          </p>
        </div>

        {isAdmin && (
          <Button
            size="sm"
            onClick={() => {
              setFormError(null)
              form.reset({
                room_name: '',
                classification: 'FIRE RATED',
                leaf: 'SINGLE',
                door_size: '2040 x 920',
                active: true,
              })
              setCreateDialogOpen(true)
            }}
          >
            <Plus className="h-4 w-4" />
            <span>New Standard Set</span>
          </Button>
        )}
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center justify-between gap-3 bg-neutral-50 p-3 border border-neutral-200 rounded-md">
        <div className="flex flex-wrap items-center gap-3 flex-1 min-w-[260px]">
          <div className="relative flex-1 max-w-sm">
            <Search className="h-4 w-4 absolute left-3 top-2.5 text-neutral-400" />
            <Input
              aria-label="Search standard sets"
              placeholder="Search room name, classification..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-9 bg-white"
            />
          </div>

          <select
            aria-label="Filter by classification"
            value={classificationFilter}
            onChange={(e) => setClassificationFilter(e.target.value)}
            className="h-9 rounded-md border border-neutral-300 bg-white px-3 text-sm text-neutral-950 focus:outline-none focus:ring-2 focus:ring-neutral-950"
          >
            <option value="ALL">All Classifications</option>
            {uniqueClassifications.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>

          <select
            aria-label="Filter by leaf"
            value={leafFilter}
            onChange={(e) => setLeafFilter(e.target.value)}
            className="h-9 rounded-md border border-neutral-300 bg-white px-3 text-sm text-neutral-950 focus:outline-none focus:ring-2 focus:ring-neutral-950"
          >
            <option value="ALL">All Leafs</option>
            <option value="SINGLE">SINGLE</option>
            <option value="DOUBLE">DOUBLE</option>
            <option value="CAVITY SINGLE">CAVITY SINGLE</option>
            <option value="CAVITY DOUBLE">CAVITY DOUBLE</option>
            <option value="TRIPLE">TRIPLE</option>
            <option value="EMPTY">Unspecified / Pivot</option>
          </select>

          <label className="inline-flex items-center gap-2 text-xs font-medium text-neutral-700 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={showInactive}
              onChange={(e) => setShowInactive(e.target.checked)}
              className="h-4 w-4 accent-neutral-950"
            />
            <span>Show inactive</span>
          </label>
        </div>

        <div className="text-xs font-medium text-neutral-600">
          Showing {filteredSets.length} of {setsQuery.data?.length ?? 0} sets
        </div>
      </div>

      {/* Table */}
      {setsQuery.isLoading ? (
        <TableSkeleton rows={8} columns={4} label="Loading standard sets…" />
      ) : setsQuery.isError ? (
        <div
          role="alert"
          className="border border-neutral-950 bg-neutral-50 p-6 text-sm text-neutral-950"
        >
          Error loading standard sets: {(setsQuery.error as Error).message}
        </div>
      ) : filteredSets.length === 0 ? (
        <div className="border border-neutral-200 p-10 text-center text-sm text-neutral-600">
          No standard sets match your filters.
        </div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Room Name</TableHead>
              <TableHead>Classification</TableHead>
              <TableHead>Leaf</TableHead>
              <TableHead>Door Size</TableHead>
              <TableHead>Lines</TableHead>
              <TableHead>Est. Set Cost</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Details</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filteredSets.map((set) => {
              const lines = set.standard_set_lines ?? []
              const unpricedCount = lines.filter(
                (l) => l.unit_price === null || l.unit_price === undefined,
              ).length
              const totalCost = lines.reduce((acc, l) => {
                if (l.unit_price === null || l.unit_price === undefined) {
                  return acc
                }
                return acc + Number(l.qty) * Number(l.unit_price)
              }, 0)

              return (
                <TableRow
                  key={set.id}
                  className={!set.active ? 'opacity-60' : undefined}
                >
                  <TableCell className="font-semibold text-neutral-950">
                    <Link
                      to={`/standard-sets/${set.id}`}
                      className="hover:underline"
                    >
                      {set.room_name}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant={
                        set.classification.includes('FIRE')
                          ? 'default'
                          : 'secondary'
                      }
                    >
                      {set.classification.trim() || 'UNSPECIFIED'}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    {set.leaf ? (
                      <Badge variant="outline">{set.leaf}</Badge>
                    ) : (
                      <span className="text-xs text-neutral-400">—</span>
                    )}
                  </TableCell>
                  <TableCell className="font-mono text-xs text-neutral-700">
                    {set.door_size || '—'}
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    {lines.length} items
                  </TableCell>
                  <TableCell className="font-mono text-sm font-medium">
                    <div>{formatCurrency(totalCost)}</div>
                    {unpricedCount > 0 && (
                      <div className="text-[10px] text-neutral-500">
                        + {unpricedCount} unpriced
                      </div>
                    )}
                  </TableCell>
                  <TableCell>
                    {set.active ? (
                      <Badge variant="secondary">Active</Badge>
                    ) : (
                      <Badge variant="outline" className="text-neutral-400">
                        Inactive
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    <Button variant="outline" size="sm" asChild>
                      <Link to={`/standard-sets/${set.id}`}>
                        <span>View / Edit</span>
                        <ChevronRight className="h-3.5 w-3.5" />
                      </Link>
                    </Button>
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      )}

      {/* Create Standard Set Modal */}
      <Dialog open={createDialogOpen} onOpenChange={setCreateDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create Standard Hardware Set</DialogTitle>
            <DialogDescription>
              Define the room name, fire classification, leaf configuration, and door size.
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
            onSubmit={form.handleSubmit((vals) => createSetMutation.mutate(vals))}
            className="space-y-4"
            noValidate
          >
            <div className="space-y-1.5">
              <Label htmlFor="set-room-name">Room Name</Label>
              <Input
                id="set-room-name"
                placeholder="e.g. UNIT ENTRY"
                {...form.register('room_name')}
              />
              {form.formState.errors.room_name && (
                <p className="text-xs font-medium text-neutral-900">
                  {form.formState.errors.room_name.message}
                </p>
              )}
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label htmlFor="set-classification">Classification</Label>
                <Input
                  id="set-classification"
                  placeholder="FIRE RATED / NON RATED"
                  {...form.register('classification')}
                />
                {form.formState.errors.classification && (
                  <p className="text-xs font-medium text-neutral-900">
                    {form.formState.errors.classification.message}
                  </p>
                )}
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="set-leaf">Leaf</Label>
                <select
                  id="set-leaf"
                  {...form.register('leaf')}
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
              <Label htmlFor="set-door-size">Door Size</Label>
              <Input
                id="set-door-size"
                placeholder="2040 x 920"
                {...form.register('door_size')}
              />
              {form.formState.errors.door_size && (
                <p className="text-xs font-medium text-neutral-900">
                  {form.formState.errors.door_size.message}
                </p>
              )}
            </div>

            <DialogFooter className="pt-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => setCreateDialogOpen(false)}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={createSetMutation.isPending}>
                {createSetMutation.isPending ? 'Creating...' : 'Create Set'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  )
}
