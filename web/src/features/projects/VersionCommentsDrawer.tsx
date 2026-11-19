import { useEffect, useMemo, useRef, useState } from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { MessageSquare, Send, Trash2, X } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/features/auth/AuthContext'
import { useProfileDirectory } from '@/features/account/useProfileDirectory'
import { UserAvatar } from '@/components/avatar/UserAvatar'
import { Button } from '@/components/ui/button'
import type { DoorGroup, ProjectVersion, VersionComment } from '@/types/database'

const MAX_LENGTH = 2000

export const versionCommentsKey = (versionId: string | undefined) => ['version_comments', versionId]

/** All comments on a version, oldest first (refreshed every 30 s). */
export function useVersionComments(versionId: string | undefined) {
  return useQuery({
    queryKey: versionCommentsKey(versionId),
    enabled: !!versionId,
    refetchInterval: 30_000,
    queryFn: async (): Promise<VersionComment[]> => {
      const { data, error } = await supabase
        .from('version_comments')
        .select('id, version_id, door_group_id, author_id, body, created_at')
        .eq('version_id', versionId!)
        .order('created_at', { ascending: true })
        .order('id', { ascending: true })
      if (error) throw error
      return (data ?? []) as VersionComment[]
    },
  })
}

/** Number of comments per door group of a version. */
export function commentCountsByGroup(comments: VersionComment[] | undefined) {
  const counts = new Map<string, number>()
  for (const c of comments ?? []) {
    if (c.door_group_id) counts.set(c.door_group_id, (counts.get(c.door_group_id) ?? 0) + 1)
  }
  return counts
}

function groupLabel(group: DoorGroup) {
  const tag = group.door_tag ? ` · ${group.door_tag}` : ''
  return `${group.room_name || 'Door group'}${tag}`
}

function timeLabel(iso: string) {
  const d = new Date(iso)
  const sameDay = d.toDateString() === new Date().toDateString()
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  return sameDay ? `Today ${time}` : `${d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}, ${time}`
}

/** "all" = every comment, "general" = whole-schedule comments, otherwise a door group id. */
export type CommentFilter = 'all' | 'general' | string

interface VersionCommentsDrawerProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  version: ProjectVersion | null
  groups: DoorGroup[]
  filter: CommentFilter
  onFilterChange: (filter: CommentFilter) => void
  /** Assigned PM or admin. */
  canComment: boolean
  /** Scroll the grid to a door group. */
  onShowGroup?: (groupId: string) => void
}

/**
 * Right-hand drawer with the PM's comments on the selected version. Non-modal,
 * so the grid stays usable while it is open.
 */
