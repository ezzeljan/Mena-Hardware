import { useMemo, useState, type ReactNode } from 'react'
import { useInfiniteQuery } from '@tanstack/react-query'
import {
  ArrowRight,
  Check,
  FilePlus2,
  FileSpreadsheet,
  Flag,
  FolderPlus,
  GitBranch,
  History,
  MessageSquare,
  Pencil,
  Percent,
  Send,
  Undo2,
  UserMinus,
  UserPlus,
  type LucideIcon,
  Trash2,
} from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { ListSkeleton } from '@/components/ui/skeleton'
import type { ActivityCategory, ProjectActivity } from '@/types/database'
import { useProfileDirectory } from '@/features/account/useProfileDirectory'
import { UserAvatar } from '@/components/avatar/UserAvatar'

const PAGE_SIZE = 30

type FilterKey = 'all' | 'project' | 'versions' | 'hardware'

const FILTERS: { key: FilterKey; label: string; categories: ActivityCategory[] | null }[] = [
  { key: 'all', label: 'All', categories: null },
  { key: 'project', label: 'Project & Team', categories: ['project', 'team'] },
  { key: 'versions', label: 'Quotation & Versions', categories: ['quotation', 'version'] },
  { key: 'hardware', label: 'Hardware edits', categories: ['hardware'] },
]

const CATEGORY_LABEL: Record<ActivityCategory, string> = {
  project: 'Project',
  team: 'Team',
  quotation: 'Quotation',
  version: 'Version',
  hardware: 'Hardware',
}

/** Icon and colour of the small badge on each entry's avatar. */
const ACTION_ICON: Record<string, { icon: LucideIcon; tone: string }> = {
  project_created: { icon: FolderPlus, tone: 'bg-neutral-900 text-white' },
  details_changed: { icon: Pencil, tone: 'bg-neutral-500 text-white' },
  stage_changed: { icon: Flag, tone: 'bg-emerald-600 text-white' },
  pm_assigned: { icon: UserPlus, tone: 'bg-violet-600 text-white' },
  estimator_added: { icon: UserPlus, tone: 'bg-violet-600 text-white' },
  estimator_removed: { icon: UserMinus, tone: 'bg-neutral-500 text-white' },
  quotation_imported: { icon: FilePlus2, tone: 'bg-sky-600 text-white' },
  quotation_reimported: { icon: FileSpreadsheet, tone: 'bg-sky-600 text-white' },
  quote_deleted: { icon: Trash2, tone: 'bg-red-600 text-white' },
  revision_started: { icon: GitBranch, tone: 'bg-neutral-700 text-white' },
  version_submitted: { icon: Send, tone: 'bg-blue-600 text-white' },
  version_approved: { icon: Check, tone: 'bg-emerald-600 text-white' },
  version_changes_requested: { icon: Undo2, tone: 'bg-amber-500 text-white' },
  lines_edited: { icon: Pencil, tone: 'bg-neutral-500 text-white' },
  markup_changed: { icon: Percent, tone: 'bg-neutral-500 text-white' },
  pm_remarks_updated: { icon: MessageSquare, tone: 'bg-neutral-500 text-white' },
  comment_added: { icon: MessageSquare, tone: 'bg-indigo-600 text-white' },
}

