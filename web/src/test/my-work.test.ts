import { describe, it, expect } from 'vitest'
import { buildMyWork, type WorkProject } from '@/features/dashboard/myWork'

const ME = 'user-me'
const TS = '2026-11-18T00:00:00Z'

function project(
  id: string,
  opts: {
    pm?: string | null
    estimators?: string[]
    versions?: Array<{ no: number; status: string; upload?: boolean }>
    status?: 'active' | 'archived'
  } = {},
): WorkProject {
  return {
    id,
    reference_no: id.toUpperCase(),
    name: `Project ${id}`,
    client: 'Builder',
    status: opts.status ?? 'active',
    assigned_pm: opts.pm ?? null,
    updated_at: TS,
    project_estimators: (opts.estimators ?? []).map((estimator_id) => ({ estimator_id })),
    project_versions: (opts.versions ?? []).map((v) => ({
      id: `${id}-v${v.no}`,
      version_no: v.no,
      status: v.status as never,
      upload_id: v.upload === false ? null : 'upload',
      updated_at: TS,
    })),
  }
}

const keys = (sections: ReturnType<typeof buildMyWork>) =>
  Object.fromEntries(sections.map((s) => [s.key, s.items.map((i) => i.projectId)]))

describe('buildMyWork', () => {
  it('estimator: groups assigned projects by what needs doing (latest version only)', () => {
    const result = keys(
      buildMyWork('estimator', ME, [
        project('a', { estimators: [ME] }),
        project('b', { estimators: [ME], versions: [{ no: 1, status: 'draft' }] }),
        project('c', { estimators: [ME], versions: [{ no: 1, status: 'approved' }, { no: 2, status: 'changes_requested' }] }),
        project('d', { estimators: [ME], versions: [{ no: 1, status: 'submitted' }] }),
        project('e', { estimators: ['someone-else'], versions: [{ no: 1, status: 'draft' }] }),
        project('f', { estimators: [ME], versions: [{ no: 1, status: 'draft', upload: false }] }),
        project('g', { estimators: [ME], status: 'archived' }),
      ]),
    )
    expect(result).toEqual({
      changes: ['c'],
      quotation: ['a', 'f'],
      drafts: ['b'],
      waiting: ['d'],
    })
  })

  it('pm: only their own projects; review queue links to the hardware page', () => {
    const sections = buildMyWork('pm', ME, [
      project('a', { pm: ME, estimators: ['e1'], versions: [{ no: 1, status: 'submitted' }] }),
      project('b', { pm: ME }),
      project('c', { pm: ME, estimators: ['e1'] }),
      project('d', { pm: 'other-pm', versions: [{ no: 1, status: 'submitted' }] }),
    ])
    expect(keys(sections)).toEqual({ review: ['a'], team: ['b'], progress: ['c'] })
    expect(sections[0].items[0].href).toBe('/projects/a/hardware')
    expect(sections[0].items[0].label).toBe('A — Project a')
    expect(sections[0].items[0].versionLabel).toBe('v1 · SUBMITTED')
  })

  it('admin: submitted anywhere, projects without a PM or estimators', () => {
    expect(
      keys(
        buildMyWork('admin', ME, [
          project('a', { pm: 'pm1', estimators: ['e1'], versions: [{ no: 1, status: 'submitted' }] }),
          project('b', { estimators: ['e1'] }),
          project('c', { pm: 'pm1' }),
        ]),
      ),
    ).toEqual({ review: ['a'], 'no-pm': ['b'], team: ['c'] })
  })
})
