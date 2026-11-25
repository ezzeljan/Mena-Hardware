import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/features/auth/AuthContext'
import type { HardwareQuote, Project, ProjectEstimator, ProjectVersion } from '@/types/database'

export interface ProjectDetail extends Project {
  hardware_quotes?: HardwareQuote[]
  project_versions?: ProjectVersion[]
  project_estimators?: ProjectEstimator[]
}

/** A builder quote with its versions (newest first). */
export interface QuoteDetail extends HardwareQuote {
  versions: ProjectVersion[]
  latestVersion: ProjectVersion | null
  draftVersion: ProjectVersion | null
  /** No quotation imported yet (an unfinished v1 without an upload). */
  needsQuotation: boolean
  /** The project was awarded to this quote. */
  isWinner: boolean
  /** The project was awarded to another quote: read-only (mirrors quote_is_locked). */
  locked: boolean
}

export const PROJECT_DETAIL_COLUMNS =
  'id, reference_no, name, client, site, status, stage, awarded_quote_id, awarded_supplier_id, created_by, assigned_pm, created_at, updated_at, hardware_quotes!hardware_quotes_project_id_fkey(id, project_id, builder_name, created_by, created_at, updated_at), project_versions(id, project_id, quote_id, version_no, status, upload_id, markup_pct, created_by, submitted_at, created_at, updated_at), project_estimators(project_id, estimator_id, assigned_by, created_at)'

/**
 * Loads a project with its builder quotes, versions and estimators, and works
 * out what the signed-in user may do on it. Shared by the project overview and
 * the hardware page so both apply the same rules (these mirror the RLS helpers
 * in migrations 010 and 021).
 */
export function useProjectDetail(id: string | undefined) {
  const { user, role, isAdmin } = useAuth()

  const projectQuery = useQuery({
    queryKey: ['project', id],
    enabled: !!id,
    queryFn: async (): Promise<ProjectDetail> => {
      const { data, error } = await supabase
        .from('projects')
        .select(PROJECT_DETAIL_COLUMNS)
        .eq('id', id!)
        .single()
      if (error) throw error
      return data as unknown as ProjectDetail
    },
  })

  const project = projectQuery.data ?? null

  const quotes = useMemo<QuoteDetail[]>(() => {
    if (!project) return []
    const awardedTo = project.stage === 'awarded' ? project.awarded_quote_id : null
    return [...(project.hardware_quotes ?? [])]
      .sort((a, b) => a.created_at.localeCompare(b.created_at))
      .map((q) => {
        const versions = (project.project_versions ?? [])
          .filter((v) => v.quote_id === q.id)
          .sort((a, b) => b.version_no - a.version_no)
        const latestVersion = versions[0] ?? null
        return {
          ...q,
          versions,
          latestVersion,
          draftVersion: versions.find((v) => v.status === 'draft') ?? null,
          needsQuotation:
            versions.length === 0 ||
            (versions.length === 1 && versions[0].status === 'draft' && !versions[0].upload_id),
          isWinner: awardedTo === q.id,
          locked: awardedTo !== null && awardedTo !== q.id,
        }
      })
  }, [project])

  const estimators = useMemo(() => project?.project_estimators ?? [], [project])

  const isProjectPm = role === 'pm' && !!user && !!project && project.assigned_pm === user.id
  const isAssignedEstimator =
    role === 'estimator' && !!user && estimators.some((e) => e.estimator_id === user.id)

  /** Quotation, matching, line edits, sheets, submit, revisions. */
  const canEditContent = isAdmin || isAssignedEstimator
  /** Approve / request changes, manage the team, award. */
  const canReview = isAdmin || isProjectPm
  /** Edit project details. */
  const canEditInfo = isAdmin || isProjectPm
  /** New builder quotes only at Tender. */
  const canAddQuote = canEditContent && project?.stage !== 'awarded'

  return {
    projectQuery,
    project,
    quotes,
    estimators,
    isAdmin,
    isProjectPm,
    isAssignedEstimator,
    canEditContent,
    canReview,
    canEditInfo,
    canAddQuote,
    /** No builder quote has an imported quotation yet. */
    needsQuotation: quotes.every((q) => q.needsQuotation),
  }
}
