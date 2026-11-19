import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronRight, FolderKanban, Plus, Search, Trash2 } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/features/auth/AuthContext'
import type { HardwareQuote, Profile, Project, ProjectStage, ProjectVersion } from '@/types/database'
import { StageBadge, StageSelect } from '@/features/projects/ProjectStage'
import { CreateProjectForm } from '@/features/projects/CreateProjectWizard'
import { deleteProjectWithStorage } from '@/features/projects/deleteProject'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { projectDisplayName } from '@/lib/projectName'
import { useProfileDirectory } from '@/features/account/useProfileDirectory'
import { AvatarStack } from '@/components/avatar/UserAvatar'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'

interface ProjectRow extends Project {
  hardware_quotes?: Pick<HardwareQuote, 'id' | 'builder_name'>[]
  project_versions?: Pick<ProjectVersion, 'id' | 'quote_id' | 'version_no' | 'status'>[]
  project_estimators?: { estimator_id: string }[]
}

export function ProjectsPage() {
  const { isAdmin, isPmOrAdmin, role, user } = useAuth()
  const directory = useProfileDirectory()
  const queryClient = useQueryClient()

  const [searchQuery, setSearchQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState<'ALL' | 'active' | 'archived'>('active')
  const [stageFilter, setStageFilter] = useState<'ALL' | ProjectStage>('ALL')
  const [wizardOpen, setWizardOpen] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<ProjectRow | null>(null)
  const [deleteError, setDeleteError] = useState<string | null>(null)

  const projectsQuery = useQuery({
    queryKey: ['projects'],
    queryFn: async (): Promise<ProjectRow[]> => {
      const { data, error } = await supabase
        .from('projects')
        .select(
          'id, reference_no, name, client, site, status, stage, created_by, assigned_pm, created_at, updated_at, awarded_quote_id, awarded_supplier_id, hardware_quotes!hardware_quotes_project_id_fkey(id, builder_name), project_versions(id, quote_id, version_no, status), project_estimators(estimator_id)',
        )
        .order('updated_at', { ascending: false })
      if (error) throw error
      return (data ?? []) as unknown as ProjectRow[]
    },
  })

  // profile_directory (id, full_name, role) is readable by every signed-in user,
  // unlike profiles (self/admin only). Admins pick a PM when creating a project;
  // a PM who creates a project is assigned to it automatically.
  const pmProfilesQuery = useQuery({
    queryKey: ['profile_directory', 'pms'],
    enabled: isAdmin,
    queryFn: async (): Promise<Pick<Profile, 'id' | 'full_name' | 'role'>[]> => {
      const { data, error } = await supabase
        .from('profile_directory')
        .select('id, full_name, role')
        .in('role', ['pm', 'admin'])
        .order('full_name', { ascending: true })
      if (error) throw error
      return (data ?? []) as Pick<Profile, 'id' | 'full_name' | 'role'>[]
    },
  })

  const deleteMutation = useMutation({
    mutationFn: (projectId: string) => deleteProjectWithStorage(projectId),
    onSuccess: async () => {
      setDeleteTarget(null)
      setDeleteError(null)
      await queryClient.invalidateQueries({ queryKey: ['projects'] })
    },
    onError: (err: Error) => {
      setDeleteError(err.message)
    },
  })

  const filteredProjects = useMemo(() => {
    const all = projectsQuery.data ?? []
    const q = searchQuery.trim().toLowerCase()

    return all.filter((p) => {
      if (statusFilter !== 'ALL' && p.status !== statusFilter) return false
      if (stageFilter !== 'ALL' && p.stage !== stageFilter) return false
      if (!q) return true
      return (
        p.reference_no.toLowerCase().includes(q) ||
        p.name.toLowerCase().includes(q) ||
        p.client.toLowerCase().includes(q) ||
        p.site.toLowerCase().includes(q)
      )
    })
  }, [projectsQuery.data, searchQuery, statusFilter, stageFilter])

  /** The project's assigned PM and admins can change the stage. */
  function canChangeStage(project: ProjectRow) {
    return isAdmin || (role === 'pm' && !!user && project.assigned_pm === user.id)
  }

  function teamOf(project: ProjectRow) {
    const ids = [
      ...(project.assigned_pm ? [project.assigned_pm] : []),
      ...(project.project_estimators ?? []).map((e) => e.estimator_id),
    ]
    return ids.map((id) => {
      const p = directory.byId.get(id)
      return { id, full_name: p?.full_name ?? null, avatar_url: p?.avatar_url ?? null }
    })
  }

  /** Latest version of each builder quote (the awarded quote first). */
  function getQuoteSummaries(project: ProjectRow) {
    const latest = new Map<string, Pick<ProjectVersion, 'version_no' | 'status'>>()
    for (const v of project.project_versions ?? []) {
      const best = latest.get(v.quote_id)
      if (!best || v.version_no > best.version_no) latest.set(v.quote_id, v)
    }
    return (project.hardware_quotes ?? [])
      .filter((q) => latest.has(q.id))
      .map((q) => ({
        id: q.id,
        builder: q.builder_name,
        latest: latest.get(q.id)!,
        winner: project.stage === 'awarded' && project.awarded_quote_id === q.id,
      }))
      .sort((a, b) => Number(b.winner) - Number(a.winner) || a.builder.localeCompare(b.builder))
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-neutral-200 pb-4">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-neutral-950 flex items-center gap-2">
            <FolderKanban className="h-5 w-5" />
            <span>Projects</span>
          </h1>
          <p className="text-sm text-neutral-600 mt-0.5">
            Builder hardware quotes per project: quotation uploads, supplier sheets, versions, and PM approvals.
          </p>
        </div>

        {isPmOrAdmin && !wizardOpen && (
          <Button size="sm" onClick={() => setWizardOpen(true)}>
            <Plus className="h-4 w-4" />
            <span>New Project</span>
          </Button>
        )}
      </div>

      {wizardOpen ? (
        <CreateProjectForm
          pmProfiles={pmProfilesQuery.data ?? []}
          onCancel={() => setWizardOpen(false)}
        />
      ) : (
        <>
      {/* Filters */}
      <div className="flex flex-wrap items-center justify-between gap-3 bg-neutral-50 p-3 border border-neutral-200 rounded-md">
        <div className="flex flex-wrap items-center gap-3 flex-1 min-w-[260px]">
          <div className="relative flex-1 max-w-sm">
            <Search className="h-4 w-4 absolute left-3 top-2.5 text-neutral-400" />
            <Input
              aria-label="Search projects"
              placeholder="Search Ref No., project name, client, or site..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-9 bg-white"
            />
          </div>

          <select
            aria-label="Filter by project status"
            value={statusFilter}
            onChange={(e) =>
              setStatusFilter(e.target.value as 'ALL' | 'active' | 'archived')
            }
            className="h-9 rounded-md border border-neutral-300 bg-white px-3 text-sm text-neutral-950 focus:outline-none focus:ring-2 focus:ring-neutral-950"
          >
            <option value="active">Active Projects</option>
            <option value="archived">Archived Projects</option>
            <option value="ALL">All Statuses</option>
          </select>

          <select
            aria-label="Filter by project stage"
            value={stageFilter}
            onChange={(e) => setStageFilter(e.target.value as 'ALL' | ProjectStage)}
            className="h-9 rounded-md border border-neutral-300 bg-white px-3 text-sm text-neutral-950 focus:outline-none focus:ring-2 focus:ring-neutral-950"
          >
            <option value="ALL">All Stages</option>
            <option value="tender">Tender</option>
            <option value="awarded">Awarded</option>
          </select>
        </div>

        <div className="text-xs font-medium text-neutral-600">
          Showing {filteredProjects.length} of {projectsQuery.data?.length ?? 0} projects
        </div>
      </div>

      {/* Table */}
      {projectsQuery.isLoading ? (
        <div className="border border-neutral-200 p-10 text-center text-sm text-neutral-600">
          Loading projects...
        </div>
      ) : projectsQuery.isError ? (
        <div
          role="alert"
          className="border border-neutral-950 bg-neutral-50 p-6 text-sm text-neutral-950"
        >
          Error loading projects: {(projectsQuery.error as Error).message}
        </div>
      ) : filteredProjects.length === 0 ? (
        <div className="border border-neutral-200 p-10 text-center text-sm text-neutral-600">
          No projects found.{' '}
          {isPmOrAdmin
            ? 'Click "New Project" to create one.'
            : role === 'estimator'
              ? 'You will see projects here once a PM assigns you to them.'
              : 'Ask a PM or administrator to create a project.'}
        </div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Ref No.</TableHead>
              <TableHead>Project Name</TableHead>
              <TableHead>Client</TableHead>
              <TableHead>Site</TableHead>
              <TableHead>Stage</TableHead>
              <TableHead>Team</TableHead>
              <TableHead>Quotes</TableHead>
              <TableHead>Project Status</TableHead>
              <TableHead>Updated</TableHead>
              <TableHead className="text-right">Open</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filteredProjects.map((project) => {
              const quoteSummaries = getQuoteSummaries(project)
              return (
                <TableRow
                  key={project.id}
                  className={project.status === 'archived' ? 'opacity-60' : undefined}
                >
                  <TableCell className="font-mono text-xs font-semibold text-neutral-950 whitespace-nowrap">
                    {project.reference_no || '—'}
                  </TableCell>
                  <TableCell className="font-semibold text-neutral-950">
                    <Link to={`/projects/${project.id}`} className="hover:underline">
                      {project.name}
                    </Link>
                  </TableCell>
                  <TableCell className="text-sm text-neutral-700">
                    {project.client || '—'}
                  </TableCell>
                  <TableCell className="text-sm text-neutral-700">
                    {project.site || '—'}
                  </TableCell>
                  <TableCell>
                    {canChangeStage(project) ? (
                      <StageSelect
                        projectId={project.id}
                        stage={project.stage}
                        label={`Stage of ${projectDisplayName(project)}`}
                      />
                    ) : (
                      <StageBadge stage={project.stage} />
                    )}
                  </TableCell>
                  <TableCell>
                    {/* PM first, then estimators */}
                    <AvatarStack people={teamOf(project)} />
                  </TableCell>
                  <TableCell>
                    {quoteSummaries.length > 0 ? (
                      <ul className="space-y-1">
                        {quoteSummaries.map((q) => (
                          <li key={q.id} className="flex items-center gap-1.5 whitespace-nowrap">
                            <span
                              className={`max-w-[10rem] truncate text-xs ${
                                q.winner ? 'font-semibold text-emerald-700' : 'text-neutral-700'
                              }`}
                              title={q.winner ? `${q.builder} (awarded)` : q.builder}
                            >
                              {q.builder}
                            </span>
                            <span className="font-mono text-xs font-semibold">
                              v{q.latest.version_no}
                            </span>
                            <Badge
                              variant={q.latest.status === 'approved' ? 'default' : 'outline'}
                              className="uppercase tracking-wider text-[10px]"
                            >
                              {q.latest.status.replace('_', ' ')}
                            </Badge>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <span className="text-xs text-neutral-400">No quotes</span>
                    )}
                  </TableCell>
                  <TableCell>
                    <Badge variant={project.status === 'active' ? 'secondary' : 'outline'}>
                      {project.status === 'active' ? 'Active' : 'Archived'}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-xs text-neutral-600">
                    {new Date(project.updated_at).toLocaleDateString()}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="inline-flex items-center gap-1.5">
                      <Button variant="outline" size="sm" asChild>
                        <Link to={`/projects/${project.id}`}>
                          <span>Open</span>
                          <ChevronRight className="h-3.5 w-3.5" />
                        </Link>
                      </Button>
                      {isAdmin && (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          aria-label={`Delete ${project.name}`}
                          onClick={() => {
                            setDeleteError(null)
                            setDeleteTarget(project)
                          }}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      )}

        </>
      )}

      {/* Delete Project Confirmation Modal */}
      <Dialog
        open={Boolean(deleteTarget)}
        onOpenChange={(open) => {
          if (!open && !deleteMutation.isPending) {
            setDeleteTarget(null)
            setDeleteError(null)
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Project</DialogTitle>
            <DialogDescription>
              Permanently delete <strong>{deleteTarget ? projectDisplayName(deleteTarget) : ''}</strong> and all of its versions, uploaded quotations, door groups, and hardware lines? This cannot be undone.
            </DialogDescription>
          </DialogHeader>

          {deleteError && (
            <div
              role="alert"
              className="border border-neutral-950 bg-neutral-100 p-3 text-xs text-neutral-950"
            >
              {deleteError}
            </div>
          )}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={deleteMutation.isPending}
              onClick={() => setDeleteTarget(null)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              disabled={deleteMutation.isPending || !deleteTarget}
              onClick={() => deleteTarget && deleteMutation.mutate(deleteTarget.id)}
            >
              {deleteMutation.isPending ? 'Deleting...' : 'Delete Project'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
