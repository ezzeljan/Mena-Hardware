import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CheckCheck, GitCompare, Sparkles } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import type {
  DoorGroup,
  Part,
  ProjectVersion,
  StandardSet,
  StandardSetLine,
} from '@/types/database'
import {
  matchDoorGroup,
  type GroupMatchResult,
} from '@/features/projects/doorMatcher'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'

interface MatchingReviewPanelProps {
  projectId: string
  activeVersion: ProjectVersion | null
  canEdit: boolean
}

export function MatchingReviewPanel({
  projectId,
  activeVersion,
  canEdit,
}: MatchingReviewPanelProps) {
  const queryClient = useQueryClient()
  const [actionError, setActionError] = useState<string | null>(null)
  const [actionInfo, setActionInfo] = useState<string | null>(null)

  const isDraft = activeVersion?.status === 'draft'
  const editable = canEdit && isDraft

  const groupsQuery = useQuery({
    queryKey: ['door_groups', activeVersion?.id],
    enabled: !!activeVersion?.id,
    queryFn: async (): Promise<DoorGroup[]> => {
      const { data, error } = await supabase
        .from('door_groups')
        .select(
          'id, version_id, position, group_key, room_name, classification, leaf, door_size, door_qty, matched_set_id, match_status, match_score, match_reason, created_at, updated_at',
        )
        .eq('version_id', activeVersion!.id)
        .order('position', { ascending: true })
      if (error) throw error
      return (data ?? []) as DoorGroup[]
    },
  })

  const standardSetsQuery = useQuery({
    queryKey: ['standard_sets', 'for-matching'],
    queryFn: async (): Promise<StandardSet[]> => {
      const { data, error } = await supabase
        .from('standard_sets')
        .select(
          'id, room_name, classification, leaf, door_size, active, created_at, updated_at, standard_set_lines(id, set_id, position, sku, description, qty, unit_price, created_at, updated_at)',
        )
        .eq('active', true)
        .order('room_name', { ascending: true })
      if (error) throw error
      return (data ?? []) as StandardSet[]
    },
  })

  const partsQuery = useQuery({
    queryKey: ['parts', 'sku-lookup'],
    queryFn: async (): Promise<Pick<Part, 'id' | 'sku'>[]> => {
      const { data, error } = await supabase
        .from('parts')
        .select('id, sku')
      if (error) throw error
      return (data ?? []) as Pick<Part, 'id' | 'sku'>[]
    },
  })

  const groups = useMemo(() => groupsQuery.data ?? [], [groupsQuery.data])
  const standardSets = useMemo(
    () => standardSetsQuery.data ?? [],
    [standardSetsQuery.data],
  )
  const partBySku = useMemo(() => {
    const map = new Map<string, string>()
    for (const p of partsQuery.data ?? []) {
      map.set(p.sku.trim().toUpperCase(), p.id)
    }
    return map
  }, [partsQuery.data])

  const setById = useMemo(() => {
    const map = new Map<string, StandardSet>()
    for (const s of standardSets) {
      map.set(s.id, s)
    }
    return map
  }, [standardSets])

  // Precompute top 3 candidates for each group so dropdowns always surface best suggestions
  const candidateMap = useMemo(() => {
    const map = new Map<string, GroupMatchResult>()
    if (standardSets.length === 0) return map
    for (const g of groups) {
      map.set(g.id, matchDoorGroup(g, standardSets))
    }
    return map
  }, [groups, standardSets])

  const copySetLinesToGroup = async (groupId: string, set: StandardSet) => {
    const { error: delErr } = await supabase
      .from('project_lines')
      .delete()
      .eq('group_id', groupId)
    if (delErr) throw delErr

    const lines = [...(set.standard_set_lines ?? [])].sort(
      (a: StandardSetLine, b: StandardSetLine) => a.position - b.position,
    )
    if (lines.length === 0) return

    const rows = lines.map((line, idx) => ({
      group_id: groupId,
      position: idx + 1,
      sku: line.sku,
      description: line.description,
      qty_per_door: line.qty,
      unit_price: line.unit_price, // Preserve null intentionally
      origin: 'set' as const,
      part_id: partBySku.get(line.sku.trim().toUpperCase()) ?? null,
    }))

    const { error: insErr } = await supabase.from('project_lines').insert(rows)
    if (insErr) throw insErr
  }

  const autoMatchMutation = useMutation({
    mutationFn: async () => {
      setActionError(null)
      setActionInfo(null)
      let autoCount = 0

      const targets = groups.filter(
        (g) => g.match_status === 'unmatched' || g.match_status === 'auto',
      )

      for (const g of targets) {
        const res = matchDoorGroup(g, standardSets)
        if (res.matchStatus === 'auto') autoCount++

        const { error } = await supabase
          .from('door_groups')
          .update({
            matched_set_id: res.matchedSetId,
            match_status: res.matchStatus,
            match_score: res.matchScore,
            match_reason: res.matchReason,
          })
          .eq('id', g.id)
        if (error) throw error
      }

      return { scanned: targets.length, autoCount }
    },
    onSuccess: async (res) => {
      setActionInfo(
        `Auto-matched ${res.autoCount} of ${res.scanned} groups. Review and confirm below.`,
      )
      await queryClient.invalidateQueries({
        queryKey: ['door_groups', activeVersion?.id],
      })
    },
    onError: (err: Error) => {
      setActionError(err.message)
    },
  })

  const confirmAllAutoMutation = useMutation({
    mutationFn: async () => {
      setActionError(null)
      setActionInfo(null)
      const autoGroups = groups.filter(
        (g) => g.match_status === 'auto' && g.matched_set_id,
      )
      let confirmedCount = 0

      for (const g of autoGroups) {
        const set = setById.get(g.matched_set_id!)
        if (!set) continue

        await copySetLinesToGroup(g.id, set)

        const { error } = await supabase
          .from('door_groups')
          .update({ match_status: 'confirmed' })
          .eq('id', g.id)
        if (error) throw error
        confirmedCount++
      }

      return confirmedCount
    },
    onSuccess: async (count) => {
      setActionInfo(
        `Confirmed ${count} auto-matched door groups and copied their hardware lines.`,
      )
      await queryClient.invalidateQueries({
        queryKey: ['door_groups', activeVersion?.id],
      })
      await queryClient.invalidateQueries({
        queryKey: ['project_lines', activeVersion?.id],
      })
    },
    onError: (err: Error) => {
      setActionError(err.message)
    },
  })

  const manualSelectMutation = useMutation({
    mutationFn: async ({
      group,
      setId,
    }: {
      group: DoorGroup
      setId: string
    }) => {
      setActionError(null)
      setActionInfo(null)

      if (!setId) {
        const { error: delErr } = await supabase
          .from('project_lines')
          .delete()
          .eq('group_id', group.id)
        if (delErr) throw delErr

        const { error } = await supabase
          .from('door_groups')
          .update({
            matched_set_id: null,
            match_status: 'unmatched',
            match_score: null,
            match_reason: 'Cleared manually',
          })
          .eq('id', group.id)
        if (error) throw error
        return
      }

      const set = setById.get(setId)
      if (!set) throw new Error('Selected Standard Set not found.')

      await copySetLinesToGroup(group.id, set)

      const candidate = candidateMap
        .get(group.id)
        ?.topCandidates.find((c) => c.set.id === setId)

      const { error } = await supabase
        .from('door_groups')
        .update({
          matched_set_id: setId,
          match_status: 'manual',
          match_score: candidate ? candidate.score : null,
          match_reason: candidate
            ? `Manual: ${candidate.reason}`
            : `Manually assigned to ${set.room_name}`,
        })
        .eq('id', group.id)
      if (error) throw error
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: ['door_groups', activeVersion?.id],
      })
      await queryClient.invalidateQueries({
        queryKey: ['project_lines', activeVersion?.id],
      })
      await queryClient.invalidateQueries({ queryKey: ['project', projectId] })
    },
    onError: (err: Error) => {
      setActionError(err.message)
    },
  })

  if (!activeVersion) return null

  const confirmedCount = groups.filter(
    (g) => g.match_status === 'confirmed' || g.match_status === 'manual',
  ).length
  const autoCount = groups.filter((g) => g.match_status === 'auto').length
  const unmatchedCount = groups.filter((g) => g.match_status === 'unmatched').length
  const isBusy =
    autoMatchMutation.isPending ||
    confirmAllAutoMutation.isPending ||
    manualSelectMutation.isPending

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold uppercase tracking-wider text-neutral-700 flex items-center gap-2">
            <GitCompare className="h-4 w-4" />
            <span>Door-to-Set Matching Review (v{activeVersion.version_no})</span>
          </h2>
          <p className="text-xs text-neutral-600 mt-0.5">
            Match each door group to a Standard Set before editing hardware lines in the grid.
          </p>
        </div>

        {editable && groups.length > 0 && (
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={isBusy || standardSets.length === 0}
              onClick={() => autoMatchMutation.mutate()}
            >
              <Sparkles className="h-3.5 w-3.5" />
              <span>
                {autoMatchMutation.isPending ? 'Matching...' : 'Run Auto-Match'}
              </span>
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={isBusy || autoCount === 0}
              onClick={() => confirmAllAutoMutation.mutate()}
            >
              <CheckCheck className="h-3.5 w-3.5" />
              <span>
                {confirmAllAutoMutation.isPending
                  ? 'Confirming...'
                  : `Confirm Auto Matches (${autoCount})`}
              </span>
            </Button>
          </div>
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

      {actionInfo && (
        <div className="border border-neutral-950 bg-neutral-50 p-3 text-xs text-neutral-950">
          {actionInfo}
        </div>
      )}

      {groupsQuery.isLoading ? (
        <div className="border border-neutral-200 p-8 text-center text-sm text-neutral-600">
          Loading door groups...
        </div>
      ) : groups.length === 0 ? (
        <div className="border border-dashed border-neutral-300 bg-neutral-50 p-6 text-center text-xs text-neutral-600">
          No door groups yet. Upload and confirm a quotation workbook above to populate door groups.
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div className="border border-neutral-200 p-2.5 rounded">
              <div className="text-[10px] uppercase tracking-wider text-neutral-500 font-semibold">
                Total Groups
              </div>
              <div className="text-lg font-bold font-mono text-neutral-950">
                {groups.length}
              </div>
            </div>
            <div className="border border-neutral-200 p-2.5 rounded">
              <div className="text-[10px] uppercase tracking-wider text-neutral-500 font-semibold">
                Confirmed / Manual
              </div>
              <div className="text-lg font-bold font-mono text-neutral-950">
                {confirmedCount}
              </div>
            </div>
            <div className="border border-neutral-200 p-2.5 rounded">
              <div className="text-[10px] uppercase tracking-wider text-neutral-500 font-semibold">
                Auto (Needs Confirm)
              </div>
              <div className="text-lg font-bold font-mono text-neutral-950">
                {autoCount}
              </div>
            </div>
            <div className="border border-neutral-200 p-2.5 rounded">
              <div className="text-[10px] uppercase tracking-wider text-neutral-500 font-semibold">
                Unmatched
              </div>
              <div className="text-lg font-bold font-mono text-neutral-950">
                {unmatchedCount}
              </div>
            </div>
          </div>

          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>#</TableHead>
                <TableHead>Door Group</TableHead>
                <TableHead className="text-right">Doors</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Matched Standard Set</TableHead>
                <TableHead>Score &amp; Reason</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {groups.map((g) => {
                const topCandidates = candidateMap.get(g.id)?.topCandidates ?? []
                const topIds = new Set(topCandidates.map((c) => c.set.id))
                const otherSets = standardSets.filter((s) => !topIds.has(s.id))
                const matchedSet = g.matched_set_id
                  ? setById.get(g.matched_set_id)
                  : undefined

                return (
                  <TableRow key={g.id}>
                    <TableCell className="font-mono text-xs">{g.position}</TableCell>
                    <TableCell>
                      <div className="text-xs font-semibold text-neutral-950">
                        {g.room_name}
                      </div>
                      <div className="text-[11px] text-neutral-600 font-mono">
                        {[g.classification || '—', g.leaf || '—', g.door_size || '—'].join(
                          ' · ',
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="font-mono text-xs text-right font-semibold">
                      {g.door_qty}
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant={
                          g.match_status === 'confirmed' || g.match_status === 'manual'
                            ? 'default'
                            : 'outline'
                        }
                        className="uppercase tracking-wider text-[10px]"
                      >
                        {g.match_status}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      {editable ? (
                        <select
                          aria-label={`Standard Set for ${g.room_name}`}
                          value={g.matched_set_id ?? ''}
                          disabled={isBusy}
                          onChange={(e) =>
                            manualSelectMutation.mutate({
                              group: g,
                              setId: e.target.value,
                            })
                          }
                          className="h-8 w-full max-w-xs border border-neutral-300 bg-white px-2 text-xs text-neutral-950 focus:outline-none focus:ring-1 focus:ring-neutral-950"
                        >
                          <option value="">— Unmatched —</option>
                          {topCandidates.length > 0 && (
                            <optgroup label="Recommended Matches">
                              {topCandidates.map((c) => (
                                <option key={c.set.id} value={c.set.id}>
                                  [{Math.round(c.score * 100)}%] {c.set.room_name} (
                                  {c.set.classification} / {c.set.leaf || '—'})
                                </option>
                              ))}
                            </optgroup>
                          )}
                          <optgroup label="All Standard Sets">
                            {otherSets.map((s) => (
                              <option key={s.id} value={s.id}>
                                {s.room_name} ({s.classification} / {s.leaf || '—'})
                              </option>
                            ))}
                          </optgroup>
                        </select>
                      ) : (
                        <span className="text-xs font-medium text-neutral-900">
                          {matchedSet
                            ? `${matchedSet.room_name} (${matchedSet.classification})`
                            : '—'}
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="text-xs text-neutral-600 max-w-xs">
                      {g.match_score !== null && (
                        <span className="font-mono font-semibold text-neutral-900 mr-1.5">
                          {Math.round(g.match_score * 100)}%
                        </span>
                      )}
                      <span>{g.match_reason || '—'}</span>
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </>
      )}
    </div>
  )
}
