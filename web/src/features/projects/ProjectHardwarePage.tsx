import { useCallback, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { ArrowLeft, GitBranch, Upload } from 'lucide-react'
import { projectDisplayName } from '@/lib/projectName'
import { ProjectGridPanel } from '@/features/projects/ProjectGridPanel'
import { VersionsDiffDialog } from '@/features/projects/VersionsDiffDialog'
import { ApprovalBar } from '@/features/projects/ApprovalBar'
import { QuotationImportWizard } from '@/features/projects/QuotationImportWizard'
import { canReviseFrom } from '@/features/projects/versionActions'
import { useProjectDetail } from '@/features/projects/useProjectDetail'
import { Button } from '@/components/ui/button'

/**
 * The project's hardware schedule: the Excel-like grid with its versions,
 * re-import, approval workflow and export. Project details and the team are
 * on the project overview (ProjectDetailPage).
 */
export function ProjectHardwarePage() {
  const { id } = useParams<{ id: string }>()
  const {
    projectQuery,
    project,
    versions,
    isProjectPm,
    canEditContent,
    canReview,
    needsQuotation,
    draftVersion,
  } = useProjectDetail(id)

  const [versionsOpen, setVersionsOpen] = useState(false)
  const [selectedVersionId, setSelectedVersionId] = useState<string | null>(null)
  const [reimportOpen, setReimportOpen] = useState(false)
  const [reimportError, setReimportError] = useState<string | null>(null)

  // The grid registers a "save pending edits now" function; Submit and
  // Re-import wait on it (B6).
  const savePendingRef = useRef<(() => Promise<boolean>) | null>(null)
  const registerSavePending = useCallback((fn: (() => Promise<boolean>) | null) => {
    savePendingRef.current = fn
  }, [])
  const savePendingEdits = useCallback(
    () => (savePendingRef.current ? savePendingRef.current() : Promise.resolve(true)),
    [],
  )

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
        Loading hardware schedule...
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

  if (needsQuotation) {
    return (
      <div className="space-y-6">
        {backToOverview}
        <div className="border border-dashed border-neutral-300 bg-neutral-50 p-8 text-center space-y-2">
          <div className="text-sm font-medium text-neutral-950">
            {displayName} has no hardware schedule yet
          </div>
          <p className="text-xs text-neutral-600">
            The quotation is uploaded from the project overview.
          </p>
        </div>
      </div>
    )
  }

  const activeVersion =
    versions.find((v) => v.id === selectedVersionId) ?? draftVersion ?? versions[0] ?? null

  // Re-import: into the draft if there is one, otherwise as the next revision
  // of an approved / changes-requested latest version. Not while under review.
  const reimportBase = draftVersion ?? versions[0] ?? null
  const nextVersionNo = Math.max(0, ...versions.map((v) => v.version_no)) + 1
  const canReimport =
    canEditContent &&
    !versions.some((v) => v.status === 'submitted') &&
    reimportBase !== null &&
    (reimportBase.status === 'draft' || canReviseFrom(reimportBase.status))

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
    setReimportOpen(true)
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3 min-w-0">
          {backToOverview}
          <h1 className="text-lg font-bold tracking-tight text-neutral-950 truncate">
            {displayName}
          </h1>
        </div>

        <div className="flex flex-wrap items-center gap-2">
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
          {canReimport && !reimportOpen && (
            <Button variant="outline" size="sm" onClick={() => void openReimport()}>
              <Upload className="h-3.5 w-3.5" />
              <span>Re-import Quotation</span>
            </Button>
          )}
        </div>
      </div>

      {reimportOpen && reimportBase ? (
        <QuotationImportWizard
          mode="reimport"
          projectId={project.id}
          projectName={displayName}
          baseVersion={reimportBase}
          nextVersionNo={nextVersionNo}
          onCancel={() => setReimportOpen(false)}
          onDone={(vid) => {
            setReimportOpen(false)
            setSelectedVersionId(vid)
          }}
        />
      ) : (
        <>
          {reimportError && (
            <div
              role="alert"
              className="border border-neutral-950 bg-neutral-50 p-3 text-xs text-neutral-950"
            >
              {reimportError}
            </div>
          )}

          <ApprovalBar
            projectId={project.id}
            versions={versions}
            activeVersion={activeVersion}
            onVersionCreated={(vid) => setSelectedVersionId(vid)}
            canEditContent={canEditContent}
            canReview={canReview}
            savePendingEdits={savePendingEdits}
          />

          <ProjectGridPanel
            projectName={displayName}
            builderName={project.client}
            activeVersion={activeVersion}
            canEdit={canEditContent}
            canEditPmRemarks={isProjectPm}
            onRegisterSavePending={registerSavePending}
          />
        </>
      )}

      <VersionsDiffDialog
        open={versionsOpen}
        onOpenChange={setVersionsOpen}
        projectId={project.id}
        versions={versions}
        selectedVersionId={activeVersion?.id ?? null}
        onSelectVersion={(vid) => setSelectedVersionId(vid)}
        canEdit={canEditContent}
      />
    </div>
  )
}
