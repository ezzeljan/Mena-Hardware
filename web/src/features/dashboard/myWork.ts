import type { Project, ProjectVersion, UserRole } from '@/types/database'
import { projectDisplayName } from '@/lib/projectName'

export interface WorkProject
  extends Pick<
    Project,
    'id' | 'reference_no' | 'name' | 'client' | 'status' | 'assigned_pm' | 'updated_at'
  > {
  project_versions?: Pick<
    ProjectVersion,
    'id' | 'version_no' | 'status' | 'upload_id' | 'updated_at'
  >[]
  project_estimators?: { estimator_id: string }[]
}

export interface WorkItem {
  projectId: string
  label: string
  client: string
  /** Latest version, e.g. "v2 · SUBMITTED"; null before a quotation is imported. */
  versionLabel: string | null
  note: string
  href: string
  updatedAt: string
  /** PM first, then estimators (for team avatars). */
  teamIds: string[]
}

export interface WorkSection {
  key: string
  title: string
  description: string
  items: WorkItem[]
}

type LatestVersion = NonNullable<WorkProject['project_versions']>[number]

function latestVersion(p: WorkProject): LatestVersion | null {
  const versions = p.project_versions ?? []
  return versions.reduce<LatestVersion | null>(
    (best, v) => (!best || v.version_no > best.version_no ? v : best),
    null,
  )
}

/** No quotation imported yet (no versions, or an unfinished v1 without an upload). */
function needsQuotation(latest: LatestVersion | null): boolean {
  return !latest || (latest.status === 'draft' && !latest.upload_id)
}

function item(p: WorkProject, note: string, page: 'overview' | 'hardware'): WorkItem {
  const latest = latestVersion(p)
  return {
    projectId: p.id,
    label: projectDisplayName(p),
    client: p.client,
    versionLabel:
      latest && !needsQuotation(latest)
        ? `v${latest.version_no} · ${latest.status.replace('_', ' ').toUpperCase()}`
        : null,
    note,
    href: page === 'hardware' ? `/projects/${p.id}/hardware` : `/projects/${p.id}`,
    updatedAt: latest?.updated_at ?? p.updated_at,
    teamIds: [
      ...(p.assigned_pm ? [p.assigned_pm] : []),
      ...(p.project_estimators ?? []).map((e) => e.estimator_id),
    ],
  }
}

function section(
  key: string,
  title: string,
  description: string,
  items: WorkItem[],
): WorkSection {
  return {
    key,
    title,
    description,
    items: [...items].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
  }
}

/**
 * Groups the user's active projects into "what needs doing" sections for their
 * role. Pure function: the page loads the projects (RLS already limits
 * estimators to their assigned projects).
 */
export function buildMyWork(
  role: UserRole,
  userId: string,
  projects: WorkProject[],
): WorkSection[] {
  const active = projects.filter((p) => p.status === 'active')
  const withLatest = active.map((p) => ({ p, latest: latestVersion(p) }))

  if (role === 'estimator') {
    const mine = withLatest.filter(({ p }) =>
      (p.project_estimators ?? []).some((e) => e.estimator_id === userId),
    )
    return [
      section(
        'changes',
        'Changes requested',
        'The PM sent these back. Start a new revision to make the changes.',
        mine
          .filter(({ latest }) => latest?.status === 'changes_requested')
          .map(({ p }) => item(p, 'Start a new revision', 'hardware')),
      ),
      section(
        'quotation',
        'Quotation to upload',
        'You are assigned, but no quotation has been imported yet.',
        mine
          .filter(({ latest }) => needsQuotation(latest))
          .map(({ p }) => item(p, 'Upload the quotation', 'overview')),
      ),
      section(
        'drafts',
        'Drafts in progress',
        'Finish the hardware and submit for PM review.',
        mine
          .filter(({ latest }) => latest?.status === 'draft' && !needsQuotation(latest))
          .map(({ p }) => item(p, 'Continue editing', 'hardware')),
      ),
      section(
        'waiting',
        'Waiting for PM review',
        'Submitted; nothing to do until the PM responds.',
        mine
          .filter(({ latest }) => latest?.status === 'submitted')
          .map(({ p }) => item(p, 'Waiting for the PM', 'hardware')),
      ),
    ]
  }

  if (role === 'pm') {
    const mine = withLatest.filter(({ p }) => p.assigned_pm === userId)
    return [
      section(
        'review',
        'Waiting for your review',
        'Submitted by the estimators. Approve or request changes.',
        mine
          .filter(({ latest }) => latest?.status === 'submitted')
          .map(({ p }) => item(p, 'Review and approve', 'hardware')),
      ),
      section(
        'team',
        'Need estimators',
        'Assign at least one estimator so the quotation can be uploaded.',
        mine
          .filter(({ p }) => (p.project_estimators ?? []).length === 0)
          .map(({ p }) => item(p, 'Assign estimators', 'overview')),
      ),
      section(
        'progress',
        'In progress',
        'With the estimators.',
        mine
          .filter(
            ({ p, latest }) =>
              (p.project_estimators ?? []).length > 0 &&
              (needsQuotation(latest) ||
                latest?.status === 'draft' ||
                latest?.status === 'changes_requested'),
          )
          .map(({ p, latest }) =>
            item(
              p,
              needsQuotation(latest)
                ? 'Quotation not uploaded yet'
                : latest?.status === 'changes_requested'
                  ? 'Changes requested'
                  : 'Draft in progress',
              'overview',
            ),
          ),
      ),
    ]
  }

  if (role === 'admin') {
    return [
      section(
        'review',
        'Waiting for review',
        'Submitted versions across all projects.',
        withLatest
          .filter(({ latest }) => latest?.status === 'submitted')
          .map(({ p }) =>
            item(p, p.assigned_pm ? 'Waiting for the project PM' : 'No PM — review needed', 'hardware'),
          ),
      ),
      section(
        'no-pm',
        'No PM assigned',
        'Set a PM so someone can approve these.',
        withLatest
          .filter(({ p }) => !p.assigned_pm)
          .map(({ p }) => item(p, 'Assign a PM', 'overview')),
      ),
      section(
        'team',
        'No estimators',
        'Nobody can upload the quotation until an estimator is assigned.',
        withLatest
          .filter(({ p }) => (p.project_estimators ?? []).length === 0)
          .map(({ p }) => item(p, 'Assign estimators', 'overview')),
      ),
    ]
  }

  // Viewer: recently approved schedules.
  return [
    section(
      'approved',
      'Recently approved',
      'Approved hardware schedules.',
      withLatest
        .filter(({ latest }) => latest?.status === 'approved')
        .map(({ p }) => item(p, 'Approved', 'hardware'))
        .slice(0, 20),
    ),
  ]
}
