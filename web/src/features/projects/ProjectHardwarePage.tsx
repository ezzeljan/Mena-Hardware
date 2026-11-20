import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { ArrowLeft, GitBranch, Lock, MessageSquare, Trophy, Upload } from 'lucide-react'
import { projectDisplayName } from '@/lib/projectName'
import { ProjectGridPanel } from '@/features/projects/ProjectGridPanel'
import { SheetTabs } from '@/features/projects/SheetTabs'
import { VersionsDiffDialog } from '@/features/projects/VersionsDiffDialog'
import { ApprovalBar } from '@/features/projects/ApprovalBar'
import { canReviseFrom } from '@/features/projects/versionActions'
import { useProjectDetail } from '@/features/projects/useProjectDetail'
import { fetchVersionGroups, fetchVersionSheets } from '@/features/projects/projectData'
import {
  VersionCommentsDrawer,
  commentCountsByGroup,
  useVersionComments,
  type CommentFilter,
} from '@/features/projects/VersionCommentsDrawer'
import { Button } from '@/components/ui/button'

/**
 * One builder quote of a project: the Excel-like grid with a tab per supplier
 * sheet, its versions, re-import, approval workflow and export. Which quote:
 * ?quote=<id>, or the quote of ?version=<id> (notification links), else the
 * first quote. Project details and the team are on the overview.
 */
