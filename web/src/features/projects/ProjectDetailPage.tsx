import { useState, type ReactNode } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ArrowLeft,
  ArrowRight,
  Building2,
  CalendarDays,
  CircleDot,
  FileSpreadsheet,
  Flag,
  MapPin,
  Pencil,
  Trash2,
  Upload,
  type LucideIcon,
} from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { fetchAllRows } from '@/lib/fetchAll'
import { projectDisplayName } from '@/lib/projectName'
import { projectFormSchema, type ProjectFormValues } from '@/lib/schemas'
import type { Profile, VersionStatus } from '@/types/database'
import { ProjectActivityPanel } from '@/features/projects/ProjectActivityPanel'
import { PROJECT_STAGES, StageBadge } from '@/features/projects/ProjectStage'
import { ProjectTeamPanel } from '@/features/projects/ProjectTeamPanel'
import { QuotationImportWizard } from '@/features/projects/QuotationImportWizard'
import { deleteProjectWithStorage } from '@/features/projects/deleteProject'
import { useProjectDetail } from '@/features/projects/useProjectDetail'
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

const VERSION_STATUS_TEXT: Record<VersionStatus, string> = {
  draft: 'Draft — being prepared by the estimators',
  submitted: 'Waiting for PM review',
  approved: 'Approved',
  changes_requested: 'Changes requested by the PM',
  superseded: 'Superseded',
}

function DetailField({
  label,
  icon: Icon,
  children,
}: {
  label: string
  icon: LucideIcon
  children: ReactNode
}) {
  return (
    <div className="flex min-w-0 items-center gap-2.5">
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-neutral-200 bg-white text-neutral-500">
        <Icon className="h-4 w-4" />
      </span>
      <div className="min-w-0 space-y-0.5">
        <div className="text-[11px] font-semibold uppercase tracking-wider text-neutral-500">
          {label}
        </div>
        <div className="truncate text-sm text-neutral-950">{children}</div>
      </div>
    </div>
  )
}

/**
 * Project overview: details, team, and a summary of the hardware schedule with
 * a button to open it (ProjectHardwarePage). The first quotation upload also
 * starts here.
 */
