import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  CheckCircle2,
  Clock,
  CopyPlus,
  MessageSquareWarning,
  Send,
} from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/features/auth/AuthContext'
import type { ApprovalEvent, ProjectVersion } from '@/types/database'
import {
  canReviseFrom,
  createNewDraftRevision,
  transitionVersion,
} from '@/features/projects/versionActions'
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

interface ApprovalBarProps {
  projectId: string
  versions: ProjectVersion[]
  activeVersion: ProjectVersion | null
  onVersionCreated: (newVersionId: string) => void
  /** Admin or an estimator assigned to this project: submit, start new revisions. */
  canEditContent: boolean
  /** Admin or this project's own PM: approve / request changes. */
  canReview: boolean
  /**
   * Saves pending grid edits before submitting. Resolves false if some edits
   * could not be saved, so the version is not submitted without them.
   */
  savePendingEdits?: () => Promise<boolean>
}

type ModalMode = 'submit' | 'approve' | 'reject' | null

export function ApprovalBar({
  projectId,
  versions,
  activeVersion,
  onVersionCreated,
  canEditContent,
  canReview,
  savePendingEdits,
}: ApprovalBarProps) {
  const { user } = useAuth()
  const queryClient = useQueryClient()

  const [modalMode, setModalMode] = useState<ModalMode>(null)
  const [comment, setComment] = useState('')
  const [actionError, setActionError] = useState<string | null>(null)

  const latestEventQuery = useQuery({
    queryKey: ['approval_events', 'latest', activeVersion?.id],
    enabled: !!activeVersion?.id,
    queryFn: async (): Promise<ApprovalEvent | null> => {
      const { data, error } = await supabase
        .from('approval_events')
        .select('id, version_id, action, actor, comment, created_at')
        .eq('version_id', activeVersion!.id)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()
      if (error) throw error
      return (data as ApprovalEvent | null) ?? null
    },
  })

  const transitionMutation = useMutation({
    mutationFn: async ({
      mode,
      note,
    }: {
      mode: Exclude<ModalMode, null>
      note: string
    }) => {
      if (!user || !activeVersion) throw new Error('Missing user or version.')

      const trimmed = note.trim()
      if (mode === 'reject' && !trimmed) {
        throw new Error('A comment is required when requesting changes.')
      }

      if (mode === 'submit' && savePendingEdits) {
        const saved = await savePendingEdits()
        if (!saved) {
          throw new Error(
            'Some of your latest edits could not be saved, so the version was not submitted. Fix the save error (Retry in the grid) and submit again.',
          )
        }
      }

      // Status change and approval-history entry are saved together.
      await transitionVersion(activeVersion.id, mode, trimmed)
    },
    onSuccess: async () => {
      setModalMode(null)
      setComment('')
      setActionError(null)
      await queryClient.invalidateQueries({ queryKey: ['project', projectId] })
      await queryClient.invalidateQueries({ queryKey: ['projects'] })
      await queryClient.invalidateQueries({
        queryKey: ['approval_events'],
      })
    },
    onError: (err: Error) => {
      setActionError(err.message)
    },
  })

  const newDraftMutation = useMutation({
    mutationFn: async () => {
      if (!user || !activeVersion) throw new Error('Missing user or version.')
      return createNewDraftRevision(activeVersion.id)
    },
    onSuccess: async (newVersionId) => {
      setActionError(null)
      await queryClient.invalidateQueries({ queryKey: ['project', projectId] })
      await queryClient.invalidateQueries({ queryKey: ['projects'] })
      onVersionCreated(newVersionId)
    },
    onError: (err: Error) => {
      setActionError(err.message)
    },
  })

  if (!activeVersion) return null

  const hasDraft = versions.some((v) => v.status === 'draft')
  const latestEvent = latestEventQuery.data

  const openModal = (mode: Exclude<ModalMode, null>) => {
    setActionError(null)
    setComment('')
    setModalMode(mode)
  }

  return (
    <>
      <div className="border border-neutral-300 bg-neutral-50 px-4 py-3 rounded-md flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="flex items-start gap-2.5 text-xs">
          {activeVersion.status === 'draft' && (
            <Send className="h-4 w-4 text-neutral-700 shrink-0 mt-0.5" />
          )}
          {activeVersion.status === 'submitted' && (
            <Clock className="h-4 w-4 text-neutral-700 shrink-0 mt-0.5" />
          )}
          {activeVersion.status === 'approved' && (
            <CheckCircle2 className="h-4 w-4 text-neutral-950 shrink-0 mt-0.5" />
          )}
          {(activeVersion.status === 'changes_requested' ||
            activeVersion.status === 'superseded') && (
            <MessageSquareWarning className="h-4 w-4 text-neutral-800 shrink-0 mt-0.5" />
          )}

          <div>
            <div className="flex items-center gap-2">
              <span className="font-semibold text-neutral-950">
                Version v{activeVersion.version_no}
              </span>
              <Badge
                variant={activeVersion.status === 'approved' ? 'default' : 'outline'}
                className="uppercase tracking-wider text-[10px]"
              >
                {activeVersion.status.replace('_', ' ')}
              </Badge>
            </div>
            <div className="text-neutral-600 mt-0.5">
              {activeVersion.status === 'draft' &&
                'Editable draft. Submit for PM approval when hardware lines and pricing are ready.'}
              {activeVersion.status === 'submitted' &&
                `Locked and awaiting PM review${
                  activeVersion.submitted_at
                    ? ` (submitted ${new Date(activeVersion.submitted_at).toLocaleString()})`
                    : ''
                }.`}
              {activeVersion.status === 'approved' &&
                (latestEvent?.comment
                  ? `Approved — "${latestEvent.comment}"`
                  : 'Approved and locked.')}
              {activeVersion.status === 'changes_requested' &&
                (latestEvent?.comment
                  ? `Changes requested: "${latestEvent.comment}"`
                  : 'Changes requested by PM. Create a new draft revision to update.')}
              {activeVersion.status === 'superseded' &&
                'Superseded by a newer version (read-only).'}
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {activeVersion.status === 'draft' && canEditContent && (
            <Button
              type="button"
              size="sm"
              onClick={() => openModal('submit')}
            >
              <Send className="h-3.5 w-3.5" />
              <span>Submit for Approval</span>
            </Button>
          )}

          {activeVersion.status === 'submitted' && canReview && (
            <>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => openModal('reject')}
              >
                <MessageSquareWarning className="h-3.5 w-3.5" />
                <span>Request Changes</span>
              </Button>
              <Button
                type="button"
                size="sm"
                onClick={() => openModal('approve')}
              >
                <CheckCircle2 className="h-3.5 w-3.5" />
                <span>Approve</span>
              </Button>
            </>
          )}

          {canReviseFrom(activeVersion.status) &&
            canEditContent &&
            !hasDraft && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={newDraftMutation.isPending}
                onClick={() => newDraftMutation.mutate()}
              >
                <CopyPlus className="h-3.5 w-3.5" />
                <span>
                  {newDraftMutation.isPending
                    ? 'Creating Draft...'
                    : `New Draft (v${Math.max(0, ...versions.map((v) => v.version_no)) + 1})`}
                </span>
              </Button>
            )}
        </div>
      </div>

      {actionError && !modalMode && (
        <div
          role="alert"
          className="border border-neutral-950 bg-neutral-50 p-3 text-xs text-neutral-950"
        >
          {actionError}
        </div>
      )}

      <Dialog
        open={Boolean(modalMode)}
        onOpenChange={(open) => {
          if (!open && !transitionMutation.isPending) {
            setModalMode(null)
            setActionError(null)
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {modalMode === 'submit' && `Submit v${activeVersion.version_no} for Approval`}
              {modalMode === 'approve' && `Approve v${activeVersion.version_no}`}
              {modalMode === 'reject' && `Request Changes on v${activeVersion.version_no}`}
            </DialogTitle>
            <DialogDescription>
              {modalMode === 'submit' &&
                'Submitting locks this draft so no further edits can be made unless a new draft revision is created.'}
              {modalMode === 'approve' &&
                'Approving marks this hardware schedule version as final.'}
              {modalMode === 'reject' &&
                'Provide a clear comment explaining what needs to be changed.'}
            </DialogDescription>
          </DialogHeader>

          {actionError && (
            <div
              role="alert"
              className="border border-neutral-950 bg-neutral-100 p-3 text-xs text-neutral-950"
            >
              {actionError}
            </div>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="approval-comment">
              {modalMode === 'reject' ? 'Comment *' : 'Comment (Optional)'}
            </Label>
            <Input
              id="approval-comment"
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              placeholder={
                modalMode === 'reject'
                  ? 'e.g. Update closer SKU on Fire Stair doors'
                  : 'Optional note...'
              }
            />
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={transitionMutation.isPending}
              onClick={() => setModalMode(null)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              disabled={transitionMutation.isPending}
              onClick={() =>
                modalMode &&
                transitionMutation.mutate({ mode: modalMode, note: comment })
              }
            >
              {transitionMutation.isPending
                ? 'Saving...'
                : modalMode === 'submit'
                  ? 'Confirm Submit'
                  : modalMode === 'approve'
                    ? 'Confirm Approve'
                    : 'Submit Change Request'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
