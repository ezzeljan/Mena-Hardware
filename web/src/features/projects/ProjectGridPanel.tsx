import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AlertTriangle,
  Check,
  Download,
  Loader2,
} from 'lucide-react'
import { supabase } from '@/lib/supabase'
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
}: ProjectGridPanelProps) {
  const queryClient = useQueryClient()
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

  useEffect(() => {
    if (projectLinesQuery.data && dirtyIdsRef.current.size === 0) {
      setLines(projectLinesQuery.data)
      linesRef.current = projectLinesQuery.data
    }
  }, [projectLinesQuery.data])

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

  return (
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

      {groups.length === 0 ? (
        <div className="border border-dashed border-neutral-300 bg-neutral-50 p-8 text-center text-xs text-neutral-600">
          No door groups in this version yet.
        </div>
      ) : (
        <div className="border border-neutral-400 bg-white">
          {/* Excel-style Workbook Title Strip */}
          <div className="flex flex-wrap items-center justify-between gap-4 px-3 py-2.5 border-b border-neutral-400 bg-white">
            {/* Same header rows as the Excel export (rows 2-4); the sheet title
                and schedule # are only chosen when exporting. */}
            <div className="space-y-0.5">
              <div className="text-sm font-bold uppercase text-neutral-600">
                Project: {(projectTitle || projectName).toUpperCase()}
              </div>
              <div className="text-sm font-bold uppercase text-neutral-600">
                Client: {(clientName || '').toUpperCase()}
              </div>
              <div className="text-sm font-bold text-neutral-600">Schedule #:</div>
              <div className="pt-0.5 text-[11px] text-neutral-500">
                {sheet ? `Sheet: ${sheet.name} • ` : ''}
                v{activeVersion.version_no} ({activeVersion.status.toUpperCase()})
                {editable &&
                  ' • Arrow keys move, Enter/F2 edit, Tab next, Esc cancel'}
              </div>
            </div>

            <div className="flex items-center gap-4 text-xs">
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

              <div className="flex items-center border border-neutral-400">
                <label
                  htmlFor="grid-markup-input"
                  className="px-2 py-1 bg-neutral-100 font-semibold text-neutral-700 border-r border-neutral-400"
                >
                  MARKUP:
                </label>
                <div className="flex items-center px-1.5 py-0.5 bg-white">
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
                  <span className="font-mono font-bold text-neutral-700 ml-0.5">
                    %
                  </span>
                </div>
              </div>

              <div className="flex items-center border border-neutral-400">
                <span className="px-2 py-1 bg-neutral-100 font-semibold text-neutral-700 border-r border-neutral-400">
                  OVERALL DOOR QTY:
                </span>
                <span className="px-2.5 py-1 font-mono font-bold text-neutral-950">
                  {totalDoors}
                </span>
              </div>

              <div className="flex items-center border border-neutral-400">
                <span className="px-2 py-1 bg-neutral-100 font-semibold text-neutral-700 border-r border-neutral-400">
                  TOTAL COST:
                </span>
                <span className="px-2.5 py-1 font-mono font-bold text-neutral-950">
                  {formatCurrency(projectTotal)}
                </span>
              </div>

              <div className="flex items-center border border-neutral-400">
                <span className="px-2 py-1 bg-neutral-100 font-semibold text-neutral-700 border-r border-neutral-400">
                  TOTAL + MARKUP:
                </span>
                <span className="px-2.5 py-1 font-mono font-bold text-neutral-950">
                  {formatCurrency(projectTotalWithMarkup)}
                </span>
              </div>

              <div className="flex items-center border border-neutral-400">
                <span className="px-2 py-1 bg-neutral-100 font-semibold text-neutral-700 border-r border-neutral-400">
                  DELIVERIES:
                </span>
                <span className="px-2.5 py-1 font-mono font-bold text-neutral-950">
                  {formatCurrency(deliveries)}
                </span>
              </div>

              <div className="flex items-center border border-neutral-950">
                <span className="px-2 py-1 bg-sky-100 font-semibold text-neutral-950 border-r border-neutral-950">
                  TOTAL EX. GST:
                </span>
                <span className="px-2.5 py-1 font-mono font-bold text-neutral-950" data-testid="grid-total-ex-gst">
                  {formatCurrency(totalExGst)}
                </span>
              </div>

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
              </Button>
            </div>
          </div>

          {/*
            Single Connected Excel Grid. It scrolls inside a box that fits the
            screen, so the horizontal scrollbar and the column headers stay in
            view instead of only at the bottom / top of a long schedule.
          */}
          <div
            className="max-h-[max(18rem,calc(100dvh_-_9rem))] overflow-auto"
            data-testid="hardware-grid-scroll"
          >
          <table className="w-auto border-collapse text-xs">
            <thead className="sticky top-0 z-10 bg-neutral-200 text-neutral-950 shadow-[0_1px_0_0_#a3a3a3]">
              <tr>
                {GRID_COLUMNS.map((c) => (
                  <th
                    key={c.label}
                    className={`border border-neutral-400 px-2 py-1.5 font-bold uppercase tracking-wider whitespace-nowrap ${
                      c.align === 'right' ? 'text-right' : c.align === 'center' ? 'text-center' : 'text-left'
                    } ${c.label === 'MHQT REMARKS' ? 'bg-yellow-200' : ''}`}
                  >
                    {c.label}
                  </th>
                ))}
                {editable && (
                  <th className="border border-neutral-400 px-2 py-1.5 text-center font-bold uppercase tracking-wider whitespace-nowrap">
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
                  />
                )
              })}
            </tbody>
          </table>
          </div>
        </div>
      )}

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
  )
}
