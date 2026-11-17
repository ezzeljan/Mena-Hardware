import { useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, GitBranch, Pencil, Trash2 } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/features/auth/AuthContext'
import { projectFormSchema, type ProjectFormValues } from '@/lib/schemas'
import type { Profile, Project, ProjectVersion } from '@/types/database'
import { ProjectGridPanel } from '@/features/projects/ProjectGridPanel'
import { VersionsDiffDialog } from '@/features/projects/VersionsDiffDialog'
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
import { Label } from '@/components/ui/label'

interface ProjectDetail extends Project {
  project_versions?: ProjectVersion[]
}

export function ProjectDetailPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { isAdmin, isEstimatorOrAdmin } = useAuth()
  const queryClient = useQueryClient()

  const [editOpen, setEditOpen] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [versionsOpen, setVersionsOpen] = useState(false)
  const [selectedVersionId, setSelectedVersionId] = useState<string | null>(null)

  const form = useForm<ProjectFormValues>({
    resolver: zodResolver(projectFormSchema),
    defaultValues: {
      name: '',
      client: '',
      site: '',
      status: 'active',
      assigned_pm: '',
    },
  })

  const projectQuery = useQuery({
    queryKey: ['project', id],
    enabled: !!id,
    queryFn: async (): Promise<ProjectDetail> => {
      const { data, error } = await supabase
        .from('projects')
        .select(
          'id, name, client, site, status, created_by, assigned_pm, created_at, updated_at, project_versions(id, project_id, version_no, status, upload_id, markup_pct, created_by, submitted_at, created_at, updated_at)',
        )
        .eq('id', id!)
        .single()
      if (error) throw error
      return data as unknown as ProjectDetail
    },
  })

  const pmProfilesQuery = useQuery({
    queryKey: ['profiles', 'pms'],
    enabled: isAdmin,
    queryFn: async (): Promise<Pick<Profile, 'id' | 'full_name' | 'email' | 'role'>[]> => {
      const { data, error } = await supabase
        .from('profiles')
        .select('id, full_name, email, role')
        .in('role', ['pm', 'admin'])
        .order('full_name', { ascending: true })
      if (error) throw error
      return (data ?? []) as Pick<Profile, 'id' | 'full_name' | 'email' | 'role'>[]
    },
  })

  const updateProjectMutation = useMutation({
    mutationFn: async (values: ProjectFormValues) => {
      if (!id) return
      const parsed = projectFormSchema.parse(values)
      const { error } = await supabase
        .from('projects')
        .update({
          name: parsed.name,
          client: parsed.client,
          site: parsed.site,
          status: parsed.status,
          assigned_pm: parsed.assigned_pm === '' ? null : parsed.assigned_pm,
        })
        .eq('id', id)
      if (error) throw error
    },
    onSuccess: async () => {
      setEditOpen(false)
      setFormError(null)
      await queryClient.invalidateQueries({ queryKey: ['project', id] })
      await queryClient.invalidateQueries({ queryKey: ['projects'] })
    },
    onError: (err: Error) => {
      setFormError(err.message)
    },
  })

  const deleteProjectMutation = useMutation({
    mutationFn: async () => {
      if (!id) return
      await deleteProjectWithStorage(id)
    },
    onSuccess: async () => {
      setDeleteOpen(false)
      await queryClient.invalidateQueries({ queryKey: ['projects'] })
      navigate('/projects')
    },
    onError: (err: Error) => {
      setDeleteError(err.message)
    },
  })

  if (projectQuery.isLoading) {
    return (
      <div className="border border-neutral-200 p-10 text-center text-sm text-neutral-600">
        Loading project...
      </div>
    )
  }

  if (projectQuery.isError || !projectQuery.data) {
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

  const project = projectQuery.data
  const versions = [...(project.project_versions ?? [])].sort(
    (a, b) => b.version_no - a.version_no,
  )
  const activeDraftVersion = versions.find((v) => v.status === 'draft') ?? null
  const activeVersion =
    versions.find((v) => v.id === selectedVersionId) ??
    activeDraftVersion ??
    versions[0] ??
    null

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <Button variant="outline" size="sm" asChild>
          <Link to="/projects">
            <ArrowLeft className="h-3.5 w-3.5" />
            <span>Back to Projects</span>
          </Link>
        </Button>

        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setVersionsOpen(true)}
          >
            <GitBranch className="h-3.5 w-3.5" />
            <span>Versions &amp; Diff ({versions.length})</span>
          </Button>
          {isEstimatorOrAdmin && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setFormError(null)
                form.reset({
                  name: project.name,
                  client: project.client,
                  site: project.site,
                  status: project.status,
                  assigned_pm: project.assigned_pm ?? '',
                })
                setEditOpen(true)
              }}
            >
              <Pencil className="h-3.5 w-3.5" />
              <span>Edit Project Info</span>
            </Button>
          )}
          {isAdmin && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setDeleteError(null)
                setDeleteOpen(true)
              }}
            >
              <Trash2 className="h-3.5 w-3.5" />
              <span>Delete</span>
            </Button>
          )}
        </div>
      </div>

      {/* Project Summary Card */}
      <div className="border border-neutral-300 bg-neutral-50 p-5 rounded-md flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2.5">
            <h1 className="text-xl font-bold tracking-tight text-neutral-950">
              {project.name}
            </h1>
            <Badge variant={project.status === 'active' ? 'default' : 'outline'}>
              {project.status.toUpperCase()}
            </Badge>
          </div>
          <div className="text-xs text-neutral-600 mt-1.5">
            Builder: <span className="font-medium text-neutral-900">{project.client || '—'}</span>
            {' • '}
            Site: <span className="font-medium text-neutral-900">{project.site || '—'}</span>
          </div>
        </div>

        <div className="text-left sm:text-right border-t sm:border-t-0 pt-3 sm:pt-0 border-neutral-200 flex sm:flex-col items-center sm:items-end justify-between gap-2">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-neutral-500">
            Active Version
          </div>
          {versions.length > 0 ? (
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
          ) : (
            <div className="text-sm font-mono text-neutral-500">—</div>
          )}
        </div>
      </div>

      {/* Editable Project Hardware Grid (Excel-style) */}
      <ProjectGridPanel
        projectName={project.name}
        builderName={project.client}
        activeVersion={activeVersion}
        canEdit={isEstimatorOrAdmin}
      />

      <VersionsDiffDialog
        open={versionsOpen}
        onOpenChange={setVersionsOpen}
        projectId={project.id}
        versions={versions}
        selectedVersionId={activeVersion?.id ?? null}
        onSelectVersion={(vid) => setSelectedVersionId(vid)}
        canEdit={isEstimatorOrAdmin}
      />

      {/* Edit Project Modal */}
      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit Project Info</DialogTitle>
            <DialogDescription>
              Update project details, status, or assigned PM.
            </DialogDescription>
          </DialogHeader>

          {formError && (
            <div
              role="alert"
              className="border border-neutral-950 bg-neutral-100 p-3 text-xs text-neutral-950"
            >
              {formError}
            </div>
          )}

          <form
            onSubmit={form.handleSubmit((vals) => updateProjectMutation.mutate(vals))}
            className="space-y-4"
            noValidate
          >
            <div className="space-y-1.5">
              <Label htmlFor="edit-project-name">Project Name</Label>
              <Input id="edit-project-name" {...form.register('name')} />
              {form.formState.errors.name && (
                <p className="text-xs font-medium text-neutral-900">
                  {form.formState.errors.name.message}
                </p>
              )}
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label htmlFor="edit-project-client">Builder</Label>
                <Input id="edit-project-client" {...form.register('client')} />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="edit-project-site">Site</Label>
                <Input id="edit-project-site" {...form.register('site')} />
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label htmlFor="edit-project-status">Status</Label>
                <select
                  id="edit-project-status"
                  {...form.register('status')}
                  className="flex h-9 w-full rounded-md border border-neutral-300 bg-white px-3 py-1 text-sm text-neutral-950 focus:outline-none focus:ring-2 focus:ring-neutral-950"
                >
                  <option value="active">Active</option>
                  <option value="archived">Archived</option>
                </select>
              </div>

              {isAdmin && (
                <div className="space-y-1.5">
                  <Label htmlFor="edit-project-pm">Assigned PM</Label>
                  <select
                    id="edit-project-pm"
                    {...form.register('assigned_pm')}
                    className="flex h-9 w-full rounded-md border border-neutral-300 bg-white px-3 py-1 text-sm text-neutral-950 focus:outline-none focus:ring-2 focus:ring-neutral-950"
                  >
                    <option value="">Unassigned</option>
                    {pmProfilesQuery.data?.map((pm) => (
                      <option key={pm.id} value={pm.id}>
                        {pm.full_name || pm.email || pm.id} ({pm.role.toUpperCase()})
                      </option>
                    ))}
                  </select>
                </div>
              )}
            </div>

            <DialogFooter className="pt-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => setEditOpen(false)}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={updateProjectMutation.isPending}>
                {updateProjectMutation.isPending ? 'Saving...' : 'Save Changes'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Delete Project Confirmation Modal */}
      <Dialog
        open={deleteOpen}
        onOpenChange={(open) => {
          if (!open && !deleteProjectMutation.isPending) {
            setDeleteOpen(false)
            setDeleteError(null)
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Project</DialogTitle>
            <DialogDescription>
              Permanently delete <strong>{project.name}</strong> and all of its versions, uploaded quotations, door groups, and hardware lines? This cannot be undone.
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
              disabled={deleteProjectMutation.isPending}
              onClick={() => setDeleteOpen(false)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              disabled={deleteProjectMutation.isPending}
              onClick={() => deleteProjectMutation.mutate()}
            >
              {deleteProjectMutation.isPending ? 'Deleting...' : 'Delete Project'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
