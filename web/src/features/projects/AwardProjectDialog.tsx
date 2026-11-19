import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Trophy } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import type { HardwareQuote, ProjectVersion, QuoteSheet } from '@/types/database'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

type VersionWithSheets = Pick<ProjectVersion, 'id' | 'quote_id' | 'version_no' | 'status'> & {
  quote_sheets: Pick<QuoteSheet, 'id' | 'supplier_id' | 'name' | 'position'>[]
}

interface Candidate {
  quote: Pick<HardwareQuote, 'id' | 'builder_name'>
  latest: VersionWithSheets | null
  /** Only a quote whose latest version is approved can win. */
  eligible: boolean
}

export interface AwardChoice {
  quoteId: string
  supplierId: string
}

interface AwardProjectDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  projectId: string
  pending: boolean
  error: string | null
  onConfirm: (choice: AwardChoice) => void
}

/**
 * Awarding a project: the PM picks the winning builder quote (its latest
 * version must be approved) and the supplier sheet that won. The other quotes
 * become read-only until the project goes back to Tender.
 */
export function AwardProjectDialog({
  open,
  onOpenChange,
  projectId,
  pending,
  error,
  onConfirm,
}: AwardProjectDialogProps) {
  const [quoteId, setQuoteId] = useState('')
  const [supplierId, setSupplierId] = useState('')

  const candidatesQuery = useQuery({
    queryKey: ['award-candidates', projectId],
    enabled: open,
    queryFn: async (): Promise<Candidate[]> => {
      const [quotesRes, versionsRes] = await Promise.all([
        supabase
          .from('hardware_quotes')
          .select('id, builder_name, created_at')
          .eq('project_id', projectId)
          .order('created_at', { ascending: true }),
        supabase
          .from('project_versions')
          .select('id, quote_id, version_no, status, quote_sheets(id, supplier_id, name, position)')
          .eq('project_id', projectId),
      ])
      if (quotesRes.error) throw quotesRes.error
      if (versionsRes.error) throw versionsRes.error
      const versions = (versionsRes.data ?? []) as unknown as VersionWithSheets[]
      return (quotesRes.data ?? []).map((quote) => {
        const latest =
          versions
            .filter((v) => v.quote_id === quote.id)
            .sort((a, b) => b.version_no - a.version_no)[0] ?? null
        return { quote, latest, eligible: latest?.status === 'approved' }
      })
    },
  })

  const candidates = useMemo(() => candidatesQuery.data ?? [], [candidatesQuery.data])
  const chosen = candidates.find((c) => c.quote.id === quoteId) ?? null
  const sheets = useMemo(
    () => [...(chosen?.latest?.quote_sheets ?? [])].sort((a, b) => a.position - b.position),
    [chosen],
  )

  // Start with the only eligible quote / sheet when there is just one.
  useEffect(() => {
    if (!open) {
      setQuoteId('')
      setSupplierId('')
      return
    }
    const eligible = candidates.filter((c) => c.eligible)
    if (!quoteId && eligible.length === 1) setQuoteId(eligible[0].quote.id)
  }, [open, candidates, quoteId])

  useEffect(() => {
    if (sheets.length === 1) setSupplierId(sheets[0].supplier_id)
    else if (!sheets.some((s) => s.supplier_id === supplierId)) setSupplierId('')
  }, [sheets, supplierId])

  const noneEligible = candidatesQuery.isSuccess && !candidates.some((c) => c.eligible)

  return (
    <Dialog open={open} onOpenChange={(o) => !pending && onOpenChange(o)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Trophy className="h-4 w-4 text-emerald-600" />
            Award Project
          </DialogTitle>
          <DialogDescription>
            Choose the winning builder quote and supplier sheet. The other quotes become read-only
            until the project goes back to Tender.
          </DialogDescription>
        </DialogHeader>

        {error && (
          <div role="alert" className="border border-neutral-950 bg-neutral-100 p-3 text-xs text-neutral-950">
            {error}
          </div>
        )}

        {candidatesQuery.isLoading ? (
          <p className="py-4 text-center text-xs text-neutral-500">Loading quotes...</p>
        ) : candidatesQuery.isError ? (
          <p className="py-4 text-center text-xs text-red-700">Could not load the quotes.</p>
        ) : noneEligible ? (
          <p className="rounded border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
            No quote is approved yet. A quote can win once its latest version is approved.
          </p>
        ) : (
          <div className="space-y-4">
            <fieldset className="space-y-1.5">
              <legend className="mb-1 text-xs font-semibold text-neutral-700">Winning quote</legend>
              {candidates.map((c) => (
                <label
                  key={c.quote.id}
                  className={`flex items-center gap-2 rounded border px-3 py-2 text-sm ${
                    c.eligible ? 'cursor-pointer border-neutral-300 hover:bg-neutral-50' : 'border-neutral-200 text-neutral-400'
                  } ${quoteId === c.quote.id ? 'border-neutral-950 bg-neutral-50' : ''}`}
                >
                  <input
                    type="radio"
                    name="award-quote"
                    value={c.quote.id}
                    disabled={!c.eligible}
                    checked={quoteId === c.quote.id}
                    onChange={() => setQuoteId(c.quote.id)}
                  />
                  <span className="flex-1 font-medium">{c.quote.builder_name}</span>
                  <span className="font-mono text-[11px]">
                    {c.latest ? `v${c.latest.version_no} · ${c.latest.status.replace('_', ' ')}` : 'no versions'}
                  </span>
                </label>
              ))}
            </fieldset>

            {chosen && (
              <fieldset className="space-y-1.5">
                <legend className="mb-1 text-xs font-semibold text-neutral-700">Winning supplier sheet</legend>
                {sheets.map((s) => (
                  <label
                    key={s.id}
                    className={`flex cursor-pointer items-center gap-2 rounded border px-3 py-2 text-sm hover:bg-neutral-50 ${
                      supplierId === s.supplier_id ? 'border-neutral-950 bg-neutral-50' : 'border-neutral-300'
                    }`}
                  >
                    <input
                      type="radio"
                      name="award-sheet"
                      value={s.supplier_id}
                      checked={supplierId === s.supplier_id}
                      onChange={() => setSupplierId(s.supplier_id)}
                    />
                    <span className="font-medium">{s.name}</span>
                  </label>
                ))}
              </fieldset>
            )}
          </div>
        )}

        <DialogFooter>
          <Button type="button" variant="outline" disabled={pending} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            type="button"
            disabled={pending || !quoteId || !supplierId}
            onClick={() => onConfirm({ quoteId, supplierId })}
          >
            {pending ? 'Awarding...' : 'Award Project'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