export function VersionCommentsDrawer({
  open,
  onOpenChange,
  version,
  groups,
  filter,
  onFilterChange,
  canComment,
  onShowGroup,
}: VersionCommentsDrawerProps) {
  const { user, isAdmin } = useAuth()
  const { byId } = useProfileDirectory()
  const queryClient = useQueryClient()
  const commentsQuery = useVersionComments(version?.id)
  const [body, setBody] = useState('')
  const listEndRef = useRef<HTMLDivElement | null>(null)
  const contentRef = useRef<HTMLDivElement | null>(null)

  const groupById = useMemo(() => new Map(groups.map((g) => [g.id, g])), [groups])
  const comments = useMemo(() => {
    const all = commentsQuery.data ?? []
    if (filter === 'all') return all
    if (filter === 'general') return all.filter((c) => !c.door_group_id)
    return all.filter((c) => c.door_group_id === filter)
  }, [commentsQuery.data, filter])

  // A filter for a door group that isn't in this version falls back to all.
  useEffect(() => {
    if (filter !== 'all' && filter !== 'general' && groups.length > 0 && !groupById.has(filter)) {
      onFilterChange('all')
    }
  }, [filter, groupById, groups.length, onFilterChange])

  useEffect(() => {
    if (open) listEndRef.current?.scrollIntoView({ block: 'end' })
  }, [open, comments.length])

  const postMutation = useMutation({
    mutationFn: async () => {
      const text = body.trim()
      if (!text || !version || !user) return
      const { error } = await supabase.from('version_comments').insert({
        version_id: version.id,
        door_group_id: filter === 'all' || filter === 'general' ? null : filter,
        author_id: user.id,
        body: text,
      })
      if (error) throw error
    },
    onSuccess: async () => {
      setBody('')
      await queryClient.invalidateQueries({ queryKey: versionCommentsKey(version?.id) })
    },
  })

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from('version_comments').delete().eq('id', id)
      if (error) throw error
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: versionCommentsKey(version?.id) }),
  })

  const postTarget =
    filter === 'all' || filter === 'general'
      ? 'the whole schedule'
      : groupById.get(filter)
        ? groupLabel(groupById.get(filter)!)
        : 'this door group'

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange} modal={false}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Content
          aria-describedby={undefined}
          ref={contentRef}
          onInteractOutside={(e) => e.preventDefault()}
          // Escape in the grid (cancelling a cell edit) must not close the drawer.
          onEscapeKeyDown={(e) => {
            if (!contentRef.current?.contains(document.activeElement)) e.preventDefault()
          }}
          onOpenAutoFocus={(e) => e.preventDefault()}
          className="fixed inset-y-0 right-0 z-50 flex w-full max-w-md flex-col border-l border-neutral-300 bg-white shadow-2xl data-[state=open]:animate-in data-[state=open]:slide-in-from-right"
          data-testid="comments-drawer"
        >
          <div className="flex items-center justify-between gap-2 border-b border-neutral-200 px-4 py-3">
            <div className="flex items-center gap-2">
              <MessageSquare className="h-4 w-4 text-neutral-500" />
              <DialogPrimitive.Title className="text-sm font-semibold text-neutral-950">
                PM Comments{version ? ` · v${version.version_no}` : ''}
              </DialogPrimitive.Title>
            </div>
            <DialogPrimitive.Close
              className="rounded-md p-1 text-neutral-500 hover:bg-neutral-100 hover:text-neutral-950"
              aria-label="Close comments"
            >
              <X className="h-4 w-4" />
            </DialogPrimitive.Close>
          </div>

          <div className="border-b border-neutral-200 px-4 py-2.5">
            <label className="sr-only" htmlFor="comment-filter">
              Show comments for
            </label>
            <select
              id="comment-filter"
              value={filter}
              onChange={(e) => onFilterChange(e.target.value)}
              className="h-8 w-full rounded-md border border-neutral-300 bg-white px-2 text-xs text-neutral-950 focus:outline-none focus:ring-2 focus:ring-neutral-950"
            >
              <option value="all">All comments</option>
              <option value="general">Whole schedule</option>
              {groups.map((g) => (
                <option key={g.id} value={g.id}>
                  {groupLabel(g)}
                </option>
              ))}
            </select>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
            {commentsQuery.isLoading ? (
              <p className="py-8 text-center text-xs text-neutral-500">Loading comments...</p>
            ) : commentsQuery.isError ? (
              <p className="py-8 text-center text-xs text-red-700">Could not load the comments.</p>
            ) : comments.length === 0 ? (
              <div className="py-10 text-center">
                <MessageSquare className="mx-auto h-6 w-6 text-neutral-300" />
                <p className="mt-2 text-xs text-neutral-500">
                  {canComment ? 'No comments yet. Add the first one below.' : 'No comments from the PM yet.'}
                </p>
              </div>
            ) : (
              <ol className="space-y-4">
                {comments.map((c) => {
                  const author = c.author_id ? byId.get(c.author_id) : undefined
                  const name = author?.full_name?.trim() || 'Project Manager'
                  const group = c.door_group_id ? groupById.get(c.door_group_id) : undefined
                  const canDelete = !!user && (c.author_id === user.id || isAdmin)
                  return (
                    <li key={c.id} className="group/comment flex gap-2.5" data-testid="comment">
                      <UserAvatar name={name} url={author?.avatar_url} size="sm" />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-baseline gap-2">
                          <span className="truncate text-xs font-semibold text-neutral-950">{name}</span>
                          <time className="shrink-0 text-[11px] text-neutral-500" dateTime={c.created_at}>
                            {timeLabel(c.created_at)}
                          </time>
                          {canDelete && (
                            <button
                              type="button"
                              onClick={() => deleteMutation.mutate(c.id)}
                              disabled={deleteMutation.isPending}
                              className="ml-auto rounded p-0.5 text-neutral-400 opacity-0 hover:bg-neutral-100 hover:text-red-700 focus:opacity-100 group-hover/comment:opacity-100"
                              aria-label="Delete comment"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          )}
                        </div>
                        {group && (
                          <button
                            type="button"
                            onClick={() => onShowGroup?.(group.id)}
                            className="mt-1 inline-flex max-w-full items-center truncate rounded border border-neutral-200 bg-neutral-50 px-1.5 py-0.5 text-[11px] font-medium text-neutral-700 hover:border-neutral-400 hover:text-neutral-950"
                            title="Show in the grid"
                          >
                            {groupLabel(group)}
                          </button>
                        )}
                        {!c.door_group_id && filter === 'all' && (
                          <span className="mt-1 inline-flex rounded border border-neutral-200 px-1.5 py-0.5 text-[11px] text-neutral-500">
                            Whole schedule
                          </span>
                        )}
                        <p className="mt-1.5 whitespace-pre-wrap rounded-md bg-neutral-100 px-3 py-2 text-xs leading-relaxed text-neutral-900">
                          {c.body}
                        </p>
                      </div>
                    </li>
                  )
                })}
              </ol>
            )}
            <div ref={listEndRef} />
          </div>

          {canComment && version && (
            <form
              className="space-y-2 border-t border-neutral-200 px-4 py-3"
              onSubmit={(e) => {
                e.preventDefault()
                postMutation.mutate()
              }}
            >
              <label htmlFor="new-comment" className="block text-[11px] text-neutral-500">
                Comment on <span className="font-medium text-neutral-800">{postTarget}</span>
              </label>
              <textarea
                id="new-comment"
                value={body}
                maxLength={MAX_LENGTH}
                rows={3}
                placeholder="Write a comment for the estimators..."
                onChange={(e) => setBody(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault()
                    postMutation.mutate()
                  }
                }}
                className="w-full resize-none rounded-md border border-neutral-300 px-3 py-2 text-xs text-neutral-950 placeholder:text-neutral-400 focus:outline-none focus:ring-2 focus:ring-neutral-950"
              />
              {postMutation.isError && (
                <p role="alert" className="text-[11px] text-red-700">
                  {(postMutation.error as Error).message}
                </p>
              )}
              <div className="flex items-center justify-between">
                <span className="text-[11px] text-neutral-400">Ctrl + Enter to post</span>
                <Button type="submit" size="sm" disabled={!body.trim() || postMutation.isPending}>
                  <Send className="h-3.5 w-3.5" />
                  <span>{postMutation.isPending ? 'Posting...' : 'Post comment'}</span>
                </Button>
              </div>
            </form>
          )}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}
