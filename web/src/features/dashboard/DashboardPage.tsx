import { useMemo } from 'react'
import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { ArrowRight, CheckCircle2 } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { fetchAllRows } from '@/lib/fetchAll'
import { useAuth } from '@/features/auth/AuthContext'
import { buildMyWork, type WorkProject, type WorkSection } from '@/features/dashboard/myWork'
import { Badge } from '@/components/ui/badge'
import { AvatarStack } from '@/components/avatar/UserAvatar'
import { useProfileDirectory } from '@/features/account/useProfileDirectory'
import type { DirectoryProfile } from '@/types/database'

function SectionCard({
  section,
  byId,
}: {
  section: WorkSection
  byId: Map<string, DirectoryProfile>
}) {
  return (
    <section className="border border-neutral-300 bg-white rounded-md">
      <div className="flex items-start justify-between gap-3 border-b border-neutral-200 px-4 py-3">
        <div>
          <h2 className="text-sm font-bold text-neutral-950">{section.title}</h2>
          <p className="text-xs text-neutral-600 mt-0.5">{section.description}</p>
        </div>
        <span className="font-mono text-lg font-bold text-neutral-950" aria-label={`${section.items.length} items`}>
          {section.items.length}
        </span>
      </div>
      {section.items.length === 0 ? (
        <div className="px-4 py-3 text-xs text-neutral-500">Nothing here.</div>
      ) : (
        <ul className="divide-y divide-neutral-100">
          {section.items.map((it) => (
            <li key={it.projectId}>
              <Link
                to={it.href}
                className="flex items-center justify-between gap-3 px-4 py-2.5 hover:bg-neutral-50"
              >
                <div className="min-w-0">
                  <div className="text-sm font-semibold text-neutral-950 truncate">{it.label}</div>
                  <div className="text-xs text-neutral-600 truncate">
                    {it.client || '—'}
                    {' · '}
                    Updated{' '}
                    {new Date(it.updatedAt).toLocaleDateString(undefined, {
                      day: 'numeric',
                      month: 'short',
                    })}
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <AvatarStack
                    size="xs"
                    max={3}
                    people={it.teamIds.map((id) => ({
                      id,
                      full_name: byId.get(id)?.full_name ?? null,
                      avatar_url: byId.get(id)?.avatar_url ?? null,
                    }))}
                  />
                  {it.versionLabel && (
                    <Badge variant="outline" className="font-mono text-[10px]">
                      {it.versionLabel}
                    </Badge>
                  )}
                  <span className="hidden sm:inline text-xs text-neutral-700">{it.note}</span>
                  <ArrowRight className="h-3.5 w-3.5 text-neutral-500" />
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

/** Home page: what needs the signed-in user's attention, by role. */
export function DashboardPage() {
  const { user, role, profile } = useAuth()
  const { byId } = useProfileDirectory()

  const projectsQuery = useQuery({
    queryKey: ['projects', 'my-work'],
    enabled: !!user,
    queryFn: (): Promise<WorkProject[]> =>
      fetchAllRows<WorkProject>((from, to) =>
        supabase
          .from('projects')
          .select(
            'id, reference_no, name, client, status, assigned_pm, updated_at, project_versions(id, version_no, status, upload_id, updated_at), project_estimators(estimator_id)',
          )
          .order('id', { ascending: true })
          .range(from, to),
      ),
  })

  const sections = useMemo(
    () => (user && role ? buildMyWork(role, user.id, projectsQuery.data ?? []) : []),
    [user, role, projectsQuery.data],
  )
  const total = sections.reduce((sum, s) => sum + s.items.length, 0)
  const firstName = profile?.full_name?.trim().split(/\s+/)[0]

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-neutral-950 flex items-center gap-2">
            <span>Hi {firstName}!</span>
          </h1>
          <p className="text-xs text-neutral-600 mt-1">
            Here is what needs your attention across your active projects.
          </p>
        </div>
        <Link to="/projects" className="text-xs font-medium text-neutral-700 hover:underline">
          All projects →
        </Link>
      </div>

      {projectsQuery.isLoading ? (
        <div className="border border-neutral-200 p-10 text-center text-sm text-neutral-600">
          Loading your work...
        </div>
      ) : projectsQuery.isError ? (
        <div role="alert" className="border border-neutral-950 bg-neutral-50 p-4 text-sm text-neutral-950">
          Could not load your projects. Refresh the page to try again.
        </div>
      ) : (
        <>
          {total === 0 && (
            <div className="border border-neutral-300 bg-neutral-50 rounded-md p-4 flex items-center gap-2 text-sm text-neutral-800">
              <CheckCircle2 className="h-4 w-4" />
              <span>All caught up — nothing needs your attention right now.</span>
            </div>
          )}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {sections.map((s) => (
              <SectionCard key={s.key} section={s} byId={byId} />
            ))}
          </div>
        </>
      )}
    </div>
  )
}
