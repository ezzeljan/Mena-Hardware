import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/features/auth/AuthContext'
import type { Project, ProjectEstimator, ProjectVersion } from '@/types/database'

export interface ProjectDetail extends Project {
  project_versions?: ProjectVersion[]
  project_estimators?: ProjectEstimator[]
}

/**
 * Loads a project with its versions and estimators, and works out what the
 * signed-in user may do on it. Shared by the project overview and the hardware
 * page so both apply the same rules (these mirror the RLS helpers in migration 010).
 */
export function useProjectDetail(id: string | undefined) {
  const { user, role, isAdmin } = useAuth()

  const projectQuery = useQuery({
    queryKey: ['project', id],
    enabled: !!id,
    queryFn: async (): Promise<ProjectDetail> => {
      const { data, error } = await supabase
        .from('projects')
        .select(
          'id, reference_no, name, client, site, status, created_by, assigned_pm, created_at, updated_at, project_versions(id, project_id, version_no, status, upload_id, markup_pct, created_by, submitted_at, created_at, updated_at), project_estimators(project_id, estimator_id, assigned_by, created_at)',
        )
        .eq('id', id!)
        .single()
      if (error) throw error
      return data as unknown as ProjectDetail
    },
  })

  const project = projectQuery.data ?? null

  // Newest first.
  const versions = useMemo(
    () => [...(project?.project_versions ?? [])].sort((a, b) => b.version_no - a.version_no),
    [project],
  )
  const estimators = useMemo(() => project?.project_estimators ?? [], [project])

  const isProjectPm = role === 'pm' && !!user && !!project && project.assigned_pm === user.id
  const isAssignedEstimator =
    role === 'estimator' && !!user && estimators.some((e) => e.estimator_id === user.id)

  /** Quotation, matching, line edits, submit, revisions. */
  const canEditContent = isAdmin || isAssignedEstimator
  /** Approve / request changes, manage the team. */
  const canReview = isAdmin || isProjectPm
  /** Edit project details. */
  const canEditInfo = isAdmin || isProjectPm

  // Quotation not imported yet: no versions, or only an unfinished v1 draft (no upload linked).
  const unfinishedDraft =
    versions.length === 1 && versions[0].status === 'draft' && !versions[0].upload_id
      ? versions[0]
      : null
  const needsQuotation = versions.length === 0 || unfinishedDraft !== null

  const latestVersion = versions[0] ?? null
  const draftVersion = versions.find((v) => v.status === 'draft') ?? null

  return {
    projectQuery,
    project,
    versions,
    estimators,
    isAdmin,
    isProjectPm,
    isAssignedEstimator,
    canEditContent,
    canReview,
    canEditInfo,
    needsQuotation,
    latestVersion,
    draftVersion,
  }
}