const STATUS_CHIP: Record<string, { label: string; tone: string }> = {
  draft: { label: 'Draft', tone: 'bg-neutral-100 text-neutral-700 border-neutral-200' },
  submitted: { label: 'Submitted', tone: 'bg-blue-50 text-blue-700 border-blue-200' },
  approved: { label: 'Approved', tone: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
  changes_requested: { label: 'Changes requested', tone: 'bg-amber-50 text-amber-800 border-amber-200' },
  superseded: { label: 'Superseded', tone: 'bg-neutral-100 text-neutral-500 border-neutral-200' },
  active: { label: 'Active', tone: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
  archived: { label: 'Archived', tone: 'bg-neutral-100 text-neutral-600 border-neutral-200' },
  tender: { label: 'Tender', tone: 'bg-amber-50 text-amber-800 border-amber-200' },
  awarded: { label: 'Awarded', tone: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
}

function fetchActivityPage(projectId: string, categories: ActivityCategory[] | null, offset: number) {
  let query = supabase
    .from('project_activity')
    .select('id, project_id, version_id, actor_id, category, action, summary, details, created_at, updated_at')
    .eq('project_id', projectId)
    .order('updated_at', { ascending: false })
    .order('id', { ascending: false })
    .range(offset, offset + PAGE_SIZE - 1)
  if (categories) query = query.in('category', categories)
  return query
}

// ---------------------------------------------------------------------------
// Date and time helpers
// ---------------------------------------------------------------------------
function dayKey(iso: string) {
  const d = new Date(iso)
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`
}

function dayLabel(iso: string) {
  const d = new Date(iso)
  const today = new Date()
  const yesterday = new Date()
  yesterday.setDate(today.getDate() - 1)
  const full = d.toLocaleDateString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    ...(d.getFullYear() !== today.getFullYear() ? { year: 'numeric' } : {}),
  })
  if (dayKey(iso) === dayKey(today.toISOString())) return { lead: 'Today', full }
  if (dayKey(iso) === dayKey(yesterday.toISOString())) return { lead: 'Yesterday', full }
  return { lead: null, full }
}

function timeText(iso: string) {
  return new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
}

function fullDateTime(iso: string) {
  return new Date(iso).toLocaleString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

function relativeTime(iso: string) {
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`
  const days = Math.round(hours / 24)
  return `${days} day${days === 1 ? '' : 's'} ago`
}

// ---------------------------------------------------------------------------
// Detail box pieces
// ---------------------------------------------------------------------------
function Chip({ children, tone }: { children: ReactNode; tone: string }) {
  return (
    <span className={`inline-flex max-w-full items-center truncate rounded border px-1.5 py-0.5 text-[11px] font-medium ${tone}`}>
      {children}
    </span>
  )
}

const PLAIN_CHIP = 'bg-white text-neutral-800 border-neutral-200'

function valueChip(value: unknown, asStatus = false) {
  if (value === null || value === undefined || value === '') {
    return <Chip tone="bg-white text-neutral-400 border-neutral-200">empty</Chip>
  }
  const text = String(value)
  if (asStatus && STATUS_CHIP[text]) {
    return <Chip tone={STATUS_CHIP[text].tone}>{STATUS_CHIP[text].label}</Chip>
  }
  return <Chip tone={PLAIN_CHIP}>{text}</Chip>
}

function FromTo({ label, from, to, asStatus }: { label?: string; from: unknown; to: unknown; asStatus?: boolean }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {label && <span className="text-[11px] text-neutral-500">{label}</span>}
      {valueChip(from, asStatus)}
      <ArrowRight className="h-3 w-3 shrink-0 text-neutral-400" />
      {valueChip(to, asStatus)}
    </div>
  )
}

function plural(n: number, word: string) {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}

/** The lines of the grey box under an entry (empty when there is nothing more to show). */
function activityDetailParts(entry: ProjectActivity): ReactNode[] {
  const d = entry.details ?? {}
  const parts: ReactNode[] = []

  switch (entry.action) {
    case 'details_changed': {
      const changes = (d.changes as { label: string; from: unknown; to: unknown }[] | undefined) ?? []
      changes.forEach((c) =>
        parts.push(<FromTo key={c.label} label={c.label} from={c.from} to={c.to} asStatus={c.label === 'Status'} />),
      )
      break
    }
    case 'stage_changed':
      parts.push(<FromTo key="stage" from={d.from} to={d.to} asStatus />)
      break
    case 'pm_assigned':
      if (d.from) parts.push(<FromTo key="pm" from={d.from} to={d.to} />)
      break
    case 'quotation_imported':
    case 'quotation_reimported':
      if (d.file) {
        parts.push(
          <div key="file" className="flex items-center gap-1.5 text-xs text-neutral-700">
            <FileSpreadsheet className="h-3.5 w-3.5 shrink-0 text-neutral-500" />
            <span className="truncate font-medium">{String(d.file)}</span>
            {typeof d.door_groups === 'number' && (
              <span className="shrink-0 text-neutral-500">· {plural(d.door_groups, 'door group')}</span>
            )}
          </div>,
        )
      }
      break
    case 'version_submitted':
    case 'version_approved':
    case 'version_changes_requested':
      parts.push(<FromTo key="status" from={d.from} to={d.to} asStatus />)
      break
    case 'lines_edited': {
      const counts = [
        Number(d.edited ?? 0) > 0 ? `${plural(Number(d.edited), 'change')}` : null,
        Number(d.added ?? 0) > 0 ? `${Number(d.added)} added` : null,
        Number(d.removed ?? 0) > 0 ? `${Number(d.removed)} removed` : null,
      ].filter(Boolean)
      if (counts.length) parts.push(<div key="counts" className="text-xs text-neutral-700">{counts.join(' · ')}</div>)
      break
    }
    case 'markup_changed':
      parts.push(
        <FromTo
          key="markup"
          label="Markup"
          from={d.from != null ? `${Number(d.from)}%` : null}
          to={d.to != null ? `${Number(d.to)}%` : null}
        />,
      )
      break
    case 'pm_remarks_updated':
      parts.push(<FromTo key="remarks" from={d.from} to={d.to} />)
      break
  }

  if (typeof d.comment === 'string' && d.comment.trim()) {
    parts.push(
      <p key="comment" className="whitespace-pre-wrap text-xs leading-relaxed text-neutral-800">
        “{d.comment}”
      </p>,
    )
  }

  return parts
}

/** Summary text with version numbers ("v2") emphasised. */
function SummaryText({ text }: { text: string }) {
  const pieces = text.split(/(\bv\d+\b)/g)
  return (
    <>
      {pieces.map((piece, i) =>
        /^v\d+$/.test(piece) ? (
          <span key={i} className="font-mono font-semibold text-neutral-950">
            {piece}
          </span>
        ) : (
          <span key={i}>{piece}</span>
        ),
      )}
    </>
  )
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------
interface ProjectActivityPanelProps {
  projectId: string
  className?: string
}

/**
 * Timeline of everything that happened on a project: who did it and when.
 * Entries come from database triggers (project_activity, migration 016).
 */
export function ProjectActivityPanel({ projectId, className = '' }: ProjectActivityPanelProps) {
  const [filter, setFilter] = useState<FilterKey>('all')
  const [hidden, setHidden] = useState<Set<string>>(() => new Set())
  const { byId } = useProfileDirectory()
  const categories = FILTERS.find((f) => f.key === filter)?.categories ?? null

  // Starts with ['project', id] so anything that refreshes the project refreshes this too.
  const activityQuery = useInfiniteQuery({
    queryKey: ['project', projectId, 'activity', filter],
    initialPageParam: 0,
    refetchInterval: 30_000,
    queryFn: async ({ pageParam }) => {
      const { data, error } = await fetchActivityPage(projectId, categories, pageParam)
      if (error) throw error
      return (data ?? []) as ProjectActivity[]
    },
    getNextPageParam: (lastPage, allPages) =>
      lastPage.length < PAGE_SIZE ? undefined : allPages.reduce((n, page) => n + page.length, 0),
  })

  const entries = useMemo(() => {
    const seen = new Set<string>()
    return (activityQuery.data?.pages ?? []).flat().filter((e) => {
      if (seen.has(e.id)) return false
      seen.add(e.id)
      return true
    })
  }, [activityQuery.data])

  const days = useMemo(() => {
    const groups: { key: string; first: string; items: ProjectActivity[] }[] = []
    for (const entry of entries) {
      const key = dayKey(entry.updated_at)
      const last = groups[groups.length - 1]
      if (last && last.key === key) last.items.push(entry)
      else groups.push({ key, first: entry.updated_at, items: [entry] })
    }
    return groups
  }, [entries])

  const toggleHidden = (id: string) =>
    setHidden((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  return (
    <section
      className={`flex max-h-[32rem] flex-col rounded-md border border-neutral-300 bg-white ${className}`}
      aria-label="Project activity"
      data-testid="project-activity"
    >
      <div className="flex items-center gap-2 border-b border-neutral-200 px-4 py-3">
        <History className="h-4 w-4 text-neutral-500" />
        <h2 className="text-sm font-semibold text-neutral-950">Activities</h2>
      </div>

      <div className="flex flex-wrap gap-1.5 border-b border-neutral-200 px-4 py-2.5" role="tablist" aria-label="Filter activity">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            type="button"
            role="tab"
            aria-selected={filter === f.key}
            onClick={() => setFilter(f.key)}
            className={`rounded-full border px-2.5 py-0.5 text-[11px] font-medium transition-colors ${
              filter === f.key
                ? 'border-neutral-950 bg-neutral-950 text-white'
                : 'border-neutral-200 bg-white text-neutral-600 hover:border-neutral-400 hover:text-neutral-900'
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {activityQuery.isLoading ? (
          <ListSkeleton rows={4} label="Loading activity…" className="border-0" />
        ) : activityQuery.isError ? (
          <p className="py-6 text-center text-xs text-red-700">Could not load the activity.</p>
        ) : entries.length === 0 ? (
          <p className="py-6 text-center text-xs text-neutral-500">No activity yet.</p>
        ) : (
          <div className="space-y-4">
            {days.map((day) => {
              const label = dayLabel(day.first)
              return (
                <div key={day.key}>
                  <div className="mb-2 flex items-center gap-2 text-[11px] text-neutral-500">
                    {label.lead && <span className="font-semibold text-neutral-900">{label.lead}</span>}
                    <span>{label.full}</span>
                    <span className="h-px flex-1 bg-neutral-200" />
                  </div>
                  <ol>
                    {day.items.map((entry, index) => {
                      const actor = entry.actor_id ? byId.get(entry.actor_id) : undefined
                      const actorName = actor?.full_name?.trim() || (entry.actor_id ? 'Unknown user' : 'System')
                      const icon = ACTION_ICON[entry.action] ?? { icon: History, tone: 'bg-neutral-500 text-white' }
                      const Icon = icon.icon
                      const isLast = index === day.items.length - 1
                      const spansTime =
                        new Date(entry.updated_at).getTime() - new Date(entry.created_at).getTime() > 60_000
                      const isHidden = hidden.has(entry.id)
                      const detailParts = activityDetailParts(entry)
                      const hasDetails = detailParts.length > 0
                      return (
                        <li key={entry.id} className="relative flex gap-3 pb-4" data-testid="activity-entry">
                          {!isLast && (
                            <span className="absolute left-3 top-7 bottom-0 w-px bg-neutral-200" aria-hidden="true" />
                          )}
                          <span className="relative shrink-0">
                            <UserAvatar name={actorName} url={actor?.avatar_url} size="sm" />
                            <span
                              className={`absolute -right-1 -bottom-1 flex h-3.5 w-3.5 items-center justify-center rounded-full ring-2 ring-white ${icon.tone}`}
                              aria-hidden="true"
                            >
                              <Icon className="h-2 w-2" strokeWidth={3} />
                            </span>
                          </span>
                          <div className="min-w-0 flex-1">
                            <p className="text-xs leading-snug text-neutral-700">
                              <span className="font-semibold text-neutral-950">{actorName}</span>{' '}
                              <SummaryText text={entry.summary} />
                            </p>
                            <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-neutral-500">
                              <time
                                dateTime={entry.updated_at}
                                title={`${fullDateTime(entry.updated_at)} (${relativeTime(entry.updated_at)})`}
                              >
                                {spansTime ? `${timeText(entry.created_at)} – ` : ''}
                                {timeText(entry.updated_at)}
                              </time>
                              <span aria-hidden="true">·</span>
                              <span>{CATEGORY_LABEL[entry.category] ?? entry.category}</span>
                              {hasDetails && (
                                <>
                                  <span aria-hidden="true">·</span>
                                  <button
                                    type="button"
                                    onClick={() => toggleHidden(entry.id)}
                                    className="font-medium text-neutral-600 underline-offset-2 hover:text-neutral-950 hover:underline"
                                  >
                                    {isHidden ? 'Show' : 'Hide'}
                                  </button>
                                </>
                              )}
                            </div>
                            {hasDetails && !isHidden && (
                              <div className="mt-2 space-y-1.5 rounded-md bg-neutral-100 px-3 py-2">{detailParts}</div>
                            )}
                          </div>
                        </li>
                      )
                    })}
                  </ol>
                </div>
              )
            })}

            {activityQuery.hasNextPage && (
              <div className="pt-1 text-center">
                <button
                  type="button"
                  onClick={() => activityQuery.fetchNextPage()}
                  disabled={activityQuery.isFetchingNextPage}
                  className="rounded-md border border-neutral-300 px-3 py-1 text-xs font-medium text-neutral-700 hover:bg-neutral-50 disabled:opacity-60"
                >
                  {activityQuery.isFetchingNextPage ? 'Loading...' : 'Show more'}
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  )
}
