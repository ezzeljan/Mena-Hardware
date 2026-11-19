import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, X } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/features/auth/AuthContext'
import type { Profile, ProjectStage, ProjectStatus } from '@/types/database'
import { PROJECT_STAGES } from '@/features/projects/ProjectStage'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

interface CreateProjectFormProps {
  /** PMs an admin can assign. Not used when a PM creates the project (they become its PM). */
  pmProfiles: Pick<Profile, 'id' | 'full_name' | 'role'>[]
  onCancel: () => void
}

/**
 * Step 1 of a project's life: project details only (PM or admin).
 * A PM who creates a project is assigned to it automatically (DB trigger).
 * The PM then assigns estimators on the project page; an assigned estimator
 * uploads the quotation and does the matching (QuotationImportWizard).
 */
export function CreateProjectForm({ pmProfiles, onCancel }: CreateProjectFormProps) {
  const { user, isAdmin, role } = useAuth()
  const navigate = useNavigate()
  const queryClient = useQueryClient()

  const [projectCode, setProjectCode] = useState('')
  const [projectName, setProjectName] = useState('')
  const [client, setClient] = useState('')
  const [site, setSite] = useState('')
  const [status, setStatus] = useState<ProjectStatus>('active')
  const [stage, setStage] = useState<ProjectStage>('tender')
  const [assignedPm, setAssignedPm] = useState('')
  const [formError, setFormError] = useState<string | null>(null)


  const createMutation = useMutation({
    mutationFn: async (): Promise<string> => {
      if (!user) throw new Error('Must be signed in to create a project.')
      if (!projectName.trim()) throw new Error('Project Name is required.')

      const { data, error } = await supabase
        .from('projects')
        .insert({
          reference_no: projectCode.trim(),
          name: projectName.trim(),
          client: client.trim(),
          site: site.trim(),
          status,
          stage,
          created_by: user.id,
          // For a PM the database sets assigned_pm to the creator.
          assigned_pm: role === 'pm' ? user.id : assignedPm === '' ? null : assignedPm,
        })
        .select('id')
        .single()
      if (error) throw error
      return (data as { id: string }).id
    },
    onSuccess: async (projectId) => {
      await queryClient.invalidateQueries({ queryKey: ['projects'] })
      navigate(`/projects/${projectId}`)
    },
    onError: (err: Error) => {
      setFormError(err.message)
    },
  })

  const selectClass =
    'flex h-9 w-full border border-neutral-300 bg-white px-3 py-1 text-sm text-neutral-950 focus:outline-none focus:ring-1 focus:ring-neutral-950'

  return (
    <div className="border border-neutral-950 rounded-md bg-white p-6 space-y-6">
      <div className="flex items-center justify-between border-b border-neutral-200 pb-4">
        <div>
          <h2 className="text-lg font-bold tracking-tight text-neutral-950">New Project</h2>
          <p className="text-xs text-neutral-600 mt-0.5">
            Enter the project details. After creating it, assign estimators on the project
            page — they upload the quotation and do the hardware matching.
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={createMutation.isPending}
          onClick={onCancel}
        >
          <X className="h-3.5 w-3.5" />
          <span>Cancel</span>
        </Button>
      </div>

      {formError && (
        <div
          role="alert"
          className="border border-neutral-950 bg-neutral-50 p-3 text-xs text-neutral-950 flex items-start gap-2"
        >
          <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
          <span>{formError}</span>
        </div>
      )}

      <form
        className="space-y-6"
        noValidate
        onSubmit={(e) => {
          e.preventDefault()
          setFormError(null)
          createMutation.mutate()
        }}
      >
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <Label htmlFor="new-project-code">Reference No.</Label>
            <Input
              id="new-project-code"
              value={projectCode}
              onChange={(e) => setProjectCode(e.target.value)}
              placeholder="e.g. SV002"
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="new-project-name">Project Name *</Label>
            <Input
              id="new-project-name"
              value={projectName}
              onChange={(e) => setProjectName(e.target.value)}
              placeholder="e.g. McLaren St North Sydney"
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="new-project-client">Client</Label>
            <Input
              id="new-project-client"
              value={client}
              onChange={(e) => setClient(e.target.value)}
              placeholder="e.g. DECODE"
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="new-project-site">Site</Label>
            <Input
              id="new-project-site"
              value={site}
              onChange={(e) => setSite(e.target.value)}
              placeholder="e.g. North Sydney"
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="new-project-status">Status</Label>
            <select
              id="new-project-status"
              value={status}
              onChange={(e) => setStatus(e.target.value as ProjectStatus)}
              className={selectClass}
            >
              <option value="active">Active</option>
              <option value="archived">Archived</option>
            </select>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="new-project-stage">Stage</Label>
            <select
              id="new-project-stage"
              value={stage}
              onChange={(e) => setStage(e.target.value as ProjectStage)}
              className={selectClass}
            >
              {PROJECT_STAGES.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
          </div>

          {isAdmin ? (
            <div className="space-y-1.5">
              <Label htmlFor="new-project-pm">Assigned PM</Label>
              <select
                id="new-project-pm"
                value={assignedPm}
                onChange={(e) => setAssignedPm(e.target.value)}
                className={selectClass}
              >
                <option value="">Unassigned</option>
                {pmProfiles
                  .filter((p) => p.role === 'pm')
                  .map((pm) => (
                    <option key={pm.id} value={pm.id}>
                      {pm.full_name || pm.id}
                    </option>
                  ))}
              </select>
            </div>
          ) : (
            <div className="space-y-1.5">
              <Label>Assigned PM</Label>
              <div className="h-9 flex items-center text-sm text-neutral-700">
                You (projects you create are assigned to you)
              </div>
            </div>
          )}
        </div>

        <div className="flex justify-end border-t border-neutral-200 pt-4">
          <Button type="submit" size="sm" disabled={createMutation.isPending}>
            {createMutation.isPending ? 'Creating Project...' : 'Create Project'}
          </Button>
        </div>
      </form>
    </div>
  )
}
