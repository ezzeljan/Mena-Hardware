import { supabase } from '@/lib/supabase'
import type { ApprovalAction, ProjectVersion } from '@/types/database'

/** Statuses a new draft revision can be started from (create_revision). */
export function canReviseFrom(status: ProjectVersion['status']): boolean {
  return status === 'approved' || status === 'changes_requested'
}

/**
 * Starts the next draft revision from an approved / changes-requested version.
 * One database call (create_revision, migration 011): picks the next version
 * number under a lock, copies door groups and lines, and marks the source
 * superseded — all or nothing.
 */
export async function createNewDraftRevision(sourceVersionId: string): Promise<string> {
  const { data, error } = await supabase.rpc('create_revision', {
    p_source_version_id: sourceVersionId,
  })
  if (error) throw error
  return data as string
}

/**
 * Submit / approve / request changes. One database call (transition_version):
 * the status change and its approval-history entry are saved together.
 */
export async function transitionVersion(
  versionId: string,
  action: ApprovalAction,
  comment: string,
): Promise<void> {
  const { error } = await supabase.rpc('transition_version', {
    p_version_id: versionId,
    p_action: action,
    p_comment: comment,
  })
  if (error) throw error
}
