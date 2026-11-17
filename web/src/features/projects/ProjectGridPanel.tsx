import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  Check,
  Loader2,
  Plus,
  Trash2,
} from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { formatCurrency } from '@/lib/utils'
import { parseNullablePriceInput } from '@/lib/schemas'
import type {
  DoorGroup,
  Part,
  ProjectLine,
  ProjectVersion,
} from '@/types/database'
import { SkuAutocomplete } from '@/features/standard-sets/SkuAutocomplete'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

interface ProjectGridPanelProps {
  projectName: string
  builderName: string
  activeVersion: ProjectVersion | null
  canEdit: boolean
}

type EditableCol = 0 | 1 | 2 | 3 // 0: sku, 1: description, 2: qty_per_door, 3: unit_price
type SaveStatus = 'saved' | 'unsaved' | 'saving' | 'error'

export function ProjectGridPanel({
  projectName,
  builderName,
  activeVersion,
  canEdit,
}: ProjectGridPanelProps) {
  const queryClient = useQueryClient()
  const isDraft = activeVersion?.status === 'draft'
  const editable = canEdit && isDraft

  const [lines, setLines] = useState<ProjectLine[]>([])
  const [markupPct, setMarkupPct] = useState<number>(15)
  const [markupInput, setMarkupInput] = useState<string>('15.00')
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('saved')
  const [saveError, setSaveError] = useState<string | null>(null)
  const [focusedCell, setFocusedCell] = useState<{
    lineId: string
    col: EditableCol
  } | null>(null)
  const [editingCell, setEditingCell] = useState<{
    lineId: string
    col: EditableCol
  } | null>(null)
  const [draftValue, setDraftValue] = useState('')

  const dirtyIdsRef = useRef<Set<string>>(new Set())
  const linesRef = useRef<ProjectLine[]>([])
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const cellRefs = useRef<Map<string, HTMLDivElement>>(new Map())

  const groupsQuery = useQuery({
    queryKey: ['door_groups', activeVersion?.id],
    enabled: !!activeVersion?.id,
    queryFn: async (): Promise<DoorGroup[]> => {
      const { data, error } = await supabase
        .from('door_groups')
        .select(
          'id, version_id, position, group_key, room_name, classification, leaf, door_size, door_qty, matched_set_id, match_status, match_score, match_reason, pm_remarks, created_at, updated_at',
        )
        .eq('version_id', activeVersion!.id)
        .order('position', { ascending: true })
      if (error) throw error
      return (data ?? []) as DoorGroup[]
    },
  })

  const groups = useMemo(() => groupsQuery.data ?? [], [groupsQuery.data])
  const groupIds = useMemo(() => groups.map((g) => g.id), [groups])

  const projectLinesQuery = useQuery({
    queryKey: ['project_lines', activeVersion?.id, groupIds],
    enabled: !!activeVersion?.id && groupIds.length > 0,
    queryFn: async (): Promise<ProjectLine[]> => {
      const { data, error } = await supabase
        .from('project_lines')
        .select(
          'id, group_id, position, sku, description, qty_per_door, unit_price, origin, part_id, created_at, updated_at',
        )
        .in('group_id', groupIds)
        .order('position', { ascending: true })
      if (error) throw error
      return (data ?? []) as ProjectLine[]
    },
  })

  const partsQuery = useQuery({
    queryKey: ['parts', 'for-grid'],
    queryFn: async (): Promise<Part[]> => {
      const { data, error } = await supabase
        .from('parts')
        .select(
          'id, sku, manufacturer_id, description, unit_cost, active, created_at, updated_at',
        )
        .eq('active', true)
        .order('sku', { ascending: true })
      if (error) throw error
      return (data ?? []) as Part[]
    },
  })

  const parts = useMemo(() => partsQuery.data ?? [], [partsQuery.data])

  useEffect(() => {
    if (projectLinesQuery.data && dirtyIdsRef.current.size === 0) {
      setLines(projectLinesQuery.data)
      linesRef.current = projectLinesQuery.data
    }
  }, [projectLinesQuery.data])

  useEffect(() => {
    linesRef.current = lines
  }, [lines])

  const flushDirtyLines = useCallback(async () => {
    const ids = Array.from(dirtyIdsRef.current)
    if (ids.length === 0) return
    dirtyIdsRef.current.clear()
    setSaveStatus('saving')
    setSaveError(null)

    try {
      const currentMap = new Map(linesRef.current.map((l) => [l.id, l]))
      for (const id of ids) {
        const line = currentMap.get(id)
        if (!line) continue
        const { error } = await supabase
          .from('project_lines')
          .update({
            sku: line.sku,
            description: line.description,
            qty_per_door: line.qty_per_door,
            unit_price: line.unit_price,
            origin: line.origin,
            part_id: line.part_id,
          })
          .eq('id', line.id)
        if (error) throw error
      }
      setSaveStatus('saved')
      await queryClient.invalidateQueries({
        queryKey: ['project_lines', activeVersion?.id],
      })
    } catch (err) {
      setSaveStatus('error')
      setSaveError(err instanceof Error ? err.message : 'Failed to save changes.')
    }
  }, [activeVersion?.id, queryClient])

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

  const linesByGroup = useMemo(() => {
    const map = new Map<string, ProjectLine[]>()
    for (const g of groups) map.set(g.id, [])
    for (const l of lines) {
      const arr = map.get(l.group_id)
      if (arr) arr.push(l)
    }
    for (const arr of map.values()) {
      arr.sort((a, b) => a.position - b.position)
    }
    return map
  }, [groups, lines])

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
      }
      setDraftValue(initial)
      setEditingCell({ lineId: line.id, col })
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
      if (nextCol > 3) {
        nextCol = 0
        nextRow += 1
      } else if (nextCol < 0) {
        nextCol = 3
        nextRow -= 1
      }
      if (nextRow < 0 || nextRow >= flatLineIds.length) return
      focusCell(flatLineIds[nextRow], nextCol as EditableCol)
    },
    [flatLineIds, focusCell],
  )

  const handleAddLine = async (groupId: string) => {
    if (!editable) return
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
        position: nextPos,
        sku: '',
        description: 'New hardware item',
        qty_per_door: 1,
        unit_price: null,
        origin: 'added',
        part_id: null,
      })
      .select(
        'id, group_id, position, sku, description, qty_per_door, unit_price, origin, part_id, created_at, updated_at',
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
    const tempPos = Math.max(...groupLines.map((l) => l.position)) + 1000
    setSaveStatus('saving')
    setSaveError(null)

    try {
      const { error: e1 } = await supabase
        .from('project_lines')
        .update({ position: tempPos })
        .eq('id', line.id)
      if (e1) throw e1

      const { error: e2 } = await supabase
        .from('project_lines')
        .update({ position: line.position })
        .eq('id', other.id)
      if (e2) throw e2

      const { error: e3 } = await supabase
        .from('project_lines')
        .update({ position: other.position })
        .eq('id', line.id)
      if (e3) throw e3

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
      setSaveError(err instanceof Error ? err.message : 'Failed to reorder line.')
    }
  }

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

  if (!activeVersion) return null

  const markupFactor = 1 + markupPct / 100
  const totalDoors = groups.reduce((sum, g) => sum + Number(g.door_qty), 0)
  const groupById = new Map(groups.map((g) => [g.id, g]))
  const projectTotal = lines.reduce((sum, l) => {
    if (l.unit_price === null) return sum
    const dQty = Number(groupById.get(l.group_id)?.door_qty ?? 0)
    return sum + Number(l.qty_per_door) * dQty * Number(l.unit_price)
  }, 0)
  const projectTotalWithMarkup = projectTotal * markupFactor

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

    if (isEditing && col === 0) {
      return (
        <div
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault()
              setEditingCell(null)
              focusCell(line.id, col)
            } else if (e.key === 'Tab') {
              e.preventDefault()
              commitEdit(line, col, draftValue)
              moveFocus(line.id, col, 0, e.shiftKey ? -1 : 1)
            }
          }}
        >
          <SkuAutocomplete
            value={draftValue}
            parts={parts}
            onChange={setDraftValue}
            onSelectPart={(part) => {
              handleSelectPart(line, part)
              focusCell(line.id, col)
            }}
            placeholder="SKU..."
          />
        </div>
      )
    }

    if (isEditing) {
      return (
        <Input
          autoFocus
          value={draftValue}
          onChange={(e) => setDraftValue(e.target.value)}
          onBlur={() => commitEdit(line, col, draftValue)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              commitEdit(line, col, draftValue)
              moveFocus(line.id, col, 1, 0)
            } else if (e.key === 'Tab') {
              e.preventDefault()
              commitEdit(line, col, draftValue)
              moveFocus(line.id, col, 0, e.shiftKey ? -1 : 1)
            } else if (e.key === 'Escape') {
              e.preventDefault()
              setEditingCell(null)
              focusCell(line.id, col)
            }
          }}
          className={`h-6 px-1.5 text-xs font-mono rounded-none border-neutral-950 ${
            alignRight ? 'text-right' : ''
          }`}
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
          <span>{saveError}</span>
        </div>
      )}

      {groups.length === 0 ? (
        <div className="border border-dashed border-neutral-300 bg-neutral-50 p-8 text-center text-xs text-neutral-600">
          No door groups in this version yet.
        </div>
      ) : (
        <div className="border border-neutral-400 bg-white overflow-x-auto">
          {/* Excel-style Workbook Title Strip */}
          <div className="flex flex-wrap items-center justify-between gap-4 px-3 py-2.5 border-b border-neutral-400 bg-white">
            <div>
              <div className="text-sm font-bold tracking-tight text-neutral-950 uppercase">
                DOOR HARDWARE SET — {projectName}
              </div>
              <div className="text-[11px] text-neutral-600">
                {builderName || 'Mena Contractors'} • v{activeVersion.version_no} (
                {activeVersion.status.toUpperCase()})
                {editable &&
                  ' • Arrow keys move, Enter/F2 edit, Tab next, Esc cancel'}
              </div>
            </div>

            <div className="flex items-center gap-4 text-xs">
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
            </div>
          </div>

          {/* Single Connected Excel Grid */}
          <table className="w-auto border-collapse text-xs">
            <thead className="sticky top-0 z-10 bg-neutral-200 text-neutral-950">
              <tr>
                <th className="border border-neutral-400 px-2 py-1.5 text-left font-bold uppercase tracking-wider whitespace-nowrap">
                  ROOM NAME
                </th>
                <th className="border border-neutral-400 px-2 py-1.5 text-left font-bold uppercase tracking-wider whitespace-nowrap">
                  DOOR TAG
                </th>
                <th className="border border-neutral-400 px-2 py-1.5 text-left font-bold uppercase tracking-wider whitespace-nowrap">
                  DOOR SIZE
                </th>
                <th className="border border-neutral-400 px-2 py-1.5 text-left font-bold uppercase tracking-wider whitespace-nowrap">
                  DOOR CLASSIFICATION
                </th>
                <th className="border border-neutral-400 px-2 py-1.5 text-left font-bold uppercase tracking-wider whitespace-nowrap">
                  LEAFS
                </th>
                <th className="border border-neutral-400 px-2 py-1.5 text-left font-bold uppercase tracking-wider whitespace-nowrap">
                  PART NUMBER (SKU)
                </th>
                <th className="border border-neutral-400 px-2 py-1.5 text-left font-bold uppercase tracking-wider whitespace-nowrap">
                  HARDWARE DESCRIPTION
                </th>
                <th className="border border-neutral-400 px-2 py-1.5 text-right font-bold uppercase tracking-wider whitespace-nowrap">
                  QTY
                </th>
                <th className="border border-neutral-400 px-2 py-1.5 text-right font-bold uppercase tracking-wider whitespace-nowrap">
                  PRICE
                </th>
                <th className="border border-neutral-400 px-2 py-1.5 text-right font-bold uppercase tracking-wider whitespace-nowrap">
                  COST
                </th>
                <th className="border border-neutral-400 px-2 py-1.5 text-right font-bold uppercase tracking-wider whitespace-nowrap">
                  COST + MARKUP
                </th>
                <th className="border border-neutral-400 px-2 py-1.5 text-left font-bold uppercase tracking-wider whitespace-nowrap">
                  PM REMARKS
                </th>
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
                const groupCost = groupLines.reduce((sum, l) => {
                  if (l.unit_price === null) return sum
                  return (
                    sum +
                    Number(l.qty_per_door) *
                      Number(group.door_qty) *
                      Number(l.unit_price)
                  )
                }, 0)

                const doorTag =
                  group.match_status === 'manual' &&
                  !group.matched_set_id &&
                  group.match_reason?.startsWith('Custom:')
                    ? group.match_reason.replace(/^Custom:\s*/, '')
                    : ''

                return (
                  <GroupRowsFragment
                    key={group.id}
                    group={group}
                    doorTag={doorTag}
                    groupLines={groupLines}
                    groupCost={groupCost}
                    markupFactor={markupFactor}
                    editable={editable}
                    renderEditableCell={renderEditableCell}
                    onAddLine={() => void handleAddLine(group.id)}
                    onDeleteLine={(line) => void handleDeleteLine(line)}
                    onMoveLine={(line, dir) =>
                      void handleMoveLine(group.id, line, dir)
                    }
                  />
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

interface GroupRowsFragmentProps {
  group: DoorGroup
  doorTag: string
  groupLines: ProjectLine[]
  groupCost: number
  markupFactor: number
  editable: boolean
  renderEditableCell: (
    line: ProjectLine,
    col: EditableCol,
    display: React.ReactNode,
    alignRight?: boolean,
  ) => React.ReactNode
  onAddLine: () => void
  onDeleteLine: (line: ProjectLine) => void
  onMoveLine: (line: ProjectLine, dir: -1 | 1) => void
}

function GroupRowsFragment({
  group,
  doorTag,
  groupLines,
  groupCost,
  markupFactor,
  editable,
  renderEditableCell,
  onAddLine,
  onDeleteLine,
  onMoveLine,
}: GroupRowsFragmentProps) {
  return (
    <>
      {/* Door Group Header Row (matches Excel DOOR HARDWARE SET sheet) */}
      <tr className="bg-neutral-100 font-semibold text-neutral-950">
        <td className="border border-neutral-300 px-2 py-1 whitespace-nowrap">
          {group.room_name}
        </td>
        <td className="border border-neutral-300 px-2 py-1 whitespace-nowrap font-normal text-neutral-700">
          {doorTag}
        </td>
        <td className="border border-neutral-300 px-2 py-1 whitespace-nowrap font-mono">
          {group.door_size || ''}
        </td>
        <td className="border border-neutral-300 px-2 py-1 whitespace-nowrap">
          {group.classification || ''}
        </td>
        <td className="border border-neutral-300 px-2 py-1 whitespace-nowrap">
          {group.leaf || ''}
        </td>
        <td className="border border-neutral-300 px-2 py-1" />
        <td className="border border-neutral-300 px-2 py-1" />
        <td className="border border-neutral-300 px-2 py-1 text-right font-mono bg-neutral-200/70 whitespace-nowrap">
          DOOR QTY: {group.door_qty}
        </td>
        <td className="border border-neutral-300 px-2 py-1" />
        <td className="border border-neutral-300 px-2 py-1 text-right font-mono whitespace-nowrap">
          {formatCurrency(groupCost)}
        </td>
        <td className="border border-neutral-300 px-2 py-1 text-right font-mono whitespace-nowrap">
          {formatCurrency(groupCost * markupFactor)}
        </td>
        <td className="border border-neutral-300 px-2 py-1 text-xs text-neutral-700 whitespace-nowrap">
          {group.pm_remarks || ''}
        </td>
        {editable && (
          <td className="border border-neutral-300 px-1 py-0.5 text-center">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-6 px-1.5 text-[11px]"
              onClick={onAddLine}
            >
              <Plus className="h-3 w-3" />
              <span>Add</span>
            </Button>
          </td>
        )}
      </tr>

      {/* Hardware Line Rows directly beneath */}
      {groupLines.map((line, idx) => {
        const lineCost =
          line.unit_price === null
            ? null
            : Number(line.qty_per_door) *
              Number(group.door_qty) *
              Number(line.unit_price)

        const isAdded = line.origin === 'added'
        const addedBg = isAdded ? 'bg-green-100/80' : ''

        return (
          <tr key={line.id} className="bg-white">
            <td className="border border-neutral-300 px-2 py-0.5" />
            <td className="border border-neutral-300 px-2 py-0.5" />
            <td className="border border-neutral-300 px-2 py-0.5" />
            <td className="border border-neutral-300 px-2 py-0.5" />
            <td className="border border-neutral-300 px-2 py-0.5" />
            <td className={`border border-neutral-300 p-0 whitespace-nowrap ${addedBg}`}>
              {renderEditableCell(
                line,
                0,
                <span className="font-mono text-xs font-medium text-neutral-950 whitespace-nowrap">
                  {line.sku || <span className="text-neutral-400">—</span>}
                </span>,
              )}
            </td>
            <td className={`border border-neutral-300 p-0 whitespace-nowrap ${addedBg}`}>
              {renderEditableCell(
                line,
                1,
                <span className="text-xs text-neutral-900 whitespace-nowrap">
                  {line.description || <span className="text-neutral-400">—</span>}
                </span>,
              )}
            </td>
            <td className={`border border-neutral-300 p-0 whitespace-nowrap ${addedBg}`}>
              {renderEditableCell(
                line,
                2,
                <span className="font-mono text-xs">{line.qty_per_door}</span>,
                true,
              )}
            </td>
            <td className={`border border-neutral-300 p-0 whitespace-nowrap ${addedBg}`}>
              {renderEditableCell(
                line,
                3,
                line.unit_price === null ? (
                  <span className="font-mono text-xs text-neutral-400">—</span>
                ) : (
                  <span className="font-mono text-xs">
                    {formatCurrency(line.unit_price)}
                  </span>
                ),
                true,
              )}
            </td>
            <td className={`border border-neutral-300 px-2 py-0.5 text-right font-mono text-xs text-neutral-900 whitespace-nowrap ${addedBg}`}>
              {lineCost === null ? (
                <span className="text-neutral-400">—</span>
              ) : (
                formatCurrency(lineCost)
              )}
            </td>
            <td className={`border border-neutral-300 px-2 py-0.5 text-right font-mono text-xs text-neutral-900 whitespace-nowrap ${addedBg}`}>
              {lineCost === null ? (
                <span className="text-neutral-400">—</span>
              ) : (
                formatCurrency(lineCost * markupFactor)
              )}
            </td>
            <td className={`border border-neutral-300 px-2 py-0.5 text-xs text-neutral-600 whitespace-nowrap ${addedBg}`} />
            {editable && (
              <td className="border border-neutral-300 px-1 py-0.5 text-center">
                <div className="inline-flex items-center gap-0.5">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-5 w-5"
                    disabled={idx === 0}
                    aria-label="Move line up"
                    onClick={() => onMoveLine(line, -1)}
                  >
                    <ArrowUp className="h-3 w-3" />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-5 w-5"
                    disabled={idx === groupLines.length - 1}
                    aria-label="Move line down"
                    onClick={() => onMoveLine(line, 1)}
                  >
                    <ArrowDown className="h-3 w-3" />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-5 w-5"
                    aria-label="Delete line"
                    onClick={() => onDeleteLine(line)}
                  >
                    <Trash2 className="h-3 w-3" />
                  </Button>
                </div>
              </td>
            )}
          </tr>
        )
      })}
    </>
  )
}
