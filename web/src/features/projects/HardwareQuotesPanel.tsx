import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowRight, FileSpreadsheet, Lock, Pencil, Plus, Trophy } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import type { QuoteSheet, VersionStatus } from '@/types/database'
import type { QuoteDetail } from '@/features/projects/useProjectDetail'
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

export const VERSION_STATUS_TEXT: Record<VersionStatus, string> = {
  draft: 'Draft — being prepared by the estimators',
  submitted: 'Waiting for PM review',
  approved: 'Approved',
  changes_requested: 'Changes requested by the PM',
  superseded: 'Superseded',
}

interface HardwareQuotesPanelProps {
  projectId: string
  quotes: QuoteDetail[]
  /** Supplier of the winning sheet (Awarded projects). */
  awardedSupplierName: string | null
  canAddQuote: boolean
  canEditContent: boolean
  /** Why no quote can be added, shown instead of the button. */
  addQuoteHint: string | null
  onNewQuote: () => void
}

/** The project's builder quotes: latest version, supplier sheets, winner. */
export function HardwareQuotesPanel({
  projectId,
  quotes,
  awardedSupplierName,
  canAddQuote,
  canEditContent,
  addQuoteHint,
  onNewQuote,
}: HardwareQuotesPanelProps) {
  const queryClient = useQueryClient()
  const [renaming, setRenaming] = useState<QuoteDetail | null>(null)
  const [newName, setNewName] = useState('')
  const [renameError, setRenameError] = useState<string | null>(null)

  const latestIds = quotes.flatMap((q) => (q.latestVersion ? [q.latestVersion.id] : []))
  const sheetsQuery = useQuery({
    queryKey: ['quote_sheets', 'latest', ...latestIds],
    enabled: latestIds.length > 0,
    queryFn: async (): Promise<Pick<QuoteSheet, 'id' | 'version_id' | 'name' | 'position'>[]> => {
      const { data, error } = await supabase
        .from('quote_sheets')
        .select('id, version_id, name, position')
        .in('version_id', latestIds)
        .order('position', { ascending: true })
      if (error) throw error
      return data ?? []
    },
  })

  const renameMutation = useMutation({
    mutationFn: async ({ id, name }: { id: string; name: string }) => {
      const { data, error } = await supabase
        .from('hardware_quotes')
        .update({ builder_name: name })
        .eq('id', id)
        .select('id')
      if (error) {
        throw new Error(
          error.code === '23505'
            ? `This project already has a quote for "${name}".`
            : error.message,
        )
      }
      if (!data || data.length === 0) throw new Error('You cannot rename this quote.')
    },
    onSuccess: async () => {
      setRenaming(null)
      await queryClient.invalidateQueries({ queryKey: ['project', projectId] })
    },
    onError: (err: Error) => setRenameError(err.message),
  })

  const sheetsByVersion = new Map<string, string[]>()
  for (const s of sheetsQuery.data ?? []) {
    const arr = sheetsByVersion.get(s.version_id) ?? []
    arr.push(s.name)
    sheetsByVersion.set(s.version_id, arr)
  }

  return (
    <div className="border border-neutral-300 bg-white rounded-md" data-testid="hardware-quotes">
      <div className="flex items-center justify-between gap-3 border-b border-neutral-200 px-4 py-3">
        <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-neutral-500">
          <FileSpreadsheet className="h-3.5 w-3.5" />
          <span>Hardware Quotes ({quotes.length})</span>
        </div>
        {canAddQuote ? (
          <Button size="sm" onClick={onNewQuote}>
            <Plus className="h-3.5 w-3.5" />
            <span>New Quote</span>
          </Button>
        ) : (
          addQuoteHint && <span className="text-[11px] text-neutral-500">{addQuoteHint}</span>
        )}
      </div>

      {quotes.length === 0 ? (
        <div className="p-8 text-center text-xs text-neutral-600">No builder quotes yet.</div>
      ) : (
        <ul className="divide-y divide-neutral-200">
          {quotes.map((q) => {
            const v = q.latestVersion
            const sheets = v ? (sheetsByVersion.get(v.id) ?? []) : []
            return (
              <li
                key={q.id}
                className={`flex flex-col gap-3 px-4 py-3 2xl:flex-row 2xl:items-center 2xl:justify-between ${
                  q.isWinner ? 'bg-emerald-50/60' : q.locked ? 'bg-neutral-50' : ''
                }`}
                data-testid="hardware-quote-row"
              >
                <div className="min-w-0 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate text-sm font-bold text-neutral-950">
                      {q.builder_name}
                    </span>
                    {canEditContent && !q.locked && (
                      <button
                        type="button"
                        aria-label={`Rename the quote for ${q.builder_name}`}
                        className="text-neutral-400 hover:text-neutral-950"
                        onClick={() => {
                          setRenaming(q)
                          setNewName(q.builder_name)
                          setRenameError(null)
                        }}
                      >
                        <Pencil className="h-3 w-3" />
                      </button>
                    )}
                    {q.isWinner && (
                      <span className="inline-flex items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[11px] font-semibold text-emerald-700">
                        <Trophy className="h-3 w-3" />
                        Awarded{awardedSupplierName ? ` · ${awardedSupplierName}` : ''}
                      </span>
                    )}
                    {q.locked && (
                      <span className="inline-flex items-center gap-1 text-[11px] text-neutral-500">
                        <Lock className="h-3 w-3" />
                        Not awarded (read-only)
                      </span>
                    )}
                  </div>
                  {v && !q.needsQuotation ? (
                    <>
                      <div className="flex flex-wrap items-center gap-2 text-xs">
                        <span className="font-mono font-semibold text-neutral-950">
                          v{v.version_no}
                        </span>
                        <Badge
                          variant={v.status === 'approved' ? 'default' : 'outline'}
                          className="uppercase tracking-wider text-[10px]"
                        >
                          {v.status.replace('_', ' ')}
                        </Badge>
                        <span className="text-neutral-700">{VERSION_STATUS_TEXT[v.status]}</span>
                      </div>
                      <div className="text-[11px] text-neutral-600">
                        {sheets.length > 0 ? `Sheets: ${sheets.join(', ')}` : 'Loading sheets...'}
                        {' · '}Updated{' '}
                        {new Date(v.updated_at).toLocaleDateString(undefined, {
                          day: 'numeric',
                          month: 'short',
                          year: 'numeric',
                        })}
                      </div>
                    </>
                  ) : (
                    <div className="text-xs text-neutral-600">Quotation not imported yet</div>
                  )}
                </div>
                {v && !q.needsQuotation && (
                  <Button
                    asChild
                    size="sm"
                    variant="outline"
                    className="self-start 2xl:self-center"
                  >
                    <Link to={`/projects/${projectId}/hardware?quote=${q.id}`}>
                      <span>Open Quote</span>
                      <ArrowRight className="h-3.5 w-3.5" />
                    </Link>
                  </Button>
                )}
              </li>
            )
          })}
        </ul>
      )}

      <Dialog open={renaming !== null} onOpenChange={(o) => !o && setRenaming(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rename Quote</DialogTitle>
            <DialogDescription>Change the builder name of this quote.</DialogDescription>
          </DialogHeader>
          {renameError && (
            <div
              role="alert"
              className="border border-neutral-950 bg-neutral-100 p-3 text-xs text-neutral-950"
            >
              {renameError}
            </div>
          )}
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault()
              const name = newName.trim()
              if (!renaming || !name) {
                setRenameError('Enter the builder name.')
                return
              }
              renameMutation.mutate({ id: renaming.id, name })
            }}
          >
            <div className="space-y-1.5">
              <Label htmlFor="rename-quote-builder">Builder</Label>
              <Input
                id="rename-quote-builder"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
              />
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setRenaming(null)}>
                Cancel
              </Button>
              <Button type="submit" disabled={renameMutation.isPending}>
                {renameMutation.isPending ? 'Saving...' : 'Save'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  )
}
