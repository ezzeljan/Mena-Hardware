import type { HardwareQuote, Project, ProjectVersion, UserRole } from '@/types/database'
import { projectBuilder, projectDisplayName } from '@/lib/projectName'

export interface WorkProject extends Pick<
  Project,
  'id' | 'reference_no' | 'name' | 'client' | 'status' | 'assigned_pm' | 'updated_at'
>,
  Partial<Pick<Project, 'stage' | 'awarded_quote_id'>> {
  hardware_quotes?: Pick<HardwareQuote, 'id' | 'builder_name'>[]
  project_versions?: Pick<
    ProjectVersion,
    'id' | 'quote_id' | 'version_no' | 'status' | 'upload_id' | 'updated_at'
  >[]
  project_estimators?: { estimator_id: string }[]
}

export interface WorkItem {
  /** Unique within a section: the quote id, or the project id for project-level items. */
  key: string
  projectId: string
  label: string
  /** The project's builder (awarded quote, else the one entered); '' during tender. */
  builder: string
  /** Builder and latest version, e.g. "Acme v2 · SUBMITTED"; null for project-level items. */
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

type Version = NonNullable<WorkProject['project_versions']>[number]

/** One builder quote and its latest version. */
interface QuoteState {
  quoteId: string
  builder: string
  latest: Version
}

/** Latest version of every quote in the project, oldest quote first. */
function quoteStates(p: WorkProject): QuoteState[] {
  const latestByQuote = new Map<string, Version>()
  for (const v of p.project_versions ?? []) {
    const best = latestByQuote.get(v.quote_id)
    if (!best || v.version_no > best.version_no) latestByQuote.set(v.quote_id, v)
  }
  const names = new Map((p.hardware_quotes ?? []).map((q) => [q.id, q.builder_name]))
  return [...latestByQuote.entries()].map(([quoteId, latest]) => ({
    quoteId,
    builder: names.get(quoteId) ?? 'Quote',
    latest,
  }))
}

/** A quote whose quotation was never imported (an unfinished v1 without an upload). */
function unfinished(q: QuoteState): boolean {
  return q.latest.status === 'draft' && !q.latest.upload_id
}

/** No quote with an imported quotation yet. */
function needsQuotation(quotes: QuoteState[]): boolean {
  return quotes.every(unfinished)
}

function teamIds(p: WorkProject): string[] {
  return [
    ...(p.assigned_pm ? [p.assigned_pm] : []),
    ...(p.project_estimators ?? []).map((e) => e.estimator_id),
  ]
}

function quoteItem(p: WorkProject, q: QuoteState, note: string): WorkItem {
  return {
    key: q.quoteId,
    projectId: p.id,
    label: projectDisplayName(p),
    builder: projectBuilder(p),
    versionLabel: `${q.builder} v${q.latest.version_no} · ${q.latest.status.replace('_', ' ').toUpperCase()}`,
    note,
    href: `/projects/${p.id}/hardware?quote=${q.quoteId}`,
    updatedAt: q.latest.updated_at,
    teamIds: teamIds(p),
  }
}

function projectItem(p: WorkProject, note: string): WorkItem {
  return {
    key: p.id,
    projectId: p.id,
    label: projectDisplayName(p),
    builder: projectBuilder(p),
    versionLabel: null,
    note,
    href: `/projects/${p.id}`,
    updatedAt: p.updated_at,
    teamIds: teamIds(p),
  }
}

function section(key: string, title: string, description: string, items: WorkItem[]): WorkSection {
  return {
    key,
    title,
    description,
    items: [...items].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
  }
}

/**
 * Groups the user's active projects into "what needs doing" sections for their
 * role. Quote work (review, drafts, changes) is listed per builder quote.
 * Pure function: the page loads the projects (RLS already limits estimators to
 * their assigned projects).
 */
export function buildMyWork(
  role: UserRole,
  userId: string,
  projects: WorkProject[],
): WorkSection[] {
  const active = projects
    .filter((p) => p.status === 'active')
    .map((p) => ({ p, quotes: quoteStates(p).filter((q) => !unfinished(q)), all: quoteStates(p) }))

  const quotesWhere = (
    list: typeof active,
    test: (q: QuoteState) => boolean,
    note: (p: WorkProject, q: QuoteState) => string,
  ) => list.flatMap(({ p, quotes }) => quotes.filter(test).map((q) => quoteItem(p, q, note(p, q))))

  if (role === 'estimator') {
    const mine = active.filter(({ p }) =>
      (p.project_estimators ?? []).some((e) => e.estimator_id === userId),
    )
    return [
      section(
        'changes',
        'Changes requested',
        'The PM sent these back. Start a new revision to make the changes.',
        quotesWhere(
          mine,
          (q) => q.latest.status === 'changes_requested',
          () => 'Start a new revision',
        ),
      ),
      section(
        'quotation',
        'Quotation to upload',
        'You are assigned, but no builder quote has been imported yet.',
        mine
          .filter(({ all }) => needsQuotation(all))
          .map(({ p }) => projectItem(p, 'Upload a builder quotation')),
      ),
      section(
        'drafts',
        'Drafts in progress',
        'Finish the hardware and submit for PM review.',
        quotesWhere(
          mine,
          (q) => q.latest.status === 'draft',
          () => 'Continue editing',
        ),
      ),
      section(
        'waiting',
        'Waiting for PM review',
        'Submitted; nothing to do until the PM responds.',
        quotesWhere(
          mine,
          (q) => q.latest.status === 'submitted',
          () => 'Waiting for the PM',
        ),
      ),
    ]
  }

  if (role === 'pm') {
    const mine = active.filter(({ p }) => p.assigned_pm === userId)
    const staffed = mine.filter(({ p }) => (p.project_estimators ?? []).length > 0)
    return [
      section(
        'review',
        'Waiting for your review',
        'Submitted by the estimators. Approve or request changes.',
        quotesWhere(
          mine,
          (q) => q.latest.status === 'submitted',
          () => 'Review and approve',
        ),
      ),
      section(
        'team',
        'Need estimators',
        'Assign at least one estimator so the quotation can be uploaded.',
        mine
          .filter(({ p }) => (p.project_estimators ?? []).length === 0)
          .map(({ p }) => projectItem(p, 'Assign estimators')),
      ),
      section('progress', 'In progress', 'With the estimators.', [
        ...staffed
          .filter(({ all }) => needsQuotation(all))
          .map(({ p }) => projectItem(p, 'Quotation not uploaded yet')),
        ...quotesWhere(
          staffed,
          (q) => q.latest.status === 'draft' || q.latest.status === 'changes_requested',
          (_p, q) =>
            q.latest.status === 'changes_requested' ? 'Changes requested' : 'Draft in progress',
        ),
      ]),
    ]
  }

  if (role === 'admin') {
    return [
      section(
        'review',
        'Waiting for review',
        'Submitted quotes across all projects.',
        quotesWhere(
          active,
          (q) => q.latest.status === 'submitted',
          (p) => (p.assigned_pm ? 'Waiting for the project PM' : 'No PM — review needed'),
        ),
      ),
      section(
        'no-pm',
        'No PM assigned',
        'Set a PM so someone can approve these.',
        active.filter(({ p }) => !p.assigned_pm).map(({ p }) => projectItem(p, 'Assign a PM')),
      ),
      section(
        'team',
        'No estimators',
        'Nobody can upload the quotation until an estimator is assigned.',
        active
          .filter(({ p }) => (p.project_estimators ?? []).length === 0)
          .map(({ p }) => projectItem(p, 'Assign estimators')),
      ),
    ]
  }

  // Viewer: recently approved quotes.
  return [
    section(
      'approved',
      'Recently approved',
      'Approved hardware quotes.',
      quotesWhere(
        active,
        (q) => q.latest.status === 'approved',
        () => 'Approved',
      ).slice(0, 20),
    ),
  ]
}
