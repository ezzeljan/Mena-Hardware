import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { UserPlus, Users, X } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/features/auth/AuthContext'
import type { ProjectEstimator } from '@/types/database'
import { useProfileDirectory } from '@/features/account/useProfileDirectory'
import { UserAvatar } from '@/components/avatar/UserAvatar'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'

interface ProjectTeamPanelProps {
  projectId: string
  assignedPmId: string | null
  estimators: ProjectEstimator[]
  /** Admin or this project's own PM. */
  canManage: boolean
}

/**
 * Shows the project's PM and assigned estimators. The project's PM (or an
 * admin) adds and removes estimators; only assigned estimators can see the
 * project and work on its quotation, matching and hardware lines.
 */
export function ProjectTeamPanel({
  projectId,
  assignedPmId,
  estimators,
  canManage,
}: ProjectTeamPanelProps) {
  const { user } = useAuth()
  const queryClient = useQueryClient()
  const [selectedEstimator, setSelectedEstimator] = useState('')
  const [error, setError] = useState<string | null>(null)

  const { people, byId } = useProfileDirectory()
  const nameOf = (id: string | null) => {
    if (!id) return 'Unassigned'
    const p = people.find((x) => x.id === id)
    return p?.full_name || 'Unknown user'
  }

  const assignedIds = new Set(estimators.map((e) => e.estimator_id))
  const availableEstimators = people.filter(
    (p) => p.role === 'estimator' && !assignedIds.has(p.id),
  )

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ['project', projectId] })
    await queryClient.invalidateQueries({ queryKey: ['projects'] })
  }

  const addMutation = useMutation({
    mutationFn: async (estimatorId: string) => {
      if (!user) throw new Error('Must be signed in.')
      const { error: insErr } = await supabase.from('project_estimators').insert({
        project_id: projectId,
        estimator_id: estimatorId,
        assigned_by: user.id,
      })
      if (insErr) throw insErr
    },
    onSuccess: async () => {
      setSelectedEstimator('')
      setError(null)
      await refresh()
    },
    onError: (err: Error) => setError(err.message),
  })

  const removeMutation = useMutation({
    mutationFn: async (estimatorId: string) => {
      const { data, error: delErr } = await supabase
        .from('project_estimators')
        .delete()
        .eq('project_id', projectId)
        .eq('estimator_id', estimatorId)
        .select('estimator_id')
      if (delErr) throw delErr
      if (!data || data.length === 0) {
        throw new Error('Could not remove the estimator (no permission or already removed).')
      }
    },
    onSuccess: async () => {
      setError(null)
      await refresh()
    },
    onError: (err: Error) => setError(err.message),
  })

  const busy = addMutation.isPending || removeMutation.isPending

  return (
    <div className="h-full border border-neutral-300 bg-white p-4 rounded-md space-y-3">
      <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-neutral-500">
        <Users className="h-3.5 w-3.5" />
        <span>Project Team</span>
      </div>

      {error && (
        <div
          role="alert"
          className="border border-neutral-950 bg-neutral-50 p-2.5 text-xs text-neutral-950"
        >
          {error}
        </div>
      )}

      <div className="grid grid-cols-1 gap-y-1.5 text-sm">
        <div className="text-xs text-neutral-600 pt-1">Project Manager</div>
        <div className="flex items-center gap-2 font-medium text-neutral-950">
          {assignedPmId && (
            <UserAvatar
              name={byId.get(assignedPmId)?.full_name}
              url={byId.get(assignedPmId)?.avatar_url}
              size="sm"
            />
          )}
          <span>{nameOf(assignedPmId)}</span>
        </div>

        <div className="text-xs text-neutral-600 pt-3">Estimators</div>
        <div className="space-y-2">
          {estimators.length === 0 ? (
            <div className="text-xs text-neutral-600">
              No estimators assigned yet.
              {canManage
                ? ' Assign at least one so the quotation can be uploaded and matched.'
                : ''}
            </div>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {estimators.map((e) => (
                <Badge key={e.estimator_id} variant="outline" className="gap-1.5 py-0.5 pl-0.5 text-xs">
                  <UserAvatar
                    name={byId.get(e.estimator_id)?.full_name}
                    url={byId.get(e.estimator_id)?.avatar_url}
                    size="xs"
                  />
                  <span>{nameOf(e.estimator_id)}</span>
                  {canManage && (
                    <button
                      type="button"
                      aria-label={`Remove ${nameOf(e.estimator_id)}`}
                      disabled={busy}
                      onClick={() => removeMutation.mutate(e.estimator_id)}
                      className="cursor-pointer text-neutral-500 hover:text-neutral-950 disabled:opacity-50"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  )}
                </Badge>
              ))}
            </div>
          )}

          {canManage && (
            <div className="flex items-center gap-2">
              <select
                aria-label="Estimator to assign"
                value={selectedEstimator}
                onChange={(e) => setSelectedEstimator(e.target.value)}
                className="h-8 w-full lg:w-44 border border-neutral-300 bg-white px-2 text-xs text-neutral-950 focus:outline-none focus:ring-1 focus:ring-neutral-950"
              >
                <option value="">
                  {availableEstimators.length === 0
                    ? 'No more estimators available'
                    : 'Select an estimator...'}
                </option>
                {availableEstimators.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.full_name || p.id}
                  </option>
                ))}
              </select>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={!selectedEstimator || busy}
                onClick={() => addMutation.mutate(selectedEstimator)}
              >
                <UserPlus className="h-3.5 w-3.5" />
                <span>Assign</span>
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
