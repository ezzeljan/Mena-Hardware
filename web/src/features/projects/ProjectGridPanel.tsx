import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AlertTriangle,
  Check,
  Download,
  Loader2,
  Merge,
} from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { GridSkeleton } from '@/components/ui/skeleton'
import { fetchAllRows } from '@/lib/fetchAll'
import { formatCurrency } from '@/lib/utils'
import { parseNullablePriceInput } from '@/lib/schemas'
import type {
  DoorGroup,
  Part,
  ProjectLine,
  ProjectVersion,
  QuoteSheet,
} from '@/types/database'
import { fetchVersionGroups, fetchVersionLines } from '@/features/projects/projectData'
import { GridCellEditor } from '@/features/projects/GridCellEditor'
import { ExportExcelDialog } from '@/features/projects/ExportExcelDialog'
import {
  GRID_COLUMNS,
  GroupRowsFragment,
  LAST_EDITABLE_COL,
  type EditableCol,
  type LineSupplier,
} from '@/features/projects/ProjectGridGroupRows'
import { DELIVERY_PER_DOOR } from '@/features/projects/pricing'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { MergeGroupsDialog } from '@/features/projects/MergeGroupsDialog'
import { combineGroupQuoteInfo, readGroupQuoteInfo, type GroupQuoteInfo } from '@/features/projects/groupQuoteInfo'
import { planMerge, type MergePlan } from '@/features/projects/mergeGroups'

interface ProjectGridPanelProps {
  /** Display name with reference no. (file name, title strip). */
  projectName: string
  /** Project name without the reference no. ("Project:" row of the export). */
  projectTitle?: string
  /** The quote's builder ("Client:" row and file name). */
  clientName: string
  activeVersion: ProjectVersion | null
  /** The supplier sheet shown (its lines only). */
  sheet: QuoteSheet | null
  /** Every sheet of the version (the export writes one worksheet each). */
  sheets?: QuoteSheet[]
  canEdit: boolean
  /** PM comment count per door group (shown on the group rows). */
  commentCounts?: Map<string, number>
  /** Open the comments drawer for a door group. */
  onOpenComments?: (groupId: string) => void
  /** Door group to scroll to and highlight briefly (from the comments drawer). */
  highlightGroupId?: string | null
  /**
   * Receives a function that saves all pending edits now and resolves true when
   * nothing is left unsaved. Used to save before submitting (B6).
   */
  onRegisterSavePending?: (savePending: (() => Promise<boolean>) | null) => void
  /** Shown under the grid in a bar pinned to the bottom of the screen (the sheet tabs). */
  footer?: ReactNode
  /** Where the Export Excel button is drawn (the page's button row). */
  exportSlot?: HTMLElement | null
  /** The version's sheets are still loading (lines are shown per sheet). */
  sheetsLoading?: boolean
}

type SaveStatus = 'saved' | 'unsaved' | 'saving' | 'error'

