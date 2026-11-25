import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { FileSpreadsheet } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { fetchAllRows } from '@/lib/fetchAll'
import { ListSkeleton } from '@/components/ui/skeleton'
import { useProfileDirectory } from '@/features/account/useProfileDirectory'
import type { QuoteDetail } from '@/features/projects/useProjectDetail'
import { compareDoors, type DoorRecord } from '@/features/projects/doorChanges'
import { DoorChangesSummary } from '@/features/projects/DoorChangesSummary'

interface UploadRow {
  id: string
  original_filename: string
  uploaded_by: string
  created_at: string
  parse_report: { variationRows?: Array<{ row: number; qty: number | null }> } | null
}

type StoredDoor = DoorRecord & { upload_id: string }

const when = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' })

/**
 * Each builder quote's quotation uploads, newest first, with the doors added,
 * removed and changed since the upload before it. For the PM (who can't upload)
 * as well as the estimators.
 */
export function QuotationUploadsPanel({ quotes }: { quotes: QuoteDetail[] }) {
  const { byId: people } = useProfileDirectory()

  // Uploads per quote, oldest first (a version copied from another keeps its upload).
  const uploadIdsByQuote = useMemo(() => {
    const m = new Map<string, string[]>()
    for (const q of quotes) {
      const ids: string[] = []
      for (const v of [...q.versions].sort((a, b) => a.version_no - b.version_no)) {
        if (v.upload_id && !ids.includes(v.upload_id)) ids.push(v.upload_id)
      }
      m.set(q.id, ids)
    }
    return m
  }, [quotes])
  const allIds = useMemo(() => [...uploadIdsByQuote.values()].flat(), [uploadIdsByQuote])

  const query = useQuery({
    queryKey: ['quotation-uploads', allIds],
    enabled: allIds.length > 0,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('quotation_uploads')
        .select('id, original_filename, uploaded_by, created_at, parse_report')
        .in('id', allIds)
      if (error) throw error
      const doors = await fetchAllRows<StoredDoor>((from, to) =>
        supabase
          .from('quotation_doors')
          .select('upload_id, door_ref, room_name, classification, leaf, door_size, qty, source_row, id')
          .in('upload_id', allIds)
          .order('upload_id')
          .order('source_row')
          .order('id')
          .range(from, to),
      )
      return { uploads: (Array.isArray(data) ? data : []) as UploadRow[], doors }
    },
  })

  const byQuote = useMemo(() => {
    if (!query.data) return []
    const uploads = new Map(query.data.uploads.map((u) => [u.id, u]))
    const doorsOf = new Map<string, DoorRecord[]>()
    for (const d of query.data.doors) {
      const v = new Set((uploads.get(d.upload_id)?.parse_report?.variationRows ?? []).map((x) => x.row))
      const list = doorsOf.get(d.upload_id) ?? []
      list.push({ ...d, variation: v.has(d.source_row) })
      doorsOf.set(d.upload_id, list)
    }
    return quotes
      .map((q) => {
        const ids = (uploadIdsByQuote.get(q.id) ?? []).filter((id) => uploads.has(id))
        const items = ids.map((id, i) => {
          const doors = doorsOf.get(id) ?? []
          return {
            upload: uploads.get(id)!,
            doorQty: doors.reduce((n, d) => n + Number(d.qty), 0),
            variationQty: doors.filter((d) => d.variation).reduce((n, d) => n + Number(d.qty), 0),
            changes: i > 0 ? compareDoors(doorsOf.get(ids[i - 1]) ?? [], doors) : null,
          }
        })
        return { quote: q, items: items.reverse() }
      })
      .filter((x) => x.items.length > 0)
  }, [query.data, quotes, uploadIdsByQuote])

  if (allIds.length === 0) return null

  return (
    <section className="border border-neutral-200 bg-white p-4 space-y-3" data-testid="quotation-uploads">
      <div>
        <h2 className="text-sm font-semibold text-neutral-950">Quotation Uploads</h2>
        <p className="text-xs text-neutral-600">
          Each upload compared with the one before it: doors added (green variation rows marked), removed and changed.
        </p>
      </div>
      {query.isLoading ? (
        <ListSkeleton rows={3} />
      ) : query.isError ? (
        <div className="text-xs text-red-700">Couldn&apos;t load the uploads.</div>
      ) : (
        byQuote.map(({ quote, items }) => (
          <div key={quote.id} className="space-y-2">
            {quotes.length > 1 && (
              <div className="text-xs font-semibold uppercase tracking-wider text-neutral-500">{quote.builder_name}</div>
            )}
            {items.map(({ upload, doorQty, variationQty, changes }) => (
              <div key={upload.id} className="border border-neutral-200 p-3 space-y-2">
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-xs">
                  <span className="flex items-center gap-1.5 font-medium text-neutral-950">
                    <FileSpreadsheet className="h-3.5 w-3.5" aria-hidden />
                    {upload.original_filename}
                  </span>
                  <span className="text-neutral-500">
                    {when(upload.created_at)}
                    {people.get(upload.uploaded_by)?.full_name ? ` · ${people.get(upload.uploaded_by)!.full_name}` : ''}
                  </span>
                  <span className="font-mono text-neutral-700">{doorQty} doors</span>
                  {variationQty > 0 && (
                    <span className="border border-green-700 bg-green-50 px-1 text-[11px] font-semibold text-green-800">
                      {variationQty} added in variation
                    </span>
                  )}
                </div>
                {changes ? (
                  <DoorChangesSummary changes={changes} />
                ) : (
                  <div className="text-xs text-neutral-500">First upload.</div>
                )}
              </div>
            ))}
          </div>
        ))
      )}
    </section>
  )
}