export function ProjectDetailPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const {
    projectQuery,
    project,
    estimators,
    isAdmin,
    canEditContent,
    canReview,
    canEditInfo,
    needsQuotation,
    latestVersion,
  } = useProjectDetail(id)

  const [editOpen, setEditOpen] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [importOpen, setImportOpen] = useState(false)

  const form = useForm<ProjectFormValues>({
    resolver: zodResolver(projectFormSchema),
    defaultValues: {
      reference_no: '',
      name: '',
      client: '',
      site: '',
      status: 'active',
      stage: 'tender',
      assigned_pm: '',
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

  // Summary of the latest version for the Hardware Schedule card.
  const summaryVersionId = !needsQuotation ? (latestVersion?.id ?? null) : null
  const summaryUploadId = !needsQuotation ? (latestVersion?.upload_id ?? null) : null
  const hardwareSummaryQuery = useQuery({
    queryKey: ['hardware-summary', summaryVersionId, summaryUploadId],
    enabled: !!summaryVersionId,
    queryFn: async () => {
      const groups = await fetchAllRows<{ door_qty: number }>((from, to) =>
        supabase
          .from('door_groups')
          .select('id, door_qty')
          .eq('version_id', summaryVersionId!)
          .order('id', { ascending: true })
          .range(from, to),
      )
      let fileName: string | null = null
      if (summaryUploadId) {
        const { data } = await supabase
          .from('quotation_uploads')
          .select('original_filename')
          .eq('id', summaryUploadId)
          .maybeSingle()
        fileName = (data as { original_filename: string } | null)?.original_filename ?? null
      }
      return {
        groupCount: groups.length,
        doorCount: groups.reduce((sum, g) => sum + Number(g.door_qty), 0),
        fileName,
      }
    },
  })

  const updateProjectMutation = useMutation({
    mutationFn: async (values: ProjectFormValues) => {
      if (!id) return
      const parsed = projectFormSchema.parse(values)
      const { error } = await supabase
        .from('projects')
        .update({
          reference_no: parsed.reference_no,
          name: parsed.name,
          client: parsed.client,
          site: parsed.site,
          status: parsed.status,
          stage: parsed.stage,
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
  const summary = hardwareSummaryQuery.data

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
          {canEditInfo && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setFormError(null)
                form.reset({
                  reference_no: project.reference_no ?? '',
                  name: project.name,
                  client: project.client,
                  site: project.site,
                  status: project.status,
                  stage: project.stage ?? 'tender',
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

      {/* Project details */}
      <div className="border border-neutral-300 bg-neutral-50 p-5 rounded-md space-y-4">
        <div className="flex items-center gap-2.5">
          <h1 className="text-xl font-bold tracking-tight text-neutral-950">{displayName}</h1>
          <Badge variant={project.status === 'active' ? 'default' : 'outline'}>
            {project.status.toUpperCase()}
          </Badge>
        </div>
        {/* One row on wide screens; wraps into 3 or 2 columns on smaller ones */}
        <div className="grid grid-cols-2 gap-x-6 gap-y-3 md:grid-cols-3 xl:grid-cols-5">
          <DetailField label="Client" icon={Building2}>{project.client || '—'}</DetailField>
          <DetailField label="Site" icon={MapPin}>{project.site || '—'}</DetailField>
          {/* Read-only here; changed from the Projects list or Edit Project Info. */}
          <DetailField label="Stage" icon={Flag}>
            <StageBadge stage={project.stage ?? 'tender'} />
          </DetailField>
          <DetailField label="Status" icon={CircleDot}>
            {project.status === 'active' ? 'Active' : 'Archived'}
          </DetailField>
          <DetailField label="Created" icon={CalendarDays}>
            {new Date(project.created_at).toLocaleDateString(undefined, {
              day: 'numeric',
              month: 'short',
              year: 'numeric',
            })}
          </DetailField>
        </div>
      </div>

      {/*
        Project Team (left) | Hardware Schedule (centre) | Activities (right).
        On medium screens Activities drops below the other two.
      */}
      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[max-content_minmax(0,1fr)] xl:grid-cols-[max-content_minmax(0,1fr)_20rem]">
        {/* Sized to its content (longest name), capped so many estimators wrap */}
        <div className="lg:max-w-xs">
          <ProjectTeamPanel
            projectId={project.id}
            assignedPmId={project.assigned_pm}
            estimators={estimators}
            canManage={canReview}
          />
        </div>

        <div className="min-w-0">
          {needsQuotation ? (
            <div className="border border-dashed border-neutral-300 bg-neutral-50 p-8 text-center space-y-3 flex flex-col items-center justify-center">
              <div className="text-sm font-medium text-neutral-950">
                No quotation imported yet
              </div>
              <p className="text-xs text-neutral-600">
                {importOpen && canEditContent
                  ? 'Importing the quotation below.'
                  : canEditContent
                    ? 'Upload the quotation .xlsx and match each door group to a standard hardware set to create version 1.'
                    : estimators.length === 0
                      ? 'Waiting for the PM to assign an estimator.'
                      : 'Waiting for the assigned estimator to upload the quotation and do the matching.'}
              </p>
              {canEditContent && !importOpen && (
                <Button size="sm" onClick={() => setImportOpen(true)}>
                  <Upload className="h-3.5 w-3.5" />
                  <span>Upload Quotation</span>
                </Button>
              )}
            </div>
          ) : (
            latestVersion && (
              <div className="border border-neutral-300 bg-white p-4 rounded-md flex flex-col gap-4 2xl:flex-row 2xl:items-start 2xl:justify-between">
                <div className="space-y-1.5">
                  <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-neutral-500">
                    <FileSpreadsheet className="h-3.5 w-3.5" />
                    <span>Hardware Schedule</span>
                  </div>
                  <div className="flex items-center gap-2 text-sm">
                    <span className="font-mono font-semibold text-neutral-950">
                      v{latestVersion.version_no}
                    </span>
                    <Badge
                      variant={latestVersion.status === 'approved' ? 'default' : 'outline'}
                      className="uppercase tracking-wider text-[10px]"
                    >
                      {latestVersion.status.replace('_', ' ')}
                    </Badge>
                    <span className="text-neutral-700">{VERSION_STATUS_TEXT[latestVersion.status]}</span>
                  </div>
                  <div className="text-xs text-neutral-600">
                    {summary
                      ? `${summary.groupCount} door group${summary.groupCount === 1 ? '' : 's'} · ${summary.doorCount} door${summary.doorCount === 1 ? '' : 's'}`
                      : 'Loading summary...'}
                    {' · '}
                    Updated{' '}
                    {new Date(latestVersion.updated_at).toLocaleDateString(undefined, {
                      day: 'numeric',
                      month: 'short',
                      year: 'numeric',
                    })}
                  </div>
                  {summary?.fileName && (
                    <div className="text-xs text-neutral-600">
                      Quotation file: <span className="font-medium text-neutral-900">{summary.fileName}</span>
                    </div>
                  )}
                </div>
                <Button asChild className="self-start">
                  <Link to={`/projects/${project.id}/hardware`}>
                    <span>Open Hardware Schedule</span>
                    <ArrowRight className="h-3.5 w-3.5" />
                  </Link>
                </Button>
              </div>
            )
          )}
        </div>

        <ProjectActivityPanel projectId={project.id} className="lg:col-span-2 xl:col-span-1" />
      </div>

      {/* The import wizard needs the full page width */}
      {needsQuotation && importOpen && canEditContent && (
        <QuotationImportWizard
          projectId={project.id}
          projectName={displayName}
          onCancel={() => setImportOpen(false)}
          onDone={() => {
            setImportOpen(false)
            navigate(`/projects/${project.id}/hardware`)
          }}
        />
      )}

      {/* Edit Project Modal */}
      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit Project Info</DialogTitle>
            <DialogDescription>
              {isAdmin
                ? 'Update project details, status, stage, or assigned PM.'
                : 'Update project details, status, or stage.'}
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
              <Label htmlFor="edit-project-ref">Reference No.</Label>
              <Input id="edit-project-ref" placeholder="e.g. SV002" {...form.register('reference_no')} />
              {form.formState.errors.reference_no && (
                <p className="text-xs font-medium text-neutral-900">
                  {form.formState.errors.reference_no.message}
                </p>
              )}
            </div>

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
                <Label htmlFor="edit-project-client">Client</Label>
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

              <div className="space-y-1.5">
                <Label htmlFor="edit-project-stage">Stage</Label>
                <select
                  id="edit-project-stage"
                  {...form.register('stage')}
                  className="flex h-9 w-full rounded-md border border-neutral-300 bg-white px-3 py-1 text-sm text-neutral-950 focus:outline-none focus:ring-2 focus:ring-neutral-950"
                >
                  {PROJECT_STAGES.map((s) => (
                    <option key={s.value} value={s.value}>
                      {s.label}
                    </option>
                  ))}
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
              Permanently delete <strong>{displayName}</strong> and all of its versions, uploaded quotations, door groups, and hardware lines? This cannot be undone.
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