export function ProjectHardwarePage() {
  const { id } = useParams<{ id: string }>()
  const { projectQuery, project, quotes, canEditContent, canReview } = useProjectDetail(id)
  const [searchParams, setSearchParams] = useSearchParams()
  const navigate = useNavigate()

  const [versionsOpen, setVersionsOpen] = useState(false)
  const [selectedVersionId, setSelectedVersionId] = useState<string | null>(
    searchParams.get('version'),
  )
  const [reimportError, setReimportError] = useState<string | null>(null)
  // PM comments drawer (?comments=open&version=… opens it, e.g. from a notification).
  const [commentsOpen, setCommentsOpen] = useState(searchParams.get('comments') === 'open')
  const [commentFilter, setCommentFilter] = useState<CommentFilter>('all')
  const [highlightGroupId, setHighlightGroupId] = useState<string | null>(null)
  // Active sheet; the supplier is remembered so switching versions keeps the same tab.
  const [activeSheet, setActiveSheet] = useState<{ id: string; supplierId: string } | null>(null)

  // Which quote: ?quote, else the quote of the linked / selected version, else the first imported one.
  const quoteParam = searchParams.get('quote')
  const activeQuote = useMemo(() => {
    const byParam = quotes.find((q) => q.id === quoteParam)
    if (byParam) return byParam
    const byVersion = quotes.find((q) => q.versions.some((v) => v.id === selectedVersionId))
    return byVersion ?? quotes.find((q) => !q.needsQuotation) ?? quotes[0] ?? null
  }, [quotes, quoteParam, selectedVersionId])

  // Keep ?quote in the URL; drop the one-off notification parameters.
  useEffect(() => {
    if (!activeQuote) return
    const next = new URLSearchParams(searchParams)
    let changed = false
    if (next.get('quote') !== activeQuote.id) {
      next.set('quote', activeQuote.id)
      changed = true
    }
    for (const key of ['comments', 'version']) {
      if (next.has(key)) {
        next.delete(key)
        changed = true
      }
    }
    if (changed) setSearchParams(next, { replace: true })
  }, [activeQuote, searchParams, setSearchParams])

  useEffect(() => {
    if (!highlightGroupId) return
    const timer = setTimeout(() => setHighlightGroupId(null), 2500)
    return () => clearTimeout(timer)
  }, [highlightGroupId])

  // The grid registers a "save pending edits now" function; Submit, Re-import
  // and Add sheet wait on it (B6).
  const savePendingRef = useRef<(() => Promise<boolean>) | null>(null)
  const registerSavePending = useCallback((fn: (() => Promise<boolean>) | null) => {
    savePendingRef.current = fn
  }, [])
  const savePendingEdits = useCallback(
    () => (savePendingRef.current ? savePendingRef.current() : Promise.resolve(true)),
    [],
  )

  const versions = useMemo(() => activeQuote?.versions ?? [], [activeQuote])
  const draftVersion = activeQuote?.draftVersion ?? null
  const activeVersion =
    versions.find((v) => v.id === selectedVersionId) ?? draftVersion ?? versions[0] ?? null

  const sheetsQuery = useQuery({
    queryKey: ['quote_sheets', activeVersion?.id],
    enabled: !!activeVersion?.id,
    queryFn: () => fetchVersionSheets(activeVersion!.id),
  })
  const sheets = useMemo(() => sheetsQuery.data ?? [], [sheetsQuery.data])
  const currentSheet =
    sheets.find((s) => s.id === activeSheet?.id) ??
    sheets.find((s) => s.supplier_id === activeSheet?.supplierId) ??
    sheets[0] ??
    null

  // PM comments on the selected version (hooks stay above the early returns).
  const commentsQuery = useVersionComments(activeVersion?.id)
  const sheetComments = useMemo(
    () => (commentsQuery.data ?? []).filter((c) => !c.sheet_id || c.sheet_id === currentSheet?.id),
    [commentsQuery.data, currentSheet?.id],
  )
  const commentCounts = commentCountsByGroup(sheetComments)
  const commentCountsBySheet = useMemo(() => {
    const map = new Map<string, number>()
    for (const c of commentsQuery.data ?? []) {
      if (c.sheet_id) map.set(c.sheet_id, (map.get(c.sheet_id) ?? 0) + 1)
    }
    return map
  }, [commentsQuery.data])
  const commentTotal = commentsQuery.data?.length ?? 0
  // Same query as the grid's, so this shares its cache.
  const groupsQuery = useQuery({
    queryKey: ['door_groups', activeVersion?.id],
    enabled: !!activeVersion?.id,
    queryFn: () => fetchVersionGroups(activeVersion!.id),
  })

  const backToOverview = (
    <Button variant="outline" size="sm" asChild>
      <Link to={`/projects/${id}`}>
        <ArrowLeft className="h-3.5 w-3.5" />
        <span>Project overview</span>
      </Link>
    </Button>
  )

  if (projectQuery.isLoading) {
    return (
      <div className="border border-neutral-200 p-10 text-center text-sm text-neutral-600">
        Loading hardware quote...
      </div>
    )
  }

  if (projectQuery.isError || !project) {
    return (
      <div className="space-y-4">
        <Button variant="outline" size="sm" asChild>
          <Link to="/projects">
            <ArrowLeft className="h-3.5 w-3.5" />
            <span>Back to Projects</span>
          </Link>
        </Button>
        <div
          role="alert"
          className="border border-neutral-950 bg-neutral-50 p-6 text-sm text-neutral-950"
        >
          Project not found or failed to load.
        </div>
      </div>
    )
  }

  const displayName = projectDisplayName(project)

  if (!activeQuote || activeQuote.needsQuotation) {
    return (
      <div className="space-y-6">
        {backToOverview}
        <div className="border border-dashed border-neutral-300 bg-neutral-50 p-8 text-center space-y-2">
          <div className="text-sm font-medium text-neutral-950">
            {displayName} has no hardware quote yet
          </div>
          <p className="text-xs text-neutral-600">
            Builder quotes are added from the project overview (New Quote).
          </p>
        </div>
      </div>
    )
  }

  const locked = activeQuote.locked
  const canEditQuote = canEditContent && !locked

  // Re-import: into the draft if there is one, otherwise as the next revision
  // of an approved / changes-requested latest version. Not while under review.
  const reimportBase = draftVersion ?? versions[0] ?? null
  const canReimport =
    canEditQuote &&
    !versions.some((v) => v.status === 'submitted') &&
    reimportBase !== null &&
    (reimportBase.status === 'draft' || canReviseFrom(reimportBase.status))

  const openComments = (filter: CommentFilter = 'all') => {
    setCommentFilter(filter)
    setCommentsOpen(true)
  }

  const selectQuote = (quoteId: string) => {
    setSelectedVersionId(null)
    const next = new URLSearchParams(searchParams)
    next.set('quote', quoteId)
    setSearchParams(next)
  }

  const openReimport = async () => {
    setReimportError(null)
    // Save pending grid edits first so the re-import keeps them.
    const saved = await savePendingEdits()
    if (!saved) {
      setReimportError(
        'Some grid edits could not be saved. Fix the save error (Retry in the grid) before re-importing.',
      )
      return
    }
    // The import wizard has its own page.
    navigate(`/projects/${project.id}/import?quote=${activeQuote.id}`)
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
        <div className="flex items-center gap-3 min-w-0">
          {backToOverview}
          <div className="min-w-0">
            <h1 className="text-lg font-bold tracking-tight text-neutral-950 truncate">
              {displayName}
            </h1>
            <div className="flex flex-wrap items-center gap-2 text-xs text-neutral-600">
              {quotes.length > 1 ? (
                <select
                  aria-label="Select builder quote"
                  value={activeQuote.id}
                  onChange={(e) => selectQuote(e.target.value)}
                  className="h-7 border border-neutral-300 bg-white px-2 text-xs font-semibold text-neutral-950 focus:outline-none focus:ring-1 focus:ring-neutral-950"
                  data-testid="quote-select"
                >
                  {quotes.map((q) => (
                    <option key={q.id} value={q.id} disabled={q.needsQuotation}>
                      {q.builder_name}
                      {q.isWinner ? ' (awarded)' : ''}
                    </option>
                  ))}
                </select>
              ) : (
                <span className="font-semibold text-neutral-950">
                  Quote for {activeQuote.builder_name}
                </span>
              )}
              {activeQuote.isWinner && (
                <span className="inline-flex items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[11px] font-semibold text-emerald-700">
                  <Trophy className="h-3 w-3" />
                  Awarded
                </span>
              )}
              {locked && (
                <span className="inline-flex items-center gap-1 text-[11px] text-neutral-500">
                  <Lock className="h-3 w-3" />
                  The project was awarded to another quote; this one is read-only.
                </span>
              )}
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 xl:justify-end">
          <select
            aria-label="Select project version"
            value={activeVersion?.id ?? ''}
            onChange={(e) => setSelectedVersionId(e.target.value)}
            className="h-8 border border-neutral-300 bg-white px-2 text-xs font-mono font-semibold text-neutral-950 focus:outline-none focus:ring-1 focus:ring-neutral-950"
          >
            {versions.map((v) => (
              <option key={v.id} value={v.id}>
                v{v.version_no} ({v.status.replace('_', ' ').toUpperCase()})
              </option>
            ))}
          </select>
          <Button variant="outline" size="sm" onClick={() => setVersionsOpen(true)}>
            <GitBranch className="h-3.5 w-3.5" />
            <span>Versions &amp; Diff ({versions.length})</span>
          </Button>
          <Button
            variant={commentsOpen ? 'default' : 'outline'}
            size="sm"
            onClick={() => (commentsOpen ? setCommentsOpen(false) : openComments())}
            aria-pressed={commentsOpen}
          >
            <MessageSquare className="h-3.5 w-3.5" />
            <span>Comments ({commentTotal})</span>
          </Button>
          {canReimport && (
            <Button variant="outline" size="sm" onClick={() => void openReimport()}>
              <Upload className="h-3.5 w-3.5" />
              <span>Re-import Quotation</span>
            </Button>
          )}
          {!locked && (
            // Version status note + Submit / Approve / Request Changes / New Draft.
            <ApprovalBar
              projectId={project.id}
              versions={versions}
              activeVersion={activeVersion}
              onVersionCreated={(vid) => setSelectedVersionId(vid)}
              canEditContent={canEditContent}
              canReview={canReview}
              savePendingEdits={savePendingEdits}
            />
          )}
        </div>
      </div>

      {reimportError && (
        <div
          role="alert"
          className="border border-neutral-950 bg-neutral-50 p-3 text-xs text-neutral-950"
        >
          {reimportError}
        </div>
      )}

      <div>
        <ProjectGridPanel
          projectName={displayName}
          projectTitle={project.name}
          clientName={activeQuote.builder_name}
          activeVersion={activeVersion}
          sheet={currentSheet}
          sheets={sheets}
          canEdit={canEditQuote}
          commentCounts={commentCounts}
          onOpenComments={(groupId) => openComments(groupId)}
          highlightGroupId={highlightGroupId}
          onRegisterSavePending={registerSavePending}
        />
        {activeVersion && sheets.length > 0 && (
          <SheetTabs
            versionId={activeVersion.id}
            sheets={sheets}
            activeSheetId={currentSheet?.id ?? null}
            onSelect={(sheetId) => {
              const s = sheets.find((x) => x.id === sheetId)
              setActiveSheet({ id: sheetId, supplierId: s?.supplier_id ?? '' })
            }}
            editable={canEditQuote && activeVersion.status === 'draft'}
            commentCounts={commentCountsBySheet}
            savePendingEdits={savePendingEdits}
          />
        )}
      </div>

      <VersionCommentsDrawer
        open={commentsOpen}
        onOpenChange={setCommentsOpen}
        version={activeVersion}
        groups={groupsQuery.data ?? []}
        sheets={sheets}
        activeSheetId={currentSheet?.id ?? null}
        filter={commentFilter}
        onFilterChange={setCommentFilter}
        canComment={canReview}
        onShowGroup={(groupId) => setHighlightGroupId(groupId)}
      />

      <VersionsDiffDialog
        open={versionsOpen}
        onOpenChange={setVersionsOpen}
        projectId={project.id}
        versions={versions}
        selectedVersionId={activeVersion?.id ?? null}
        onSelectVersion={(vid) => setSelectedVersionId(vid)}
        canEdit={canEditQuote}
        activeSupplierId={currentSheet?.supplier_id ?? null}
      />
    </div>
  )
}