export function ProjectGridPanel({
  projectName,
  projectTitle,
  clientName,
  activeVersion,
  sheet,
  sheets = [],
  canEdit,
  commentCounts,
  onOpenComments,
  highlightGroupId = null,
  onRegisterSavePending,
  footer,
  exportSlot = null,
  sheetsLoading = false,
}: ProjectGridPanelProps) {
  const queryClient = useQueryClient()

  // The grid's visible horizontal scrollbar lives in the bar pinned to the
  // bottom of the screen (with the sheet tabs). The grid still scrolls
  // sideways natively (trackpad, Shift + wheel, touch), but its own scrollbar
  // is clipped off (hBarHeight), so there's never a second one on screen.
  const gridScrollRef = useRef<HTMLDivElement | null>(null)
  // Also kept in state so the observers attach once the grid is on screen.
  const [gridEl, setGridEl] = useState<HTMLDivElement | null>(null)
  const setGridScroll = useCallback((el: HTMLDivElement | null) => {
    gridScrollRef.current = el
    setGridEl(el)
  }, [])
  const hScrollRef = useRef<HTMLDivElement>(null)
  const [hScrollWidth, setHScrollWidth] = useState(0)
  const [showHScroll, setShowHScroll] = useState(false)
  // Height of the grid's own horizontal scrollbar (0 for overlay scrollbars).
  const [hBarHeight, setHBarHeight] = useState(0)
  const measureScroll = useCallback(() => {
    const grid = gridScrollRef.current
    if (!grid) {
      setShowHScroll(false)
      return
    }
    const overflow = grid.scrollWidth - grid.clientWidth
    const proxyWidth = hScrollRef.current?.clientWidth || grid.clientWidth
    setHScrollWidth(proxyWidth + Math.max(0, overflow))
    setShowHScroll(overflow > 0)
    // The box has no border, so what's left of offsetHeight is the scrollbar.
    setHBarHeight(overflow > 0 ? Math.max(0, grid.offsetHeight - grid.clientHeight) : 0)
  }, [])
  useEffect(() => {
    measureScroll()
    window.addEventListener('resize', measureScroll)
    const ro = new ResizeObserver(measureScroll)
    if (gridEl) {
      ro.observe(gridEl)
      const table = gridEl.firstElementChild
      if (table) ro.observe(table)
    }
    return () => {
      window.removeEventListener('resize', measureScroll)
      ro.disconnect()
    }
  }, [gridEl, measureScroll])
  useEffect(() => {
    if (showHScroll && hScrollRef.current && gridScrollRef.current) {
      hScrollRef.current.scrollLeft = gridScrollRef.current.scrollLeft
    }
  }, [showHScroll])
  // The grid and the pinned bar follow each other. Setting one's scrollLeft
  // fires its own scroll event; copying that back (often a fraction of a
  // pixel off on scaled screens) fought the drag and made it jump. So the
  // scroll we caused is skipped, and nothing is copied when they already agree.
  const echoRef = useRef<{ el: 'grid' | 'bar'; left: number } | null>(null)
  const followScroll = useCallback((from: 'grid' | 'bar', left: number) => {
    const echo = echoRef.current
    if (echo && echo.el === from && Math.abs(echo.left - left) < 1) {
      echoRef.current = null
      return
    }
    const to = from === 'grid' ? hScrollRef.current : gridScrollRef.current
    if (!to || Math.abs(to.scrollLeft - left) < 1) return
    echoRef.current = { el: from === 'grid' ? 'bar' : 'grid', left }
    to.scrollLeft = left
  }, [])
  const isDraft = activeVersion?.status === 'draft'
  const editable = canEdit && isDraft

  // Lines of every sheet of the version (edits are saved by line id).
  const [lines, setLines] = useState<ProjectLine[]>([])
  // Part suggestions: the sheet's supplier only, or every supplier (out of stock).
  const [allSuppliers, setAllSuppliers] = useState(false)
  const [markupPct, setMarkupPct] = useState<number>(15)
  const [markupInput, setMarkupInput] = useState<string>('15.00')
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('saved')
  const [exporting, setExporting] = useState(false)
  const [exportOpen, setExportOpen] = useState(false)
  const [exportError, setExportError] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [focusedCell, setFocusedCell] = useState<{
    lineId: string
    col: EditableCol
  } | null>(null)
  // The cell being edited and its starting text (the typed text lives in GridCellEditor).
  const [editingCell, setEditingCell] = useState<{
    lineId: string
    col: EditableCol
    initial: string
  } | null>(null)

  const dirtyIdsRef = useRef<Set<string>>(new Set())
  const linesRef = useRef<ProjectLine[]>([])
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Saves run one after another, never in parallel.
  const saveChainRef = useRef<Promise<void>>(Promise.resolve())
  const cellRefs = useRef<Map<string, HTMLDivElement>>(new Map())

  const groupsQuery = useQuery({
    queryKey: ['door_groups', activeVersion?.id],
    enabled: !!activeVersion?.id,
    queryFn: (): Promise<DoorGroup[]> => fetchVersionGroups(activeVersion!.id),
  })

  const groups = useMemo(() => groupsQuery.data ?? [], [groupsQuery.data])

  // What the quotation said about each group (the room name's popover), by group key.
  const uploadId = activeVersion?.upload_id ?? null
  const quoteInfoQuery = useQuery({
    queryKey: ['quotation_group_info', uploadId],
    enabled: !!uploadId,
    queryFn: async (): Promise<Map<string, GroupQuoteInfo>> => {
      const rows = await fetchAllRows<{ group_key: string; info: unknown }>((from, to) =>
        supabase.from('quotation_group_info').select('group_key, info').eq('upload_id', uploadId!).range(from, to),
      )
      const map = new Map<string, GroupQuoteInfo>()
      for (const r of rows) {
        const info = readGroupQuoteInfo(r.info)
        if (info) map.set(r.group_key, info)
      }
      return map
    },
  })

  // A merged group: the details of every group it was made from.
  const quoteInfoOf = (group: DoorGroup): GroupQuoteInfo | null => {
    const byKey = quoteInfoQuery.data
    if (!byKey) return null
    const keys = (group.merged_from?.length ?? 0) >= 2 ? group.merged_from!.map((p) => p.group_key) : [group.group_key]
    return combineGroupQuoteInfo(keys.map((k) => byKey.get(k)).filter((i): i is GroupQuoteInfo => !!i))
  }

  const projectLinesQuery = useQuery({
    queryKey: ['project_lines', activeVersion?.id],
    enabled: !!activeVersion?.id,
    queryFn: (): Promise<ProjectLine[]> => fetchVersionLines(activeVersion!.id),
  })

  const partsQuery = useQuery({
    queryKey: ['parts', 'for-grid'],
    queryFn: (): Promise<Part[]> =>
      fetchAllRows<Part>((from, to) =>
        supabase
          .from('parts')
          .select(
            'id, sku, supplier_id, description, unit_cost, active, folder_id, legend, created_at, updated_at, suppliers(id, name, is_owner_supplied)',
          )
          .eq('active', true)
          .order('sku', { ascending: true })
          .order('id', { ascending: true })
          .range(from, to),
      ),
  })

  const parts = useMemo(() => partsQuery.data ?? [], [partsQuery.data])
  const sheetSupplierId = sheet?.supplier_id ?? null
  const suggestedParts = useMemo(
    () => (allSuppliers || !sheetSupplierId ? parts : parts.filter((p) => p.supplier_id === sheetSupplierId)),
    [allSuppliers, parts, sheetSupplierId],
  )
  const partLookups = useMemo(
    () => ({
      partById: new Map(parts.map((p) => [p.id, p])),
      partBySku: new Map(parts.map((p) => [p.sku.trim().toUpperCase(), p])),
    }),
    [parts],
  )

  // The version whose lines are in `lines`. The lines reach state one render
  // after the query, so until this matches the version the grid keeps its
  // skeleton (instead of flashing door groups without their parts).
  const [linesVersionId, setLinesVersionId] = useState<string | null>(null)
  const versionId = activeVersion?.id ?? null
  useEffect(() => {
    if (!projectLinesQuery.data) return
    if (dirtyIdsRef.current.size === 0) {
      setLines(projectLinesQuery.data)
      linesRef.current = projectLinesQuery.data
    }
    setLinesVersionId(versionId)
  }, [projectLinesQuery.data, versionId])

  useEffect(() => {
    linesRef.current = lines
  }, [lines])

  const runFlush = useCallback(async () => {
    const versionId = activeVersion?.id
    const ids = Array.from(dirtyIdsRef.current)
    if (ids.length === 0 || !versionId) return
    // Take these ids out of the queue while they save; edits made meanwhile re-queue themselves.
    for (const id of ids) dirtyIdsRef.current.delete(id)
    setSaveStatus('saving')
    setSaveError(null)

    const currentMap = new Map(linesRef.current.map((l) => [l.id, l]))
    const payload = ids.flatMap((id) => {
      const line = currentMap.get(id)
      if (!line) return [] // deleted meanwhile
      return [
        {
          id: line.id,
          sku: line.sku,
          description: line.description,
          qty_per_door: line.qty_per_door,
          unit_price: line.unit_price,
          origin: line.origin,
          part_id: line.part_id,
          mhqt_remarks: line.mhqt_remarks ?? '',
          review_flag: line.review_flag ?? '',
        },
      ]
    })

    if (payload.length > 0) {
      // One call: every line saves or none do (save_project_lines, migration 011).
      const { error } = await supabase.rpc('save_project_lines', {
        p_version_id: versionId,
        p_lines: payload,
      })
      if (error) {
        // Put the lines back in the queue so they are retried instead of silently dropped.
        for (const l of payload) dirtyIdsRef.current.add(l.id)
        setSaveStatus('error')
        setSaveError(
          `${payload.length} change${payload.length === 1 ? '' : 's'} not saved: ${error.message}. Your edits are kept on screen — use Retry, or they will be retried on your next edit.`,
        )
        return
      }
    }

    setSaveStatus(dirtyIdsRef.current.size > 0 ? 'unsaved' : 'saved')
    if (dirtyIdsRef.current.size === 0) {
      await queryClient.invalidateQueries({
        queryKey: ['project_lines', versionId],
      })
    }
  }, [activeVersion?.id, queryClient])

  const flushDirtyLines = useCallback((): Promise<void> => {
    const next = saveChainRef.current.then(runFlush)
    saveChainRef.current = next.catch(() => undefined)
    return next
  }, [runFlush])

  // Save everything now (cancelling the autosave delay). True when nothing is left unsaved.
  const savePendingEdits = useCallback(async (): Promise<boolean> => {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current)
      saveTimerRef.current = null
    }
    await flushDirtyLines()
    return dirtyIdsRef.current.size === 0
  }, [flushDirtyLines])

  useEffect(() => {
    onRegisterSavePending?.(savePendingEdits)
    return () => onRegisterSavePending?.(null)
  }, [onRegisterSavePending, savePendingEdits])

  // Merge / unmerge door groups (merge_door_groups / unmerge_door_group).
  const [selectedGroupIds, setSelectedGroupIds] = useState<Set<string>>(new Set())
  const [mergeOpen, setMergeOpen] = useState(false)
  const [mergeBusy, setMergeBusy] = useState(false)
  const [mergeError, setMergeError] = useState<string | null>(null)
  // Worked out when the dialog opens (the ticked groups and their lines then).
  const [mergePlan, setMergePlan] = useState<MergePlan | null>(null)
  // A new version or sheet starts with nothing selected.
  useEffect(() => setSelectedGroupIds(new Set()), [activeVersion?.id])
  const toggleGroupSelected = useCallback((groupId: string) => {
    setSelectedGroupIds((prev) => {
      const next = new Set(prev)
      if (next.has(groupId)) next.delete(groupId)
      else next.add(groupId)
      return next
    })
  }, [])
  const refreshGroups = useCallback(async () => {
    const vid = activeVersion?.id
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['door_groups', vid] }),
      queryClient.invalidateQueries({ queryKey: ['project_lines', vid] }),
      queryClient.invalidateQueries({ queryKey: ['version_comments', vid] }),
      queryClient.invalidateQueries({ queryKey: ['project', activeVersion?.project_id] }),
    ])
  }, [activeVersion?.id, activeVersion?.project_id, queryClient])

  // Warn before closing the tab while edits are still unsaved.
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (dirtyIdsRef.current.size > 0) {
        e.preventDefault()
        e.returnValue = ''
      }
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [])

  useEffect(() => {
    const dirtySet = dirtyIdsRef.current
    return () => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current)
        saveTimerRef.current = null
      }
      if (dirtySet.size > 0) {
        void flushDirtyLines()
      }
    }
  }, [flushDirtyLines])

  const scheduleAutosave = useCallback(
    (lineId: string) => {
      dirtyIdsRef.current.add(lineId)
      setSaveStatus('unsaved')
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
      saveTimerRef.current = setTimeout(() => {
        void flushDirtyLines()
      }, 500)
    },
    [flushDirtyLines],
  )

  const sheetLines = useMemo(
    () => (sheet ? lines.filter((l) => l.sheet_id === sheet.id) : []),
    [lines, sheet],
  )

  const linesByGroup = useMemo(() => {
    const map = new Map<string, ProjectLine[]>()
    for (const g of groups) map.set(g.id, [])
    for (const l of sheetLines) {
      const arr = map.get(l.group_id)
      if (arr) arr.push(l)
    }
    for (const arr of map.values()) {
      arr.sort((a, b) => a.position - b.position)
    }
    return map
  }, [groups, sheetLines])

  const flatLineIds = useMemo(() => {
    const ordered: string[] = []
    for (const g of groups) {
      for (const l of linesByGroup.get(g.id) ?? []) {
        ordered.push(l.id)
      }
    }
    return ordered
  }, [groups, linesByGroup])

  const focusCell = useCallback((lineId: string, col: EditableCol) => {
    setFocusedCell({ lineId, col })
    requestAnimationFrame(() => {
      cellRefs.current.get(`${lineId}:${col}`)?.focus()
    })
  }, [])

  const startEditing = useCallback(
    (line: ProjectLine, col: EditableCol) => {
      if (!editable) return
      let initial = ''
      if (col === 0) initial = line.sku
      else if (col === 1) initial = line.description
      else if (col === 2) initial = String(line.qty_per_door)
      else if (col === 3) {
        initial = line.unit_price === null ? '' : String(line.unit_price)
      } else if (col === 4) initial = line.mhqt_remarks ?? ''
      setEditingCell({ lineId: line.id, col, initial })
    },
    [editable],
  )

  const commitEdit = useCallback(
    (line: ProjectLine, col: EditableCol, rawVal: string) => {
      let updated: ProjectLine | null = null
      if (col === 0) {
        const nextSku = rawVal.trim()
        if (nextSku !== line.sku) {
          updated = {
            ...line,
            sku: nextSku,
            origin: line.origin === 'added' ? 'added' : 'edited',
          }
        }
      } else if (col === 1) {
        const nextDesc = rawVal.trim()
        if (nextDesc !== line.description) {
          updated = {
            ...line,
            description: nextDesc,
            origin: line.origin === 'added' ? 'added' : 'edited',
          }
        }
      } else if (col === 2) {
        const num = Number(rawVal.trim())
        if (Number.isFinite(num) && num >= 0 && num !== line.qty_per_door) {
          updated = {
            ...line,
            qty_per_door: num,
            origin: line.origin === 'added' ? 'added' : 'edited',
          }
        }
      } else if (col === 3) {
        const parsed = parseNullablePriceInput(rawVal)
        if (parsed !== undefined && parsed !== line.unit_price) {
          updated = {
            ...line,
            unit_price: parsed,
            origin: line.origin === 'added' ? 'added' : 'edited',
          }
        }
      } else if (col === 4) {
        // Remarks don't change the hardware, so the line keeps its origin.
        const nextRemarks = rawVal.trim().slice(0, 500)
        if (nextRemarks !== (line.mhqt_remarks ?? '')) {
          updated = { ...line, mhqt_remarks: nextRemarks }
        }
      }

      if (updated) {
        setLines((prev) => prev.map((l) => (l.id === line.id ? updated! : l)))
        scheduleAutosave(line.id)
      }
      setEditingCell(null)
    },
    [scheduleAutosave],
  )

  const handleSelectPart = useCallback(
    (line: ProjectLine, part: Part) => {
      const updated: ProjectLine = {
        ...line,
        sku: part.sku,
        description: part.description,
        unit_price: part.unit_cost,
        part_id: part.id,
        origin: line.origin === 'added' ? 'added' : 'edited',
      }
      setLines((prev) => prev.map((l) => (l.id === line.id ? updated : l)))
      setEditingCell(null)
      scheduleAutosave(line.id)
    },
    [scheduleAutosave],
  )

  const moveFocus = useCallback(
    (lineId: string, col: EditableCol, dRow: number, dCol: number) => {
      const rowIdx = flatLineIds.indexOf(lineId)
      if (rowIdx === -1) return
      let nextRow = rowIdx + dRow
      let nextCol = col + dCol
      if (nextCol > LAST_EDITABLE_COL) {
        nextCol = 0
        nextRow += 1
      } else if (nextCol < 0) {
        nextCol = LAST_EDITABLE_COL
        nextRow -= 1
      }
      if (nextRow < 0 || nextRow >= flatLineIds.length) return
      focusCell(flatLineIds[nextRow], nextCol as EditableCol)
    },
    [flatLineIds, focusCell],
  )

  const handleAddLine = async (groupId: string) => {
    if (!editable || !sheet) return
    setSaveStatus('saving')
    setSaveError(null)
    const groupLines = linesByGroup.get(groupId) ?? []
    const nextPos =
      groupLines.length > 0
        ? Math.max(...groupLines.map((l) => l.position)) + 1
        : 1

    const { data, error } = await supabase
      .from('project_lines')
      .insert({
        group_id: groupId,
        sheet_id: sheet.id,
        position: nextPos,
        sku: '',
        description: 'New hardware item',
        qty_per_door: 1,
        unit_price: null,
        origin: 'added',
        part_id: null,
      })
      .select(
        'id, group_id, sheet_id, position, sku, description, qty_per_door, unit_price, origin, part_id, mhqt_remarks, review_flag, created_at, updated_at',
      )
      .single()

    if (error) {
      setSaveStatus('error')
      setSaveError(error.message)
      return
    }

    const created = data as ProjectLine
    setLines((prev) => [...prev, created])
    setSaveStatus('saved')
    focusCell(created.id, 0)
    startEditing(created, 0)
  }

  // The estimator has checked a flagged line: clear the flag (saved like any edit).
  const handleClearFlag = (line: ProjectLine) => {
    if (!editable) return
    setLines((prev) => prev.map((l) => (l.id === line.id ? { ...l, review_flag: '' } : l)))
    scheduleAutosave(line.id)
  }

  const handleDeleteLine = async (line: ProjectLine) => {
    if (!editable) return
    setSaveStatus('saving')
    setSaveError(null)
    dirtyIdsRef.current.delete(line.id)
    const { error } = await supabase
      .from('project_lines')
      .delete()
      .eq('id', line.id)
    if (error) {
      setSaveStatus('error')
      setSaveError(error.message)
      return
    }
    setLines((prev) => prev.filter((l) => l.id !== line.id))
    setSaveStatus('saved')
  }

  const handleMoveLine = async (
    groupId: string,
    line: ProjectLine,
    direction: -1 | 1,
  ) => {
    if (!editable) return
    const groupLines = linesByGroup.get(groupId) ?? []
    const idx = groupLines.findIndex((l) => l.id === line.id)
    const targetIdx = idx + direction
    if (idx === -1 || targetIdx < 0 || targetIdx >= groupLines.length) return

    const other = groupLines[targetIdx]
    setSaveStatus('saving')
    setSaveError(null)

    try {
      // Swap both positions in one call (the unique position check runs at commit).
      const { error } = await supabase.rpc('save_project_lines', {
        p_version_id: activeVersion!.id,
        p_lines: [
          { id: line.id, position: other.position },
          { id: other.id, position: line.position },
        ],
      })
      if (error) throw error

      setLines((prev) =>
        prev.map((l) => {
          if (l.id === line.id) return { ...l, position: other.position }
          if (l.id === other.id) return { ...l, position: line.position }
          return l
        }),
      )
      setSaveStatus('saved')
    } catch (err) {
      setSaveStatus('error')
      setSaveError(
        err && typeof err === 'object' && 'message' in err
          ? String((err as { message: unknown }).message)
          : 'Failed to reorder line.',
      )
    }
  }

  // Switching sheets closes any open cell editor.
  useEffect(() => {
    setEditingCell(null)
    setFocusedCell(null)
  }, [sheet?.id])

  useEffect(() => {
    setEditingCell(null)
    setFocusedCell(null)
    if (!activeVersion) return
    const num = Number(activeVersion.markup_pct ?? 15)
    if (Number.isFinite(num) && num >= 0) {
      setMarkupPct(num)
      setMarkupInput(num.toFixed(2))
    } else {
      setMarkupPct(15)
      setMarkupInput('15.00')
    }
  }, [activeVersion])

  // LEGEND / SUPPLIER columns: from the line's library part (by id, else SKU).
  // Built once per parts load (hooks must stay above the early return).
  const { partById, partBySku } = partLookups

  if (!activeVersion) return null

  const markupFactor = 1 + markupPct / 100
  const totalDoors = groups.reduce((sum, g) => sum + Number(g.door_qty), 0)

  const selectedGroups = groups.filter((g) => selectedGroupIds.has(g.id))
  const sheetNameOf = (sheetId: string) => sheets.find((x) => x.id === sheetId)?.name ?? 'Sheet'

  const handleMerge = async (roomName: string, include: Set<string>) => {
    if (!mergePlan) return
    setMergeBusy(true)
    setMergeError(null)
    try {
      if (!(await savePendingEdits())) throw new Error('Save the pending edits first (see the error above).')
      const { keep, copy } = mergePlan.resolve(include)
      const { error } = await supabase.rpc('merge_door_groups', {
        p_target: mergePlan.target.id,
        p_others: mergePlan.others.map((g) => g.id),
        p_room_name: roomName,
        p_keep_line_ids: keep,
        p_copy_line_ids: copy,
      })
      if (error) throw error
      setMergeOpen(false)
      setSelectedGroupIds(new Set())
      await refreshGroups()
    } catch (err) {
      setMergeError((err as Error).message)
    } finally {
      setMergeBusy(false)
    }
  }

  const handleUnmerge = async (group: DoorGroup) => {
    const parts = group.merged_from ?? []
    const list = parts.map((p) => `${p.room_name} (${Number(p.door_qty)})`).join(', ')
    if (!window.confirm(`Unmerge into ${parts.length} door groups: ${list}? Each keeps this group's current hardware.`)) return
    setSaveError(null)
    if (!(await savePendingEdits())) return
    const { error } = await supabase.rpc('unmerge_door_group', { p_group: group.id })
    if (error) {
      setSaveError(error.message)
      return
    }
    await refreshGroups()
  }
  const groupById = new Map(groups.map((g) => [g.id, g]))
  const projectTotal = sheetLines.reduce((sum, l) => {
    if (l.unit_price === null) return sum
    const dQty = Number(groupById.get(l.group_id)?.door_qty ?? 0)
    return sum + Number(l.qty_per_door) * dQty * Number(l.unit_price)
  }, 0)
  const projectTotalWithMarkup = projectTotal * markupFactor
  const deliveries = totalDoors * DELIVERY_PER_DOOR
  const totalExGst = projectTotalWithMarkup + deliveries

  const supplierOf = (line: ProjectLine): LineSupplier | null => {
    const part =
      (line.part_id ? partById.get(line.part_id) : undefined) ??
      partBySku.get(line.sku.trim().toUpperCase())
    const m = part?.suppliers
    return m
      ? {
          name: m.name,
          ownerSupplied: m.is_owner_supplied,
          legend: part.legend || (m.is_owner_supplied ? 'MM' : ''),
          // Owner-supplied (MM) parts belong on every supplier's sheet: never flagged.
          other: !!sheetSupplierId && part.supplier_id !== sheetSupplierId && !m.is_owner_supplied,
        }
      : null
  }

  // Part suggestions for a line: its own folder first (the sheet supplier's parts
  // before others'), then the rest of the suggested parts.
  const suggestionsFor = (line: ProjectLine): Part[] => {
    const current =
      (line.part_id ? partById.get(line.part_id) : undefined) ??
      partBySku.get(line.sku.trim().toUpperCase())
    const folderId = current?.folder_id
    if (!folderId) return suggestedParts
    const rank = (p: Part) =>
      p.folder_id === folderId ? (p.supplier_id === sheetSupplierId ? 0 : 1) : 2
    return [...suggestedParts].sort((a, b) => rank(a) - rank(b))
  }

  const renderEditableCell = (
    line: ProjectLine,
    col: EditableCol,
    display: React.ReactNode,
    alignRight = false,
  ) => {
    const isFocused =
      focusedCell?.lineId === line.id && focusedCell?.col === col
    const isEditing =
      editingCell?.lineId === line.id && editingCell?.col === col

    if (isEditing && editingCell) {
      return (
        <GridCellEditor
          key={`${line.id}:${col}`}
          initialValue={editingCell.initial}
          isSku={col === 0}
          parts={col === 0 ? suggestionsFor(line) : suggestedParts}
          showSupplier={allSuppliers}
          alignRight={alignRight}
          onCommit={(value, move) => {
            commitEdit(line, col, value)
            if (move) moveFocus(line.id, col, move.dRow, move.dCol)
          }}
          onCancel={() => {
            setEditingCell(null)
            focusCell(line.id, col)
          }}
          onSelectPart={(part) => {
            handleSelectPart(line, part)
            focusCell(line.id, col)
          }}
        />
      )
    }

    return (
      <div
        ref={(el) => {
          const key = `${line.id}:${col}`
          if (el) cellRefs.current.set(key, el)
          else cellRefs.current.delete(key)
        }}
        tabIndex={editable ? 0 : -1}
        onClick={() => {
          if (editable) focusCell(line.id, col)
        }}
        onDoubleClick={() => {
          if (editable) startEditing(line, col)
        }}
        onKeyDown={(e) => {
          if (!editable) return
          if (e.key === 'Enter' || e.key === 'F2') {
            e.preventDefault()
            startEditing(line, col)
          } else if (e.key === 'ArrowUp') {
            e.preventDefault()
            moveFocus(line.id, col, -1, 0)
          } else if (e.key === 'ArrowDown') {
            e.preventDefault()
            moveFocus(line.id, col, 1, 0)
          } else if (e.key === 'ArrowLeft') {
            e.preventDefault()
            moveFocus(line.id, col, 0, -1)
          } else if (e.key === 'ArrowRight') {
            e.preventDefault()
            moveFocus(line.id, col, 0, 1)
          } else if (e.key === 'Tab') {
            e.preventDefault()
            moveFocus(line.id, col, 0, e.shiftKey ? -1 : 1)
          }
        }}
        className={`min-h-6 flex items-center px-1.5 cursor-cell outline-none ${
          alignRight ? 'justify-end' : 'justify-start'
        } ${
          isFocused
            ? 'ring-2 ring-inset ring-neutral-950 bg-neutral-100'
            : 'hover:bg-neutral-50'
        }`}
      >
        {display}
      </div>
    )
  }

  // Header values over the grid columns, as in the Excel file (rows 2-4).
  // Columns: 8 DESCRIPTION, 9 QTY, 10 COST, 11 COST DOOR, 13 PRICE DOOR,
  // 14 HW PRICE PER DOOR TYPE, 15 OVERALL HW PRICE PER TYPICAL DOOR.
  const label = (text: string, align: 'right' | 'center' = 'center') => (
    <div className={`text-[11px] font-bold uppercase text-neutral-600 ${align === 'right' ? 'text-right' : 'text-center'}`}>
      {text}
    </div>
  )
  const money = (value: number, className = '', testId?: string) => (
    <div className={`px-1.5 py-0.5 text-right font-mono font-bold text-neutral-950 ${className}`} data-testid={testId}>
      {formatCurrency(value)}
    </div>
  )
  const summaryCell = (row: number, col: number): ReactNode => {
    const at = `${row}:${col}`
    switch (at) {
      case '0:10':
        return label('Markup')
      case '1:10':
        return (
          <label
            htmlFor="grid-markup-input"
            className="flex items-center justify-end border-2 border-neutral-950 bg-sky-50 px-1.5 py-0.5"
            aria-label="Markup"
          >
            <input
              id="grid-markup-input"
              type="text"
              inputMode="decimal"
              disabled={!editable}
              value={markupInput}
              onChange={(e) => setMarkupInput(e.target.value)}
              onBlur={async () => {
                const n = Number(markupInput.replace('%', '').trim())
                if (Number.isFinite(n) && n >= 0) {
                  const rounded = Math.round(n * 100) / 100
                  setMarkupPct(rounded)
                  setMarkupInput(rounded.toFixed(2))
                  if (activeVersion && editable) {
                    setSaveStatus('saving')
                    const { error } = await supabase
                      .from('project_versions')
                      .update({ markup_pct: rounded })
                      .eq('id', activeVersion.id)
                    if (error) {
                      setSaveStatus('error')
                      setSaveError(error.message)
                    } else {
                      setSaveStatus('saved')
                      await queryClient.invalidateQueries({
                        queryKey: ['project', activeVersion.project_id],
                      })
                    }
                  }
                } else {
                  setMarkupInput(markupPct.toFixed(2))
                }
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.currentTarget.blur()
                }
              }}
              className="w-14 text-right font-mono font-bold text-neutral-950 focus:outline-none disabled:bg-transparent"
            />
            <span className="font-mono font-bold text-neutral-700 ml-0.5">%</span>
          </label>
        )
      case '0:11':
        return label('Total cost')
      case '1:11':
        return money(projectTotal, 'bg-orange-100')
      case '0:13':
        return label('Total + markup')
      case '1:13':
        return money(projectTotalWithMarkup)
      case '0:15':
        return label('Total ex. GST')
      case '1:14':
        return label('Incl. deliveries / excl. GST', 'right')
      case '1:15':
        return money(totalExGst, 'border border-neutral-950 bg-sky-100', 'grid-total-ex-gst')
      case '2:8':
        return <div className="text-right text-[11px] font-bold uppercase text-sky-900">Overall door qty:</div>
      case '2:9':
        return <div className="text-right font-mono font-bold text-neutral-950" data-testid="grid-overall-door-qty">{totalDoors}</div>
      case '2:14':
        return label('Deliveries', 'right')
      case '2:15':
        return money(deliveries, 'bg-sky-50')
      default:
        return null
    }
  }

  return (
    <div>
    <div className="space-y-3">
      {saveError && (
        <div
          role="alert"
          className="border border-neutral-950 bg-neutral-50 p-3 text-xs text-neutral-950 flex items-start gap-2"
        >
          <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
          <span className="flex-1">{saveError}</span>
          {saveStatus === 'error' && dirtyIdsRef.current.size > 0 && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => void flushDirtyLines()}
            >
              Retry
            </Button>
          )}
        </div>
      )}

      {/* Skeleton until the groups, their lines, the sheets (lines show per
          sheet) and the parts (LEGEND / MANUFACTURER) are all in, so the grid
          appears once, complete. */}
      {sheetsLoading ||
      groupsQuery.isLoading ||
      projectLinesQuery.isLoading ||
      partsQuery.isLoading ||
      (versionId !== null && linesVersionId !== versionId && !projectLinesQuery.isError) ? (
        <GridSkeleton />
      ) : groups.length === 0 ? (
        <div className="border border-dashed border-neutral-300 bg-neutral-50 p-8 text-center text-xs text-neutral-600">
          No door groups in this version yet.
        </div>
      ) : (
        <div className="border border-neutral-400 bg-white">
          {/* Sheet / version, other-supplier toggle and save status. */}
          <div className="flex flex-wrap items-center justify-between gap-3 px-3 py-1.5 border-b border-neutral-400 bg-white">
            <div className="text-[11px] text-neutral-500">
              {sheet ? `Sheet: ${sheet.name} • ` : ''}
              v{activeVersion.version_no} ({activeVersion.status.toUpperCase()})
              {editable && ' • Arrow keys move, Enter/F2 edit, Tab next, Esc cancel'}
            </div>
            <div className="flex items-center gap-4 text-xs">
              {editable && selectedGroupIds.size > 0 && (
                <span className="flex items-center gap-2">
                  <Button
                    type="button"
                    size="sm"
                    className="h-7"
                    disabled={selectedGroups.length < 2}
                    onClick={() => {
                      setMergeError(null)
                      setMergePlan(planMerge(selectedGroups, lines))
                      setMergeOpen(true)
                    }}
                    title={selectedGroups.length < 2 ? 'Tick at least two door groups' : undefined}
                  >
                    <Merge className="h-3.5 w-3.5" />
                    <span>Merge {selectedGroups.length} groups</span>
                  </Button>
                  <button
                    type="button"
                    className="text-[11px] text-neutral-600 underline hover:text-neutral-950"
                    onClick={() => setSelectedGroupIds(new Set())}
                  >
                    Clear
                  </button>
                </span>
              )}
              {editable && sheetSupplierId && (
                <label
                  className="flex items-center gap-1.5 text-[11px] text-neutral-700 select-none"
                  title="Part suggestions come from this sheet's supplier. Tick to pick a part from another supplier (e.g. out of stock)."
                >
                  <input
                    type="checkbox"
                    checked={allSuppliers}
                    onChange={(e) => setAllSuppliers(e.target.checked)}
                    data-testid="other-suppliers-toggle"
                  />
                  Parts from other suppliers
                </label>
              )}
              {editable && (
                <Badge variant="outline" className="font-mono text-[11px] gap-1.5">
                  {saveStatus === 'saving' && (
                    <>
                      <Loader2 className="h-3 w-3 animate-spin" />
                      <span>Saving...</span>
                    </>
                  )}
                  {saveStatus === 'unsaved' && <span>Unsaved...</span>}
                  {saveStatus === 'saved' && (
                    <>
                      <Check className="h-3 w-3" />
                      <span>Saved</span>
                    </>
                  )}
                  {saveStatus === 'error' && (
                    <>
                      <AlertTriangle className="h-3 w-3" />
                      <span>Save failed</span>
                    </>
                  )}
                </Badge>
              )}
            </div>
          </div>

          {/* The Export button sits in the page's button row (next to Submit). */}
          {exportSlot &&
            createPortal(
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={exporting || groups.length === 0}
                onClick={() => {
                  setExportError(null)
                  setExportOpen(true)
                }}
              >
                <Download className="h-3.5 w-3.5" />
                <span>{exporting ? 'Exporting...' : 'Export Excel'}</span>
              </Button>,
              exportSlot,
            )}

          {/*
            Single Connected Excel Grid. It scrolls inside a box that fits the
            screen, so the column headers stay in view. It scrolls sideways
            natively; its own horizontal scrollbar is pulled under the clipping
            wrapper (negative margin) and the pinned bottom bar shows one instead.
          */}
          <div className="overflow-hidden">
          <div
            ref={setGridScroll}
            onScroll={(e) => {
              if (showHScroll) followScroll('grid', e.currentTarget.scrollLeft)
            }}
            style={{ marginBottom: -hBarHeight }}
            className="max-h-[max(18rem,calc(100dvh_-_9rem))] overflow-auto"
            data-testid="hardware-grid-scroll"
          >
          <table className="w-auto border-collapse text-xs">
            <thead className="text-neutral-950">
              {/*
                The Excel export's rows 2-4, each value over the same column as
                in the file: markup over COST, door qty over QTY, total ex. GST
                and deliveries over OVERALL HW PRICE PER TYPICAL DOOR. These
                scroll away; the column headers below stay pinned.
              */}
              {[0, 1, 2].map((row) => (
                <tr key={`summary-${row}`} className="bg-white" data-testid="grid-summary-row">
                  <td colSpan={5} className="px-3 py-1 text-sm font-bold uppercase text-neutral-600 whitespace-nowrap">
                    {row === 0 && <>Project: {(projectTitle || projectName).toUpperCase()}</>}
                    {row === 1 && <>Client: {(clientName || '').toUpperCase()}</>}
                    {row === 2 && <span className="normal-case">Schedule #:</span>}
                  </td>
                  {GRID_COLUMNS.slice(5).map((c, i) => {
                    const col = i + 5
                    return (
                      <td key={c.label} className="px-2 py-1 whitespace-nowrap">
                        {summaryCell(row, col)}
                      </td>
                    )
                  })}
                  {editable && <td />}
                </tr>
              ))}
              <tr>
                {GRID_COLUMNS.map((c) => (
                  <th
                    key={c.label}
                    className={`sticky top-0 z-10 border border-neutral-400 px-2 py-1.5 font-bold uppercase tracking-wider whitespace-nowrap shadow-[0_1px_0_0_#a3a3a3] ${
                      c.align === 'right' ? 'text-right' : c.align === 'center' ? 'text-center' : 'text-left'
                    } ${c.label === 'MHQT REMARKS' ? 'bg-yellow-200' : 'bg-neutral-200'}`}
                  >
                    {c.label}
                  </th>
                ))}
                {editable && (
                  <th className="sticky top-0 z-10 border border-neutral-400 bg-neutral-200 px-2 py-1.5 text-center font-bold uppercase tracking-wider whitespace-nowrap shadow-[0_1px_0_0_#a3a3a3]">
                    ACTIONS
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {groups.map((group) => {
                const groupLines = linesByGroup.get(group.id) ?? []
                const doorTag =
                  group.door_tag ||
                  (group.match_status === 'manual' &&
                  !group.matched_set_id &&
                  group.match_reason?.startsWith('Custom:')
                    ? group.match_reason.replace(/^Custom:\s*/, '')
                    : '')

                return (
                  <GroupRowsFragment
                    key={group.id}
                    group={group}
                    doorTag={doorTag}
                    groupLines={groupLines}
                    markupFactor={markupFactor}
                    supplierOf={supplierOf}
                    editable={editable}
                    commentCount={commentCounts?.get(group.id) ?? 0}
                    onOpenComments={onOpenComments ? () => onOpenComments(group.id) : undefined}
                    highlighted={highlightGroupId === group.id}
                    renderEditableCell={renderEditableCell}
                    onAddLine={() => void handleAddLine(group.id)}
                    onDeleteLine={(line) => void handleDeleteLine(line)}
                    onClearFlag={handleClearFlag}
                    onMoveLine={(line, dir) =>
                      void handleMoveLine(group.id, line, dir)
                    }
                    selected={selectedGroupIds.has(group.id)}
                    onToggleSelect={editable ? () => toggleGroupSelected(group.id) : undefined}
                    onUnmerge={
                      editable && (group.merged_from?.length ?? 0) >= 2 ? () => void handleUnmerge(group) : undefined
                    }
                    quoteInfo={quoteInfoOf(group)}
                  />
                )
              })}
            </tbody>
          </table>
          </div>
          </div>
        </div>
      )}

      <MergeGroupsDialog
        open={mergeOpen}
        onOpenChange={setMergeOpen}
        plan={mergePlan}
        sheetName={sheetNameOf}
        busy={mergeBusy}
        error={mergeError}
        onConfirm={(roomName, include) => void handleMerge(roomName, include)}
      />

      {activeVersion && (
        <ExportExcelDialog
          open={exportOpen}
          onOpenChange={setExportOpen}
          projectId={activeVersion.project_id}
          busy={exporting}
          error={exportError}
          sheets={sheets}
          onExport={async ({ scheduleNo, sheetTitle, sheetIds }) => {
            setExporting(true)
            setExportError(null)
            try {
              const { downloadProjectExcel } = await import(
                '@/features/projects/projectExcelExport'
              )
              await downloadProjectExcel({
                projectName,
                projectTitle,
                clientName,
                scheduleNo,
                sheetTitle,
                version: { ...activeVersion, markup_pct: markupPct },
                groups,
                lines,
                // Only the sheets ticked in the dialog.
                sheets: sheets.filter((s) => sheetIds.includes(s.id)),
                quoteName: clientName,
                // One sheet picked out of several: its name goes in the file name.
                fileSuffix:
                  sheets.length > 1 && sheetIds.length === 1
                    ? sheets.find((s) => s.id === sheetIds[0])?.name
                    : undefined,
                parts,
              })
              setExportOpen(false)
            } catch (err) {
              setExportError(err instanceof Error ? err.message : 'Failed to export Excel.')
            } finally {
              setExporting(false)
            }
          }}
        />
      )}
    </div>

      {/*
        Pinned to the bottom of the screen while the grid is in view. The
        negative offset cancels the page area's bottom padding (--page-pad, set
        in AppShell), since sticky offsets count from it.
      */}
      <div
        className="sticky bottom-[calc(-1*var(--page-pad,0px))] z-20 bg-white"
        data-testid="grid-bottom-bar"
      >
        <div
          ref={hScrollRef}
          aria-hidden="true"
          onScroll={(e) => followScroll('bar', e.currentTarget.scrollLeft)}
          className={`overflow-x-auto overflow-y-hidden border-x border-neutral-400 bg-white ${showHScroll ? '' : 'hidden'}`}
          data-testid="grid-bottom-hscroll"
        >
          <div style={{ width: hScrollWidth, height: 1 }} />
        </div>
        {footer}
      </div>
    </div>
  )
}
