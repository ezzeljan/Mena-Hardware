import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CopyPlus, GitBranch, GitCompare } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { fetchVersionGroups, fetchVersionLines } from '@/features/projects/projectData'
import { useAuth } from '@/features/auth/AuthContext'
import { formatCurrency } from '@/lib/utils'
import type {
  ApprovalEvent,
  DoorGroup,
  ProjectLine,
  ProjectVersion,
} from '@/types/database'
import { computeVersionDiff } from '@/features/projects/versionDiff'
import { canReviseFrom, createNewDraftRevision } from '@/features/projects/versionActions'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'

interface VersionsDiffDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  projectId: string
  versions: ProjectVersion[]
  selectedVersionId: string | null
  onSelectVersion: (versionId: string) => void
  canEdit: boolean
}

async function fetchVersionSnapshot(versionId: string): Promise<{
  groups: DoorGroup[]
  lines: ProjectLine[]
}> {
  const groups = await fetchVersionGroups(versionId)
  if (groups.length === 0) return { groups: [], lines: [] }
  const lines = await fetchVersionLines(versionId)
  return { groups, lines }
}

export function VersionsDiffDialog({
  open,
  onOpenChange,
  projectId,
  versions,
  selectedVersionId,
  onSelectVersion,
  canEdit,
}: VersionsDiffDialogProps) {
  const { user } = useAuth()
  const queryClient = useQueryClient()

  const [tab, setTab] = useState<'versions' | 'diff'>('versions')
  const [baseId, setBaseId] = useState('')
  const [targetId, setTargetId] = useState('')
  const [showUnchanged, setShowUnchanged] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)

  const sortedDesc = useMemo(
    () => [...versions].sort((a, b) => b.version_no - a.version_no),
    [versions],
  )

  useEffect(() => {
    if (sortedDesc.length >= 2) {
      setTargetId((prev) => prev || sortedDesc[0].id)
      setBaseId((prev) => prev || sortedDesc[1].id)
    } else if (sortedDesc.length === 1) {
      setTargetId(sortedDesc[0].id)
      setBaseId(sortedDesc[0].id)
    }
  }, [sortedDesc])

  const eventsQuery = useQuery({
    queryKey: ['approval_events', projectId],
    enabled: open && versions.length > 0,
    queryFn: async (): Promise<ApprovalEvent[]> => {
      const { data, error } = await supabase
        .from('approval_events')
        .select('id, version_id, action, actor, comment, created_at')
        .in(
          'version_id',
          versions.map((v) => v.id),
        )
        .order('created_at', { ascending: false })
      if (error) throw error
      return (data ?? []) as ApprovalEvent[]
    },
  })

  const diffQuery = useQuery({
    queryKey: ['version_diff', baseId, targetId],
    enabled: open && tab === 'diff' && Boolean(baseId) && Boolean(targetId),
    queryFn: async () => {
      const [baseSnap, targetSnap] = await Promise.all([
        fetchVersionSnapshot(baseId),
        fetchVersionSnapshot(targetId),
      ])
      return computeVersionDiff(
        baseSnap.groups,
        baseSnap.lines,
        targetSnap.groups,
        targetSnap.lines,
      )
    },
  })

  const createDraftMutation = useMutation({
    mutationFn: async (source: ProjectVersion) => {
      if (!user) throw new Error('Must be signed in.')
      return createNewDraftRevision(source.id)
    },
    onSuccess: async (newVersionId) => {
      setActionError(null)
      await queryClient.invalidateQueries({ queryKey: ['project', projectId] })
      await queryClient.invalidateQueries({ queryKey: ['projects'] })
      onSelectVersion(newVersionId)
    },
    onError: (err: Error) => {
      setActionError(err.message)
    },
  })

  const hasDraft = versions.some((v) => v.status === 'draft')
  const latestVersion = sortedDesc[0] ?? null
  const versionNoById = new Map(versions.map((v) => [v.id, v.version_no]))

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <GitBranch className="h-4 w-4" />
            <span>Versions &amp; Diff</span>
          </DialogTitle>
          <DialogDescription>
            Switch between versions, create a new draft revision, or compare changes between two versions.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-neutral-200 pb-3">
          <div className="flex items-center gap-2">
            <Button
              type="button"
              size="sm"
              variant={tab === 'versions' ? 'default' : 'outline'}
              onClick={() => setTab('versions')}
            >
              <GitBranch className="h-3.5 w-3.5" />
              <span>Versions ({versions.length})</span>
            </Button>
            <Button
              type="button"
              size="sm"
              variant={tab === 'diff' ? 'default' : 'outline'}
              disabled={versions.length < 2}
              onClick={() => setTab('diff')}
            >
              <GitCompare className="h-3.5 w-3.5" />
              <span>Compare Versions</span>
            </Button>
          </div>

          {canEdit && !hasDraft && latestVersion && canReviseFrom(latestVersion.status) && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={createDraftMutation.isPending}
              onClick={() => createDraftMutation.mutate(latestVersion)}
            >
              <CopyPlus className="h-3.5 w-3.5" />
              <span>
                {createDraftMutation.isPending
                  ? 'Creating Draft...'
                  : `New Draft (v${latestVersion.version_no + 1} from v${latestVersion.version_no})`}
              </span>
            </Button>
          )}
        </div>

        {actionError && (
          <div
            role="alert"
            className="border border-neutral-950 bg-neutral-50 p-3 text-xs text-neutral-950"
          >
            {actionError}
          </div>
        )}

        {tab === 'versions' && (
          <div className="space-y-5">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Version</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Submitted</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead className="text-right">Grid</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sortedDesc.map((v) => {
                  const isSelected = v.id === selectedVersionId
                  return (
                    <TableRow key={v.id}>
                      <TableCell className="font-mono text-xs font-semibold">
                        v{v.version_no}
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant={v.status === 'approved' ? 'default' : 'outline'}
                          className="uppercase tracking-wider text-[10px]"
                        >
                          {v.status.replace('_', ' ')}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-xs text-neutral-600">
                        {v.submitted_at
                          ? new Date(v.submitted_at).toLocaleString()
                          : '—'}
                      </TableCell>
                      <TableCell className="text-xs text-neutral-600">
                        {new Date(v.created_at).toLocaleString()}
                      </TableCell>
                      <TableCell className="text-right">
                        <Button
                          type="button"
                          size="sm"
                          variant={isSelected ? 'default' : 'outline'}
                          onClick={() => {
                            onSelectVersion(v.id)
                            onOpenChange(false)
                          }}
                        >
                          {isSelected ? 'Viewing' : 'Open in Grid'}
                        </Button>
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>

            {/* Approval History */}
            <div className="space-y-2">
              <div className="text-xs font-semibold uppercase tracking-wider text-neutral-500">
                Approval History
              </div>
              {(eventsQuery.data ?? []).length === 0 ? (
                <div className="border border-neutral-200 p-4 text-xs text-neutral-500 text-center">
                  No submission or approval events yet.
                </div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Version</TableHead>
                      <TableHead>Action</TableHead>
                      <TableHead>Comment</TableHead>
                      <TableHead>Date</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(eventsQuery.data ?? []).map((ev) => (
                      <TableRow key={ev.id}>
                        <TableCell className="font-mono text-xs">
                          v{versionNoById.get(ev.version_id) ?? '?'}
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline" className="uppercase text-[10px]">
                            {ev.action}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-xs text-neutral-700">
                          {ev.comment || '—'}
                        </TableCell>
                        <TableCell className="text-xs text-neutral-600">
                          {new Date(ev.created_at).toLocaleString()}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </div>
          </div>
        )}

        {tab === 'diff' && (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3 bg-neutral-50 border border-neutral-200 p-3 rounded">
              <div className="flex flex-wrap items-center gap-3 text-xs">
                <label className="flex items-center gap-1.5">
                  <span className="font-semibold text-neutral-700">Base:</span>
                  <select
                    value={baseId}
                    onChange={(e) => setBaseId(e.target.value)}
                    className="h-8 border border-neutral-300 bg-white px-2 text-xs font-mono"
                  >
                    {sortedDesc.map((v) => (
                      <option key={v.id} value={v.id}>
                        v{v.version_no} ({v.status})
                      </option>
                    ))}
                  </select>
                </label>

                <label className="flex items-center gap-1.5">
                  <span className="font-semibold text-neutral-700">Compare:</span>
                  <select
                    value={targetId}
                    onChange={(e) => setTargetId(e.target.value)}
                    className="h-8 border border-neutral-300 bg-white px-2 text-xs font-mono"
                  >
                    {sortedDesc.map((v) => (
                      <option key={v.id} value={v.id}>
                        v{v.version_no} ({v.status})
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              <label className="flex items-center gap-2 text-xs text-neutral-700 cursor-pointer">
                <input
                  type="checkbox"
                  checked={showUnchanged}
                  onChange={(e) => setShowUnchanged(e.target.checked)}
                />
                <span>Show unchanged lines</span>
              </label>
            </div>

            {diffQuery.isLoading ? (
              <div className="p-6 text-center text-xs text-neutral-600">
                Computing version diff...
              </div>
            ) : diffQuery.data ? (
              <>
                <div className="flex flex-wrap items-center gap-2 text-xs font-mono">
                  <Badge variant="default">
                    +{diffQuery.data.summary.added} Added
                  </Badge>
                  <Badge variant="outline">
                    -{diffQuery.data.summary.removed} Removed
                  </Badge>
                  <Badge variant="secondary">
                    ~{diffQuery.data.summary.changed} Changed
                  </Badge>
                  <span className="text-neutral-500 ml-2">
                    ({diffQuery.data.summary.unchanged} unchanged)
                  </span>
                </div>

                <div className="max-h-96 overflow-y-auto border border-neutral-300">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Door Group</TableHead>
                        <TableHead>Change</TableHead>
                        <TableHead>SKU</TableHead>
                        <TableHead>Description</TableHead>
                        <TableHead className="text-right">Qty / Door</TableHead>
                        <TableHead className="text-right">Unit Price</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {diffQuery.data.groups.flatMap((gd) => {
                        const visibleLines = showUnchanged
                          ? gd.lines
                          : gd.lines.filter((l) => l.kind !== 'unchanged')
                        return visibleLines.map((l, idx) => (
                          <TableRow key={`${gd.groupKey}-${l.sku}-${idx}`}>
                            <TableCell className="text-xs font-medium">
                              {gd.roomName}
                            </TableCell>
                            <TableCell>
                              <Badge
                                variant={l.kind === 'added' ? 'default' : 'outline'}
                                className="uppercase text-[10px]"
                              >
                                {l.kind}
                              </Badge>
                            </TableCell>
                            <TableCell className="font-mono text-xs">{l.sku}</TableCell>
                            <TableCell className="text-xs">{l.description}</TableCell>
                            <TableCell className="font-mono text-xs text-right">
                              {l.kind === 'changed'
                                ? `${l.beforeQty} → ${l.afterQty}`
                                : l.afterQty ?? l.beforeQty ?? '—'}
                            </TableCell>
                            <TableCell className="font-mono text-xs text-right">
                              {l.kind === 'changed'
                                ? `${formatCurrency(l.beforePrice)} → ${formatCurrency(l.afterPrice)}`
                                : formatCurrency(
                                    l.afterPrice ?? l.beforePrice ?? null,
                                  )}
                            </TableCell>
                          </TableRow>
                        ))
                      })}
                      {diffQuery.data.summary.added +
                        diffQuery.data.summary.removed +
                        diffQuery.data.summary.changed ===
                        0 &&
                        !showUnchanged && (
                          <TableRow>
                            <TableCell
                              colSpan={6}
                              className="text-center text-xs text-neutral-500 py-6"
                            >
                              No differences between the selected versions.
                            </TableCell>
                          </TableRow>
                        )}
                    </TableBody>
                  </Table>
                </div>
              </>
            ) : null}
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
