import { MergeDraftGroupsDialog } from '@/features/projects/MergeDraftGroupsDialog'
import {
  buildMergedGroup,
  planDraftMerge,
  unmergeGroup,
  type DraftMergePlan,
} from '@/features/projects/mergeParsedGroups'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  CheckCheck,
  CheckCircle2,
  FileSpreadsheet,
  Sparkles,
  Upload,
  X,
  Merge,
  Search,
  Split,
} from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { fetchAllRows } from '@/lib/fetchAll'
import { changeCounts, compareDoors, type DoorChanges, type DoorRecord } from '@/features/projects/doorChanges'
import { DoorChangesSummary } from '@/features/projects/DoorChangesSummary'
import { useAuth } from '@/features/auth/AuthContext'
import type {
  DoorGroup,
  ProjectLine,
  ProjectVersion,
  StandardSet,
  StandardSetLine,
} from '@/types/database'
import { fetchVersionGroups, fetchVersionLines } from '@/features/projects/projectData'
import {
  customNameFromReason,
  diffQuotationGroups,
} from '@/features/projects/quotationReimport'
import {
  applyRowInclusions,
  type ParsedDoorGroupPreview,
  type QuotationParseResult,
} from '@/features/projects/quotationParser'
import {
  makePartIndex,
  parseDoorSize,
  sizeSetLines,
  type SizedLines,
  type SizingPart,
} from '@/features/projects/doorSizing'
import { applyFlagRules, markByOthers } from '@/features/projects/doorFlags'
import { applyHingeType } from '@/features/projects/hingeRules'
import { resolveGenericItem, type GenericItem, type GenericPreference } from '@/features/projects/genericParts'
import { fetchVersionSheets } from '@/features/projects/projectData'
import { applyActivityRules } from '@/features/projects/activityRules'
import { applyLockRules } from '@/features/projects/lockRules'
import { makeGroupFinder } from '@/features/projects/groupKey'
import { parseQuotationInBackground } from '@/features/projects/quotationParseClient'
import { ParsingProgress, type ImportProgress } from '@/features/projects/ParsingProgress'
import { SplitGroupsTable } from '@/features/projects/SplitGroupsTable'
import { CommentsCell, HardwareCell, NoteList } from '@/features/projects/quotationDisplay'
import { startingLines } from '@/features/projects/customGroupLines'
import {
  AUTO_MATCH_THRESHOLD,
  matchDoorGroup,
  type GroupMatchResult,
} from '@/features/projects/doorMatcher'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { buildGroupQuoteInfo, readGroupQuoteInfo } from '@/features/projects/groupQuoteInfo'
import { CustomGroupInput } from '@/features/projects/CustomGroupInput'
import { Stepper, type StepperStep } from '@/components/ui/stepper'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'

interface QuotationImportWizardProps {
  projectId: string
  projectName: string
  onCancel: () => void
  onDone: (versionId: string) => void
  /**
   * 'import': a new builder quote (builderName + the first sheet's supplier).
   * 'reimport': load an updated quotation into an existing quote. Door groups
   * that didn't change keep their set, and every supplier sheet keeps its
   * lines; new groups are matched; removed groups are dropped.
   */
  mode?: 'import' | 'reimport'
  /** Import only: the builder of the new quote. */
  builderName?: string
  /** Import only: supplier of the quote's first sheet. */
  supplier?: { id: string; name: string } | null
  /** Re-import only: the quote being re-imported. */
  quoteId?: string | null
  /** Re-import only: the version the new file is compared with (the draft, or the latest version). */
  baseVersion?: ProjectVersion | null
  /** Re-import only: version number created when baseVersion is not a draft. */
  nextVersionNo?: number
}

const CUSTOM_SET_VALUE = '__CUSTOM__'
/** Dropdown value for a custom door group already used in the project: prefix + its name. */
const SAVED_CUSTOM_PREFIX = '__CUSTOM__:'

/** Only confident auto matches can be bulk-confirmed; the rest need a look each (B10). */
function isHighConfidenceAuto(m: { matchStatus: string; matchedSetId: string | null; matchScore: number | null }) {
  return (
    m.matchStatus === 'auto' &&
    m.matchedSetId !== null &&
    m.matchScore !== null &&
    m.matchScore >= AUTO_MATCH_THRESHOLD
  )
}

interface DraftGroupMatch {
  group: ParsedDoorGroupPreview
  matchedSetId: string | null
  matchStatus: 'auto' | 'confirmed' | 'manual' | 'unmatched'
  matchScore: number | null
  matchReason: string
  customGroupName: string
  /** Re-import: id of the unchanged group in baseVersion whose lines are kept. */
  carriedFromGroupId: string | null
  /** Merged on this step: the groups it was made from (to unmerge, and saved as merged_from). */
  mergedFrom?: DraftGroupMatch[]
}

interface SetLineDraft {
  sku: string
  description: string
  qty_per_door: number
  unit_price: number | null
  part_id: string | null
  /** 'added': an item the schedule asks for that the set doesn't have. */
  origin: 'set' | 'added'
  /** Why the estimator should check the line (a set part the quotation doesn't price). */
  review_flag?: string
  /** MHQT REMARKS ("BY OTHERS" on electrical items). */
  mhqt_remarks?: string
}

const WIZARD_STEPS: StepperStep[] = [
  { id: 'upload', title: 'Upload Quotation', description: 'Parse .xlsx schedule' },
  { id: 'matching', title: 'Matching Review', description: 'Door-to-set mapping' },
  { id: 'summary', title: 'Summary', description: 'Review & create' },
]

/**
 * Quotation import for an existing project (assigned estimator or admin):
 * upload .xlsx -> review door-to-set matching -> create version 1.
 * Project details are created separately by a PM/admin (CreateProjectForm).
 */
export function QuotationImportWizard({
  projectId,
  projectName,
  onCancel,
  onDone,
  mode = 'import',
  builderName = '',
  supplier = null,
  quoteId = null,
  baseVersion = null,
  nextVersionNo = 2,
}: QuotationImportWizardProps) {
  const isReimport = mode === 'reimport'
  const replacesDraft = isReimport && baseVersion?.status === 'draft'
  const { user } = useAuth()
  const queryClient = useQueryClient()
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  const [step, setStep] = useState(0)
  const [stepError, setStepError] = useState<string | null>(null)

  // Step 1: Upload & parse
  const [isDragging, setIsDragging] = useState(false)
  const [parsing, setParsing] = useState(false)
  // While parsing: the file and where it's up to (ParsingProgress).
  const [parsingFile, setParsingFile] = useState<{ name: string; size: number } | null>(null)
  const [parseProgress, setParseProgress] = useState<ImportProgress>({ stage: 'open' })
  const [previewTab, setPreviewTab] = useState<'groups' | 'doors' | 'variation' | 'excluded' | 'issues'>('groups')
  const [uploadedFile, setUploadedFile] = useState<File | null>(null)
  // baseParse: the file as parsed; parseResult: with any excluded rows the estimator included.
  const [baseParse, setBaseParse] = useState<QuotationParseResult | null>(null)
  const [parseResult, setParseResult] = useState<QuotationParseResult | null>(null)

  // Step 2: Matching state
  const [draftMatches, setDraftMatches] = useState<DraftGroupMatch[]>([])

  // Custom door groups already used in this project (any quote / version):
  // they're saved on the door groups as "Custom: <name>", so they can be
  // picked again instead of typed.
  const projectCustomGroupsQuery = useQuery({
    queryKey: ['door_groups', 'custom-names', projectId],
    queryFn: async (): Promise<string[]> => {
      const { data, error } = await supabase
        .from('door_groups')
        .select('match_reason, project_versions!inner(project_id)')
        .eq('project_versions.project_id', projectId)
        .is('matched_set_id', null)
        .like('match_reason', 'Custom:%')
        .limit(1000)
      if (error) throw error
      return ((data ?? []) as { match_reason: string | null }[])
        .map((g) => customNameFromReason(g.match_reason))
        .filter(Boolean)
    },
  })

  const standardSetsQuery = useQuery({
    queryKey: ['standard_sets', 'for-matching'],
    queryFn: async (): Promise<StandardSet[]> => {
      const { data, error } = await supabase
        .from('standard_sets')
        .select(
          'id, room_name, classification, leaf, door_size, active, created_at, updated_at, standard_set_lines(id, set_id, position, sku, description, qty, unit_price, generic_id, created_at, updated_at)',
        )
        .eq('active', true)
        .order('room_name', { ascending: true })
      if (error) throw error
      return (data ?? []) as StandardSet[]
    },
  })

  const partsQuery = useQuery({
    queryKey: ['parts', 'sizing-lookup'],
    queryFn: async (): Promise<SizingPart[]> => {
      const [parts, folders] = await Promise.all([
        fetchAllRows<SizingPart & { folder_id: string | null }>((from, to) =>
          supabase
            .from('parts')
            .select('id, sku, legend, description, supplier_id, unit_cost, active, folder_id')
            .order('id', { ascending: true })
            .range(from, to),
        ),
        supabase.from('part_folders').select('id, name'),
      ])
      // The folder name, so items filed under "by others" are treated as such.
      const folderName = new Map(
        (Array.isArray(folders.data) ? (folders.data as Array<{ id: string; name: string }>) : []).map((f) => [f.id, f.name]),
      )
      // legend and description are never null in the database; '' guards the rules anyway.
      return parts.map((p) => ({
        ...p,
        legend: p.legend ?? '',
        description: p.description ?? '',
        folder: p.folder_id ? folderName.get(p.folder_id) : undefined,
      }))
    },
  })

  // Re-import: the current version's groups and lines, to keep unchanged groups.
  const baseQuery = useQuery({
    queryKey: ['reimport-base', baseVersion?.id],
    enabled: isReimport && !!baseVersion,
    queryFn: async (): Promise<{ groups: DoorGroup[]; lines: ProjectLine[] }> => {
      const [groups, lines] = await Promise.all([
        fetchVersionGroups(baseVersion!.id),
        fetchVersionLines(baseVersion!.id),
      ])
      return { groups, lines }
    },
  })

  // Re-import: the doors of the upload being replaced, to show doors added / removed.
  const previousUploadId = isReimport ? (baseVersion?.upload_id ?? null) : null
  const previousDoorsQuery = useQuery({
    queryKey: ['quotation-doors', previousUploadId],
    enabled: !!previousUploadId,
    queryFn: () =>
      fetchAllRows<DoorRecord>((from, to) =>
        supabase
          .from('quotation_doors')
          .select('door_ref, room_name, classification, leaf, door_size, qty, source_row, id')
          .eq('upload_id', previousUploadId!)
          .order('source_row')
          .order('id')
          .range(from, to),
      ),
  })

  const baseGroups = useMemo(() => baseQuery.data?.groups ?? [], [baseQuery.data])
  // Earlier groups by key (older keys without hardware are found too; see groupKey.ts).
  const findBaseGroup = useMemo(() => makeGroupFinder(baseGroups), [baseGroups])
  const baseById = useMemo(() => new Map(baseGroups.map((g) => [g.id, g])), [baseGroups])
  const baseLinesByGroup = useMemo(() => {
    const map = new Map<string, ProjectLine[]>()
    for (const l of baseQuery.data?.lines ?? []) {
      const arr = map.get(l.group_id)
      if (arr) arr.push(l)
      else map.set(l.group_id, [l])
    }
    return map
  }, [baseQuery.data])

  const standardSets = useMemo(
    () => standardSetsQuery.data ?? [],
    [standardSetsQuery.data],
  )

  const setById = useMemo(() => {
    const map = new Map<string, StandardSet>()
    for (const s of standardSets) map.set(s.id, s)
    return map
  }, [standardSets])

  // Generic set items and each supplier's preferred part (migration 027).
  const genericQuery = useQuery({
    queryKey: ['generic_items', 'with-preferences'],
    queryFn: async () => {
      const [items, prefs] = await Promise.all([
        supabase.from('generic_items').select('id, code, description, folder_id, active'),
        supabase.from('generic_item_parts').select('generic_id, supplier_id, part_id'),
      ])
      if (items.error) throw items.error
      if (prefs.error) throw prefs.error
      return {
        items: (Array.isArray(items.data) ? items.data : []) as GenericItem[],
        prefs: (Array.isArray(prefs.data) ? prefs.data : []) as GenericPreference[],
      }
    },
  })
  // The supplier generic items are quoted from: the first sheet's (a new
  // quote's chosen supplier, or a re-imported quote's first sheet).
  const firstSheetQuery = useQuery({
    queryKey: ['quote_sheets', baseVersion?.id, 'first'],
    enabled: isReimport && !!baseVersion?.id,
    queryFn: async () => (await fetchVersionSheets(baseVersion!.id))[0] ?? null,
  })
  // Re-import: the replaced upload's notes per group. Unchanged groups keep
  // their lines, so they keep the notes those lines came with.
  const baseUploadId = isReimport ? (baseVersion?.upload_id ?? null) : null
  const baseNotesQuery = useQuery({
    queryKey: ['quotation_group_info', baseUploadId, 'notes'],
    enabled: !!baseUploadId,
    queryFn: async (): Promise<Map<string, string[]>> => {
      const rows = await fetchAllRows<{ group_key: string; info: unknown }>((from, to) =>
        supabase.from('quotation_group_info').select('group_key, info').eq('upload_id', baseUploadId!).range(from, to),
      )
      return new Map(rows.map((r) => [r.group_key, readGroupQuoteInfo(r.info)?.notes ?? []]))
    },
  })
  const genericSupplierId = supplier?.id ?? firstSheetQuery.data?.supplier_id ?? null
  const genericById = useMemo(
    () => new Map((genericQuery.data?.items ?? []).map((g) => [g.id, g])),
    [genericQuery.data],
  )

  const partBySku = useMemo(() => {
    const map = new Map<string, string>()
    for (const p of partsQuery.data ?? []) {
      map.set(p.sku.trim().toUpperCase(), p.id)
    }
    return map
  }, [partsQuery.data])

  // Each new group's lines: the matched set's lines, plus items the schedule
  // asks for (ES, CR, RS, kick plate, Vingcard, viewer; see doorFlags.ts), then
  // sized for the group's door (hinges, seal lengths, drop seal / kick plate
  // widths; see doorSizing.ts).
  // Built once per load / parse, not per group or per keystroke.
  const partIndex = useMemo(() => makePartIndex(partsQuery.data ?? []), [partsQuery.data])
  // HW column headers as in the quotation ("Self Closing"), for the hardware lists.
  const hwHeaders = useMemo(() => parseResult?.hardwareHeaders ?? [], [parseResult])
  const doorByRow = useMemo(
    () => new Map((parseResult?.doors ?? []).map((d) => [d.source_row, d])),
    [parseResult],
  )
  // A group's sized lines only depend on its set (and the parse / library), so
  // they're kept per group + set: typing a custom name or confirming a match
  // doesn't redo them. A new parse or parts load starts a fresh cache.
  const sizingCache = useMemo(
    () => new Map<string, SizedLines<SetLineDraft> & { flagNotes: string[] }>(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [partIndex, doorByRow, setById, partBySku, genericQuery.data, genericSupplierId],
  )

  const sizedLinesByGroup = useMemo(() => {
    const map = new Map<string, SizedLines<SetLineDraft> & { flagNotes: string[] }>()
    for (const m of draftMatches) {
      // Unchanged groups keep their lines; every other group gets lines, from
      // its set or (unmatched / custom) from the door and the quotation's cells.
      if (m.carriedFromGroupId) continue
      const cacheKey = `${m.group.group_key}|${m.matchedSetId}|${m.group.source_rows.join(',')}|${m.group.hardware}`
      const cached = sizingCache.get(cacheKey)
      if (cached) {
        map.set(m.group.group_key, cached)
        continue
      }
      const set = m.matchedSetId ? setById.get(m.matchedSetId) : undefined
      const genericNotes: string[] = []
      const setLines: SetLineDraft[] = [...(set?.standard_set_lines ?? [])]
        .sort((a: StandardSetLine, b: StandardSetLine) => a.position - b.position)
        .map((line) => {
          const base = {
            sku: line.sku,
            description: line.description,
            qty_per_door: Number(line.qty),
            unit_price: line.unit_price,
            part_id: partBySku.get(line.sku.trim().toUpperCase()) ?? null,
            origin: 'set' as const,
          }
          // A generic item ("PASSAGE SET LEVER ROUND") becomes the supplier's part.
          const generic = line.generic_id ? genericById.get(line.generic_id) : undefined
          if (!generic) return base
          const picked = resolveGenericItem(generic, genericSupplierId, genericQuery.data?.prefs ?? [], {
            byId: partIndex.byId,
            all: partIndex.all,
          }, new Set(), genericQuery.data?.items ?? [])
          if (!picked) {
            genericNotes.push(`${generic.description}: no part to quote it with — pick one`)
            return {
              ...base,
              part_id: null,
              unit_price: null,
              review_flag: `Generic item (${generic.description}): no part found for this supplier — pick one`,
            }
          }
          if (picked.how !== 'preferred') {
            genericNotes.push(
              `${generic.description} → ${picked.part.sku} (${picked.how === 'folder' ? "the supplier's closest part" : 'the default part'})`,
            )
          }
          return {
            ...base,
            sku: picked.part.sku,
            description: picked.part.description,
            part_id: picked.part.id,
            unit_price: picked.part.unit_cost ?? line.unit_price,
          }
        })
      const doors = m.group.source_rows
        .map((r) => doorByRow.get(r))
        .filter((d): d is NonNullable<typeof d> => !!d)
      const leaves = parseDoorSize(m.group.door_size)?.widths.length ?? 1
      if (!set) {
        // No standard set: start from the door (hinges); the rules below add
        // the rest from the size, rating, Builder HW and prep / install cells.
        for (const start of startingLines(m.group, leaves, partIndex)) {
          setLines.push({
            sku: start.part.sku,
            description: start.part.description,
            qty_per_door: start.qty,
            unit_price: start.part.unit_cost,
            part_id: start.part.id,
            origin: 'added',
          })
        }
        genericNotes.push('No standard set: hardware built from the quotation (size, rating, Builder HW, prep / install)')
      }
      const addedLine = (part: SizingPart, qty: number): SetLineDraft => ({
        sku: part.sku,
        description: part.description,
        qty_per_door: qty,
        unit_price: part.unit_cost,
        part_id: part.id,
        origin: 'added',
      })
      // Prep / install costs first: add priced parts the set lacks, raise
      // quantities, flag set parts that aren't priced (doorActivities.ts).
      const priced = applyActivityRules(
        setLines,
        {
          activities: m.group.activities ?? {},
          leaf: m.group.leaf,
          comments: doors.map((d) => d.comments).join(' | '),
          leaves,
        },
        parseResult?.activityColumns ?? [],
        partIndex,
        addedLine,
      )
      // LOCK PREP / LOCK INST: change the set's lock parts to what's priced.
      const locked = applyLockRules(
        priced.lines,
        {
          lockCost: m.group.lock_cost ?? '',
          hardware: m.group.hardware,
          room: m.group.match_room || m.group.room_name,
        },
        partIndex,
        addedLine,
      )
      // Hinge column: LO lift off, BH ball bearing.
      const hinged = applyHingeType(locked.lines, m.group.hardware, partIndex, addedLine)
      const flagged = applyFlagRules(hinged.lines, doors, leaves, partIndex, addedLine, {
        costColumns: parseResult?.activityColumns ?? [],
        activities: m.group.activities ?? {},
      })
      const sizedRaw = sizeSetLines(flagged.lines, m.group, partIndex)
      // Electrical items: on the door, no price, BY OTHERS.
      const others = markByOthers(sizedRaw.lines, partIndex)
      const sized = { ...sizedRaw, lines: others.lines }
      const entry = {
        ...sized,
        flagNotes: [...genericNotes, ...priced.notes, ...locked.notes, ...hinged.notes, ...flagged.notes, ...others.notes],
      }
      sizingCache.set(cacheKey, entry)
      map.set(m.group.group_key, entry)
    }
    return map
  }, [draftMatches, setById, partBySku, partIndex, doorByRow, sizingCache, parseResult, genericById, genericQuery.data, genericSupplierId])

  // Each group's candidate sets depend only on the parse and the sets, not on
  // the estimator's choices, so they're worked out once per parse.
  const candidateMap = useMemo(() => {
    const map = new Map<string, GroupMatchResult>()
    if (standardSets.length === 0) return map
    for (const g of parseResult?.groups ?? []) {
      map.set(
        g.group_key,
        matchDoorGroup(
          {
            id: g.group_key,
            // A merged group is matched on its room with the most doors.
            room_name: g.match_room || g.room_name,
            classification: g.classification ?? '',
            leaf: g.leaf ?? '',
            door_size: g.door_size ?? '',
          },
          standardSets,
        ),
      )
    }
    return map
  }, [parseResult, standardSets])

  const initializeMatchesFromParse = useCallback(
    (result: QuotationParseResult, keep?: Map<string, DraftGroupMatch>) => {
      const next: DraftGroupMatch[] = result.groups.map((g) => {
        // A group that was already here keeps the estimator's choice (its
        // doors may have changed when a row was included).
        const kept = keep?.get(g.group_key)
        if (kept) return { ...kept, group: g }
        // Re-import: an unchanged door group keeps what it had.
        const base = isReimport ? findBaseGroup(g.group_key) : undefined
        if (base) {
          const status: DraftGroupMatch['matchStatus'] =
            base.match_status === 'auto' || base.match_status === 'unmatched'
              ? base.matched_set_id
                ? 'confirmed'
                : 'manual'
              : base.match_status
          return {
            group: g,
            matchedSetId: base.matched_set_id,
            matchStatus: status,
            matchScore: base.match_score,
            matchReason: base.match_reason,
            customGroupName: base.matched_set_id
              ? ''
              : customNameFromReason(base.match_reason) || base.door_tag || base.room_name,
            carriedFromGroupId: base.id,
          }
        }
        if (standardSets.length === 0) {
          return {
            group: g,
            matchedSetId: null,
            matchStatus: 'unmatched',
            matchScore: null,
            matchReason: '',
            customGroupName: '',
            carriedFromGroupId: null,
          }
        }
        const m = matchDoorGroup(
          {
            id: g.group_key,
            room_name: g.match_room || g.room_name,
            classification: g.classification ?? '',
            leaf: g.leaf ?? '',
            door_size: g.door_size ?? '',
          },
          standardSets,
        )
        return {
          group: g,
          matchedSetId: m.matchedSetId,
          matchStatus: m.matchStatus,
          matchScore: m.matchScore,
          matchReason: m.matchReason,
          customGroupName: '',
          carriedFromGroupId: null,
        }
      })
      setDraftMatches(next)
    },
    [standardSets, isReimport, findBaseGroup],
  )

  useEffect(() => {
    if (
      parseResult &&
      standardSets.length > 0 &&
      draftMatches.length > 0 &&
      draftMatches.every((m) => m.matchStatus === 'unmatched' && !m.matchReason)
    ) {
      initializeMatchesFromParse(parseResult)
    }
  }, [parseResult, standardSets.length, draftMatches, initializeMatchesFromParse])

  const handleFile = async (file: File | undefined) => {
    if (!file) return
    setStepError(null)
    if (isReimport && !baseQuery.data) {
      setStepError('Still loading the current version — try again in a moment.')
      return
    }
    if (!file.name.toLowerCase().endsWith('.xlsx')) {
      setStepError('Only .xlsx quotation workbooks are supported.')
      return
    }
    setParsingFile({ name: file.name, size: file.size })
    setParseProgress({ stage: 'open' })
    setParsing(true)
    try {
      const buffer = await file.arrayBuffer()
      const result = await parseQuotationInBackground(buffer, setParseProgress)
      // Matching runs on the page: show the step before it starts.
      setParseProgress({ stage: 'match' })
      await new Promise<void>((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)))
      setUploadedFile(file)
      setBaseParse(result)
      setParseResult(result)
      setPreviewTab('groups')
      initializeMatchesFromParse(result)
    } catch (err) {
      setStepError(
        err instanceof Error ? err.message : 'Failed to parse quotation workbook.',
      )
      setUploadedFile(null)
      setBaseParse(null)
      setParseResult(null)
      setDraftMatches([])
    } finally {
      setParsing(false)
    }
  }

  // Back to the drop area for another file. Matching choices made on the next
  // step would be lost, so ask first when there are any.
  const uploadAgain = () => {
    const choices = draftMatches.some(
      (m) => !m.carriedFromGroupId && (m.matchStatus === 'confirmed' || m.matchStatus === 'manual'),
    )
    if (choices && !window.confirm('Upload another file? The matches you confirmed or changed will be lost.')) return
    setStepError(null)
    setUploadedFile(null)
    setBaseParse(null)
    setParseResult(null)
    setDraftMatches([])
  }

  // Include (or exclude again) an excluded row; groups are worked out again and re-matched.
  const toggleIncludedRow = (row: number) => {
    if (!baseParse || !parseResult) return
    const rows = new Set(parseResult.includedRows)
    if (rows.has(row)) rows.delete(row)
    else rows.add(row)
    const next = applyRowInclusions(baseParse, rows)
    setParseResult(next)
    // Groups that are still there keep their matches; new ones are matched.
    initializeMatchesFromParse(next, new Map(draftMatches.map((m) => [m.group.group_key, m])))
  }

  const runAutoMatch = () => {
    setStepError(null)
    setDraftMatches((prev) =>
      prev.map((item) => {
        if (item.matchStatus === 'manual' || item.matchStatus === 'confirmed') {
          return item
        }
        const m = matchDoorGroup(
          {
            id: item.group.group_key,
            // A merged group is matched on its room with the most doors.
            room_name: item.group.match_room || item.group.room_name,
            classification: item.group.classification ?? '',
            leaf: item.group.leaf ?? '',
            door_size: item.group.door_size ?? '',
          },
          standardSets,
        )
        return {
          ...item,
          matchedSetId: m.matchedSetId,
          matchStatus: m.matchStatus,
          matchScore: m.matchScore,
          matchReason: m.matchReason,
        }
      }),
    )
  }

  const confirmAllAuto = () => {
    setStepError(null)
    setDraftMatches((prev) =>
      prev.map((item) =>
        isHighConfidenceAuto(item) ? { ...item, matchStatus: 'confirmed' } : item,
      ),
    )
  }

  // Every AUTO match that has a set, low-confidence ones included (asks first).
  const confirmEveryAuto = () => {
    if (
      lowConfidenceAutoCount > 0 &&
      !window.confirm(
        `Confirm all ${allAutoWithSetCount} auto matches, including ${lowConfidenceAutoCount} below ${Math.round(AUTO_MATCH_THRESHOLD * 100)}%? Check those matches first if you're not sure.`,
      )
    ) {
      return
    }
    setStepError(null)
    setDraftMatches((prev) =>
      prev.map((item) =>
        item.matchStatus === 'auto' && item.matchedSetId ? { ...item, matchStatus: 'confirmed' } : item,
      ),
    )
  }

  const confirmOne = (groupKey: string) => {
    setStepError(null)
    setDraftMatches((prev) =>
      prev.map((item) =>
        item.group.group_key === groupKey && item.matchStatus === 'auto' && item.matchedSetId
          ? { ...item, matchStatus: 'confirmed' }
          : item,
      ),
    )
  }

  const updateManualMatch = (groupKey: string, setId: string) => {
    setStepError(null)
    keepVisible(groupKey)
    setDraftMatches((prev) =>
      prev.map((item) => {
        if (item.group.group_key !== groupKey) return item
        if (!setId) {
          return {
            ...item,
          carriedFromGroupId: null,
            matchedSetId: null,
            matchStatus: 'unmatched',
            matchScore: null,
            matchReason: 'Cleared manually',
            customGroupName: '',
          }
        }
        if (setId.startsWith(SAVED_CUSTOM_PREFIX)) {
          const name = setId.slice(SAVED_CUSTOM_PREFIX.length)
          return {
            ...item,
            carriedFromGroupId: null,
            matchedSetId: null,
            matchStatus: 'manual',
            matchScore: null,
            matchReason: `Custom: ${name}`,
            customGroupName: name,
          }
        }
        if (setId === CUSTOM_SET_VALUE) {
          // A new custom group: start from a blank name when switching away
          // from a saved one, else keep what was typed.
          const keep = item.matchStatus === 'manual' && !item.matchedSetId ? '' : item.customGroupName
          const trimmed = keep.trim()
          return {
            ...item,
            carriedFromGroupId: null,
            matchedSetId: null,
            matchStatus: 'manual',
            matchScore: null,
            matchReason: trimmed ? `Custom: ${trimmed}` : 'Custom door group',
            customGroupName: keep,
          }
        }
        const set = setById.get(setId)
        const cand = candidateMap
          .get(groupKey)
          ?.topCandidates.find((c) => c.set.id === setId)
        return {
          ...item,
          carriedFromGroupId: null,
          matchedSetId: setId,
          matchStatus: 'manual',
          matchScore: cand ? cand.score : null,
          matchReason: cand
            ? `Manual: ${cand.reason}`
            : `Manually assigned to ${set?.room_name ?? 'Standard Set'}`,
          customGroupName: '',
        }
      }),
    )
  }

  const updateCustomGroupName = (groupKey: string, name: string) => {
    setStepError(null)
    keepVisible(groupKey)
    setDraftMatches((prev) =>
      prev.map((item) => {
        if (item.group.group_key !== groupKey) return item
        const trimmed = name.trim()
        return {
          ...item,
          customGroupName: name,
          matchReason: trimmed ? `Custom: ${trimmed}` : 'Custom door group',
        }
      }),
    )
  }

  const savedCustomNames = useMemo(() => {
    const byKey = new Map<string, string>()
    const add = (name: string) => {
      const t = name.trim()
      if (t && !byKey.has(t.toUpperCase())) byKey.set(t.toUpperCase(), t)
    }
    for (const n of projectCustomGroupsQuery.data ?? []) add(n)
    for (const m of draftMatches) if (m.matchStatus === 'manual' && !m.matchedSetId) add(m.customGroupName)
    return [...byKey.values()].sort((a, b) => a.localeCompare(b))
  }, [projectCustomGroupsQuery.data, draftMatches])
  const savedCustomValue = (name: string): string | null => {
    const t = name.trim().toUpperCase()
    const hit = t ? savedCustomNames.find((n) => n.toUpperCase() === t) : undefined
    return hit ? SAVED_CUSTOM_PREFIX + hit : null
  }

  // Filter the Matching Review list: by door group (room, tag, specs,
  // hardware, set) and by status. Bulk buttons still act on every group.
  const [groupFilter, setGroupFilter] = useState('')
  const [statusFilter, setStatusFilter] = useState<'ALL' | DraftGroupMatch['matchStatus']>('ALL')
  // A group being edited stays in the list until the filter changes, even
  // when the edit means it no longer matches (Unmatched -> Custom).
  const [keptVisible, setKeptVisible] = useState<Set<string>>(new Set())
  const keepVisible = (groupKey: string) =>
    setKeptVisible((prev) => (prev.has(groupKey) ? prev : new Set(prev).add(groupKey)))
  useEffect(() => setKeptVisible(new Set()), [groupFilter, statusFilter])
  const visibleMatches = useMemo(() => {
    const q = groupFilter.trim().toLowerCase()
    return draftMatches.filter((m) => {
      if (keptVisible.has(m.group.group_key)) return true
      if (statusFilter !== 'ALL' && m.matchStatus !== statusFilter) return false
      if (!q) return true
      const g = m.group
      const setName = m.matchedSetId ? setById.get(m.matchedSetId)?.room_name ?? '' : m.customGroupName
      return [g.room_name, g.door_tag, g.classification, g.leaf, g.door_size, g.hardware, setName]
        .some((v) => (v ?? '').toLowerCase().includes(q))
    })
  }, [draftMatches, groupFilter, statusFilter, setById, keptVisible])

  // Merge / unmerge door groups before saving.
  const [selectedForMerge, setSelectedForMerge] = useState<Set<string>>(new Set())
  const [draftMergePlan, setDraftMergePlan] = useState<DraftMergePlan | null>(null)
  const selectedMergeItems = draftMatches.filter((m) => selectedForMerge.has(m.group.group_key))
  const toggleMergeSelect = (groupKey: string) =>
    setSelectedForMerge((prev) => {
      const next = new Set(prev)
      if (next.has(groupKey)) next.delete(groupKey)
      else next.add(groupKey)
      return next
    })
  const confirmDraftMerge = (roomName: string, include: Set<string>) => {
    if (!draftMergePlan) return
    const items = [...selectedMergeItems].sort((a, b) => a.group.position - b.group.position)
    const [first] = items
    const merged: DraftGroupMatch = {
      ...first,
      group: buildMergedGroup(draftMergePlan, roomName, include),
      // A merged group merged again remembers the original groups.
      mergedFrom: items.flatMap((i) => i.mergedFrom ?? [i]),
    }
    const drop = new Set(items.slice(1).map((i) => i.group.group_key))
    setDraftMatches((prev) =>
      prev
        .filter((m) => !drop.has(m.group.group_key))
        .map((m) => (m.group.group_key === first.group.group_key ? merged : m)),
    )
    setSelectedForMerge(new Set())
    setDraftMergePlan(null)
  }
  const unmergeDraft = (groupKey: string) => {
    setDraftMatches((prev) =>
      prev.flatMap((m) => {
        if (m.group.group_key !== groupKey || !m.mergedFrom) return [m]
        const groups = unmergeGroup(m.group, m.mergedFrom.map((p) => p.group))
        // Each gets the merged group's current set / custom name and hardware.
        return m.mergedFrom.map((p, i) => ({
          ...p,
          group: groups[i],
          matchedSetId: m.matchedSetId,
          matchStatus: m.matchStatus,
          matchScore: m.matchScore,
          matchReason: m.matchReason,
          customGroupName: m.customGroupName,
          carriedFromGroupId: null,
          mergedFrom: undefined,
        }))
      }),
    )
  }

  const matchedCount = draftMatches.filter((m) => Boolean(m.matchedSetId)).length
  const customCount = draftMatches.filter(
    (m) => m.matchStatus === 'manual' && !m.matchedSetId,
  ).length
  const blankCustomCount = draftMatches.filter(
    (m) => m.matchStatus === 'manual' && !m.matchedSetId && !m.customGroupName.trim(),
  ).length
  const confirmedOrManualCount = draftMatches.filter(
    (m) => m.matchStatus === 'confirmed' || m.matchStatus === 'manual',
  ).length
  const autoCount = draftMatches.filter((m) => m.matchStatus === 'auto').length
  const highConfidenceAutoCount = draftMatches.filter(isHighConfidenceAuto).length
  const lowConfidenceAutoCount = autoCount - highConfidenceAutoCount
  const allAutoWithSetCount = draftMatches.filter(
    (m) => m.matchStatus === 'auto' && m.matchedSetId !== null,
  ).length
  const unmatchedCount = draftMatches.filter((m) => m.matchStatus === 'unmatched').length

  // The lines are built from these: saving before they load would save a
  // set's generic items as they are, without parts.
  const lookupsLoading =
    partsQuery.isPending ||
    genericQuery.isPending ||
    standardSetsQuery.isPending ||
    (isReimport && firstSheetQuery.isPending) ||
    (!!baseUploadId && baseNotesQuery.isPending)
  // One failed to load: saving would quote generic items as the old
  // placeholder parts (their codes are part numbers too), unflagged.
  const lookupsFailed =
    partsQuery.isError || genericQuery.isError || standardSetsQuery.isError || (isReimport && firstSheetQuery.isError)
  const retryLookups = () => {
    for (const q of [partsQuery, genericQuery, standardSetsQuery, firstSheetQuery]) if (q.isError) void q.refetch()
  }

  const importMutation = useMutation({
    mutationFn: async (): Promise<string> => {
      if (!user) throw new Error('Must be signed in to import a quotation.')
      if (lookupsLoading) throw new Error('Still loading the parts library — try again in a moment.')
      if (lookupsFailed) throw new Error("The parts library or generic items didn't load — retry before saving.")
      if (!uploadedFile || !parseResult) {
        throw new Error('Quotation workbook is required.')
      }
      if (unmatchedCount > 0 || blankCustomCount > 0) {
        throw new Error('All door groups must be matched or have a custom door group name.')
      }
      if (isReimport ? !quoteId : !builderName.trim() || !supplier) {
        throw new Error(isReimport ? 'No quote selected.' : 'Choose the builder and supplier first.')
      }

      // 1. Upload the .xlsx to Storage (path must start with the project id).
      const safeName = uploadedFile.name.replace(/[^a-zA-Z0-9._-]+/g, '_')
      const storagePath = `${projectId}/${Date.now()}-${safeName}`
      const { error: storageErr } = await supabase.storage
        .from('quotations')
        .upload(storagePath, uploadedFile, {
          contentType:
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          upsert: false,
        })
      if (storageErr) throw storageErr

      // 2. Everything else in one database call (import_quotation, migration 011):
      //    upload record, doors, version 1, door groups and their hardware lines
      //    are saved together or not at all.
      const doors = parseResult.doors.map((d) => ({
        door_ref: d.door_ref,
        room_name: d.room_name,
        classification: d.classification ?? '',
        leaf: d.leaf ?? '',
        door_size: d.door_size ?? '',
        qty: d.qty,
        source_row: d.source_row,
      }))

      // What the quotation said about each group (doors, hardware, comments,
      // the rules' notes), for the Hardware grid's door group popover.
      const quoteInfo = (m: DraftGroupMatch) =>
        buildGroupQuoteInfo(
          m.group,
          m.group.source_rows.map((r) => doorByRow.get(r)).filter((d): d is NonNullable<typeof d> => !!d),
          hwHeaders,
          m.carriedFromGroupId
            ? (baseNotesQuery.data?.get(baseById.get(m.carriedFromGroupId)?.group_key ?? '') ?? [])
            : (sizedLinesByGroup.get(m.group.group_key)?.flagNotes ?? []),
        )
      const groups = draftMatches.map((m) => {
        if (m.carriedFromGroupId) {
          // Unchanged group: every sheet keeps its lines (edits and prices), the
          // PM remarks stay; new door qty. The database copies the lines.
          const base = baseById.get(m.carriedFromGroupId)
          return {
            position: m.group.position,
            group_key: m.group.group_key,
            door_tag: m.group.door_tag,
            room_name: m.group.room_name,
            classification: m.group.classification ?? '',
            leaf: m.group.leaf ?? '',
            door_size: m.group.door_size ?? '',
            door_qty: m.group.door_qty,
            matched_set_id: m.matchedSetId,
            match_status: m.matchStatus,
            match_score: m.matchScore,
            match_reason: m.matchReason,
            pm_remarks: base?.pm_remarks ?? '',
            carried_from_group_id: m.carriedFromGroupId,
            quote_info: quoteInfo(m),
            lines: [],
          }
        }
        const setLines = sizedLinesByGroup.get(m.group.group_key)?.lines ?? []
        return {
          position: m.group.position,
          group_key: m.group.group_key,
          door_tag: m.group.door_tag,
          room_name: m.group.room_name,
          classification: m.group.classification ?? '',
          leaf: m.group.leaf ?? '',
          door_size: m.group.door_size ?? '',
          door_qty: m.group.door_qty,
          matched_set_id: m.matchedSetId,
          match_status: m.matchStatus,
          match_score: m.matchScore,
          match_reason: m.matchReason,
          quote_info: quoteInfo(m),
          // The standard set's lines plus flagged items, sized for the door; a
          // blank set price stays null (never 0).
          lines: setLines.map((line, idx) => ({
            position: idx + 1,
            sku: line.sku,
            description: line.description,
            qty_per_door: line.qty_per_door,
            unit_price: line.unit_price,
            origin: line.origin,
            part_id: line.part_id,
            review_flag: line.review_flag ?? '',
            mhqt_remarks: line.mhqt_remarks ?? '',
          })),
        }
      })

      const common = {
        p_storage_path: storagePath,
        p_original_filename: uploadedFile.name,
        // The doors compared with the replaced upload, for the project page.
        p_parse_report: doorChanges
          ? {
              ...parseResult.report,
              previous_upload_id: previousUploadId,
              door_changes: { ...changeCounts(doorChanges), previousTotal: doorChanges.previousTotal, currentTotal: doorChanges.currentTotal },
            }
          : parseResult.report,
        p_doors: doors,
        p_groups: groups,
      }
      const { data: versionId, error: importErr } = isReimport
        ? await supabase.rpc('reimport_quotation', { p_quote_id: quoteId, ...common })
        : await supabase.rpc('import_quotation', {
            p_project_id: projectId,
            p_builder_name: builderName.trim(),
            p_supplier_id: supplier!.id,
            ...common,
          })
      if (importErr) throw importErr

      for (const m of draftMatches.filter((x) => x.mergedFrom && x.mergedFrom.length > 1)) {
        const { error: mergeErr } = await supabase
          .from('door_groups')
          .update({
            merged_from: m.mergedFrom!.map((p) => ({
              group_key: p.group.group_key,
              room_name: p.group.room_name,
              door_qty: p.group.door_qty,
              door_tag: p.group.door_tag,
            })),
          })
          .eq('version_id', versionId as string)
          .eq('group_key', m.group.group_key)
        if (mergeErr) throw mergeErr
      }

      return versionId as string
    },
    onSuccess: async (versionId) => {
      await queryClient.invalidateQueries({ queryKey: ['project', projectId] })
      await queryClient.invalidateQueries({ queryKey: ['projects'] })
      // A re-imported draft keeps its id, so its cached groups/lines must refresh.
      await queryClient.invalidateQueries({ queryKey: ['door_groups'] })
      await queryClient.invalidateQueries({ queryKey: ['project_lines'] })
      await queryClient.invalidateQueries({ queryKey: ['quote_sheets'] })
      onDone(versionId)
    },
    onError: (err: Error) => {
      setStepError(err.message)
    },
  })

  const handleNext = () => {
    setStepError(null)
    if (step === 0) {
      if (!uploadedFile || !parseResult || parseResult.doors.length === 0) {
        setStepError('Please upload and parse a valid quotation .xlsx workbook.')
        return
      }
      if (draftMatches.length === 0) {
        initializeMatchesFromParse(parseResult)
      }
      setStep(1)
      return
    }
    if (step === 1) {
      if (unmatchedCount > 0 || draftMatches.length === 0) {
        setStepError(
          `Cannot proceed: ${unmatchedCount} door group(s) are still unmatched. Match each door group to a Standard Set or choose Custom.`,
        )
        return
      }
      if (blankCustomCount > 0) {
        setStepError(
          `Cannot proceed: ${blankCustomCount} custom door group(s) are missing a custom door group name.`,
        )
        return
      }
      if (lowConfidenceAutoCount > 0) {
        setStepError(
          `Cannot proceed: ${lowConfidenceAutoCount} low-confidence match(es) still need checking. Use Confirm in the row, or pick a different set.`,
        )
        return
      }
      setStep(2)
    }
  }

  const quotationChanges = useMemo(
    () => (isReimport && parseResult ? diffQuotationGroups(baseGroups, parseResult.groups) : null),
    [isReimport, parseResult, baseGroups],
  )
  const keptCount = draftMatches.filter((m) => m.carriedFromGroupId).length
  const doorChanges: DoorChanges | null = useMemo(
    () => (parseResult && previousDoorsQuery.data ? compareDoors(previousDoorsQuery.data, parseResult.doors) : null),
    [parseResult, previousDoorsQuery.data],
  )
  const variationAdded = parseResult ? parseResult.doors.filter((d) => d.variation).reduce((n, d) => n + d.qty, 0) : 0
  const variationRemoved = parseResult
    ? parseResult.variationRows.filter((v) => v.kind === 'removed').reduce((n, v) => n + (v.qty ?? 0), 0)
    : 0
  // Each green row: counted or not, and the door group it's in (an existing
  // group when it has doors that aren't in the variation, else a new group).
  const variationDetails = useMemo(() => {
    if (!parseResult) return []
    const doorByRowHere = new Map(parseResult.doors.map((d) => [d.source_row, d]))
    const excludedRows = new Map(parseResult.excluded.map((e) => [e.row, e]))
    return parseResult.variationRows.map((v) => {
      const door = doorByRowHere.get(v.row) ?? null
      const group = door ? parseResult.groups.find((g) => g.source_rows.includes(v.row)) ?? null : null
      const others = group
        ? group.source_rows.filter((row) => !doorByRowHere.get(row)?.variation).reduce((n, row) => n + (doorByRowHere.get(row)?.qty ?? 0), 0)
        : 0
      const status = door
        ? 'added'
        : v.kind === 'removed'
          ? 'removed'
          : excludedRows.has(v.row)
            ? 'excluded'
            : 'not counted'
      return { v, door, group, existing: others > 0, others, excludedReason: excludedRows.get(v.row)?.reason ?? '', status }
    })
      // The doors added first, then rows that aren't counted.
      .sort((a, b) => {
        const rank = (s: string) => (s === 'added' ? 0 : s === 'removed' ? 1 : 2)
        return rank(a.status) - rank(b.status) || a.v.row - b.v.row
      })
  }, [parseResult])

  const doorChangesPanel = doorChanges && baseVersion && (
    <div className="border border-neutral-300 bg-neutral-50 rounded p-3 space-y-1.5">
      <div className="text-xs font-semibold text-neutral-950">
        Doors compared with the file of v{baseVersion.version_no}
      </div>
      <DoorChangesSummary changes={doorChanges} />
    </div>
  )

  const targetLabel = !isReimport
    ? 'Create Version 1'
    : replacesDraft
      ? 'Replace Draft Quotation'
      : `Create Version ${nextVersionNo}`

  const changesPanel = quotationChanges && baseVersion && (
    <div className="space-y-2">
    {doorChangesPanel}
    <div className="border border-neutral-300 bg-neutral-50 rounded p-3 text-xs space-y-1.5">
      <div className="font-semibold text-neutral-950">
        Changes compared with v{baseVersion.version_no}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 font-mono text-neutral-800">
        <span>New groups: {quotationChanges.added.length}</span>
        <span>Removed: {quotationChanges.removed.length}</span>
        <span>Door qty changed: {quotationChanges.qtyChanged.length}</span>
        <span>Unchanged: {quotationChanges.unchangedCount}</span>
      </div>
      <div className="text-neutral-600">
        {keptCount} door group{keptCount === 1 ? '' : 's'} keep their hardware, edits, prices and
        PM remarks (door quantities come from the new file). New groups are matched to standard sets.
      </div>
      {quotationChanges.removed.length > 0 && (
        <div className="text-neutral-700">
          Removed:{' '}
          {quotationChanges.removed
            .map((g) => `${g.room_name}${g.door_size ? ` (${g.door_size})` : ''}`)
            .join(', ')}
        </div>
      )}
      {quotationChanges.qtyChanged.length > 0 && (
        <div className="text-neutral-700">
          Qty changed:{' '}
          {quotationChanges.qtyChanged
            .map((c) => `${c.group.room_name} ${c.oldQty} → ${c.newQty}`)
            .join(', ')}
        </div>
      )}
      {quotationChanges.split.length > 0 && (
        <div className="font-medium text-neutral-950">
          Split by hardware (each new group keeps the old lines — check them):{' '}
          {quotationChanges.split
            .map(
              (s) =>
                `${[s.base.door_tag, s.base.room_name].filter(Boolean).join(' ')} → ${s.groups
                  .map((g) => `${g.door_qty} × ${g.hardware || 'no hardware'}`)
                  .join(' / ')}`,
            )
            .join('; ')}
        </div>
      )}
      {quotationChanges.merged.length > 0 && (
        <div className="font-medium text-neutral-950">
          Rooms merged into one door group (it keeps the lines of the group with the most doors —
          check them):{' '}
          {quotationChanges.merged
            .map((m) => `${[m.group.door_tag, m.group.room_name].filter(Boolean).join(' ')}`)
            .join('; ')}
        </div>
      )}
    </div>
    </div>
  )

  const totalCopiedLines = draftMatches.reduce((sum, m) => {
    if (m.carriedFromGroupId) {
      return sum + (baseLinesByGroup.get(m.carriedFromGroupId)?.length ?? 0)
    }
    return sum + (sizedLinesByGroup.get(m.group.group_key)?.lines.length ?? 0)
  }, 0)
  const sizedGroupCount = [...sizedLinesByGroup.values()].filter((s) => s.notes.length > 0).length
  const flaggedLineCount = [...sizedLinesByGroup.values()].reduce(
    (n, s) => n + s.lines.filter((l) => l.review_flag).length,
    0,
  )
  const addedLineCount = [...sizedLinesByGroup.values()].reduce(
    (n, s) => n + s.lines.filter((l) => l.origin === 'added').length,
    0,
  )
  const sheetTotalMismatch =
    parseResult?.sheetQtyTotal != null && parseResult.sheetQtyTotal !== parseResult.totalDoorQty

  return (
    <div className="border border-neutral-950 rounded-md bg-white p-6 space-y-6">
      <div className="flex items-center justify-between border-b border-neutral-200 pb-4">
        <div>
          <h2 className="text-lg font-bold tracking-tight text-neutral-950">
            {isReimport ? 'Re-import Quotation' : 'Import Quotation'}
          </h2>
          <p className="text-xs text-neutral-600 mt-0.5">
            {isReimport
              ? `Upload the updated quotation for ${projectName}. Door groups that haven't changed keep their hardware, edits and prices on every supplier sheet; new groups are matched to standard sets. ${
                  replacesDraft
                    ? `This replaces the quotation in draft v${baseVersion?.version_no}.`
                    : `This creates v${nextVersionNo}; v${baseVersion?.version_no} is kept in the history.`
                }`
              : `Upload ${builderName.trim() || 'the builder'}'s quotation for ${projectName}, review the door-to-set matches, then create version 1 of the quote. The first supplier sheet is ${supplier?.name ?? '—'}.`}
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={importMutation.isPending}
          onClick={onCancel}
        >
          <X className="h-3.5 w-3.5" />
          <span>Cancel</span>
        </Button>
      </div>

      {/* shadcn stepper-04 style horizontal stepper */}
      <Stepper
        steps={WIZARD_STEPS}
        currentStep={step}
        onStepClick={(idx) => {
          if (!importMutation.isPending && idx < step) {
            setStepError(null)
            setStep(idx)
          }
        }}
      />

      {stepError && (
        <div
          role="alert"
          className="border border-neutral-950 bg-neutral-50 p-3 text-xs text-neutral-950 flex items-start gap-2"
        >
          <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
          <span>{stepError}</span>
        </div>
      )}

      {/* STEP 1: Upload Quotation */}
      {step === 0 && parsing && parsingFile && (
        <div className="mx-auto w-full max-w-2xl pt-2">
          <ParsingProgress fileName={parsingFile.name} fileSize={parsingFile.size} progress={parseProgress} />
        </div>
      )}

      {step === 0 && !(parsing && parsingFile) && (
        <div className="space-y-4 pt-2">
          {!parseResult && (
          <div
            onDragOver={(e) => {
              e.preventDefault()
              setIsDragging(true)
            }}
            onDragLeave={() => setIsDragging(false)}
            onDrop={(e) => {
              e.preventDefault()
              setIsDragging(false)
              void handleFile(e.dataTransfer.files[0])
            }}
            className={`mx-auto w-full max-w-2xl border border-dashed rounded-md px-6 py-12 text-center transition-colors ${
              isDragging
                ? 'border-neutral-950 bg-neutral-100'
                : 'border-neutral-300 bg-neutral-50'
            }`}
          >
            <input
              ref={fileInputRef}
              type="file"
              accept=".xlsx"
              className="hidden"
              onChange={(e) => {
                void handleFile(e.target.files?.[0])
                e.target.value = ''
              }}
            />
            <Upload className="h-6 w-6 mx-auto text-neutral-700 mb-2" />
            <div className="text-sm font-medium text-neutral-950">
              {parsing
                ? 'Parsing quotation workbook...'
                : uploadedFile
                  ? `Selected: ${uploadedFile.name}`
                  : 'Drop a Mena quotation .xlsx file here, or click to browse'}
            </div>
            <p className="text-xs text-neutral-600 mt-1">
              Parsed locally for review — nothing is saved until the last step.
            </p>
            <div className="mt-4">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={parsing}
                onClick={() => fileInputRef.current?.click()}
              >
                {uploadedFile ? 'Replace .xlsx File' : 'Select .xlsx File'}
              </Button>
            </div>
          </div>
          )}

          {parseResult && (
            <div className="space-y-4">
              {uploadedFile && (
                <div className="flex items-center gap-2 text-sm text-neutral-950" data-testid="parsed-file">
                  <FileSpreadsheet className="h-4 w-4 shrink-0 text-neutral-500" />
                  <span className="truncate font-medium">Selected: {uploadedFile.name}</span>
                </div>
              )}
              <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
                <div className="border border-neutral-200 p-2.5 rounded">
                  <div className="text-[10px] uppercase tracking-wider text-neutral-500 font-semibold">
                    Parsed Rows
                  </div>
                  <div className="text-lg font-bold font-mono text-neutral-950">
                    {parseResult.doors.length}
                  </div>
                </div>
                <div className="border border-neutral-200 p-2.5 rounded">
                  <div className="text-[10px] uppercase tracking-wider text-neutral-500 font-semibold">
                    Total Door Qty
                  </div>
                  <div className="text-lg font-bold font-mono text-neutral-950">
                    {parseResult.totalDoorQty}
                  </div>
                  {parseResult.sheetQtyTotal != null && (
                    <div
                      className={`text-[11px] font-mono ${sheetTotalMismatch ? 'font-semibold text-red-700' : 'text-neutral-500'}`}
                    >
                      Sheet total {parseResult.sheetQtyTotal}
                      {sheetTotalMismatch ? ' — check Issues' : ' ✓'}
                    </div>
                  )}
                </div>
                <div className="border border-neutral-200 p-2.5 rounded">
                  <div className="text-[10px] uppercase tracking-wider text-neutral-500 font-semibold">
                    Door Groups
                  </div>
                  <div className="text-lg font-bold font-mono text-neutral-950">
                    {parseResult.groups.length}
                  </div>
                </div>
                <div className="border border-neutral-200 p-2.5 rounded">
                  <div className="text-[10px] uppercase tracking-wider text-neutral-500 font-semibold">
                    Excluded
                  </div>
                  <div className="text-lg font-bold font-mono text-neutral-950">
                    {parseResult.excludedCount}
                  </div>
                </div>
                <div className="border border-neutral-200 p-2.5 rounded">
                  <div className="text-[10px] uppercase tracking-wider text-neutral-500 font-semibold">
                    Issues
                  </div>
                  <div className="text-lg font-bold font-mono text-neutral-950">
                    {parseResult.issues.length}
                  </div>
                </div>
              </div>

              {doorChangesPanel}

              <div className="flex items-center gap-2 border-b border-neutral-200 pb-2">
                <Button
                  type="button"
                  variant={previewTab === 'groups' ? 'default' : 'outline'}
                  size="sm"
                  onClick={() => setPreviewTab('groups')}
                >
                  Door Groups ({parseResult.groups.length})
                </Button>
                <Button
                  type="button"
                  variant={previewTab === 'doors' ? 'default' : 'outline'}
                  size="sm"
                  onClick={() => setPreviewTab('doors')}
                >
                  Parsed Rows ({parseResult.doors.length})
                </Button>
                {parseResult.variationRows.length > 0 && (
                  <Button
                    type="button"
                    variant={previewTab === 'variation' ? 'default' : 'outline'}
                    size="sm"
                    onClick={() => setPreviewTab('variation')}
                  >
                    Variation ({variationAdded} added{variationRemoved > 0 ? `, ${variationRemoved} excluded` : ''})
                  </Button>
                )}
                <Button
                  type="button"
                  variant={previewTab === 'excluded' ? 'default' : 'outline'}
                  size="sm"
                  onClick={() => setPreviewTab('excluded')}
                >
                  Excluded ({parseResult.excluded.length})
                </Button>
                <Button
                  type="button"
                  variant={previewTab === 'issues' ? 'default' : 'outline'}
                  size="sm"
                  onClick={() => setPreviewTab('issues')}
                >
                  Issues ({parseResult.issues.length})
                </Button>
              </div>

              {/* Up to 70% of the screen height: the lists are long. */}
              <div className="max-h-[70vh] overflow-y-auto border border-neutral-200">
                {previewTab === 'groups' && (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>#</TableHead>
                        <TableHead>Door Tag</TableHead>
                        <TableHead>Room Name</TableHead>
                        <TableHead>Classification</TableHead>
                        <TableHead>Leaf</TableHead>
                        <TableHead>Size</TableHead>
                        <TableHead>Builder HW</TableHead>
                        <TableHead>Prep / Install</TableHead>
                        <TableHead>Comments</TableHead>
                        <TableHead className="text-right">Qty</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {parseResult.groups.map((g) => (
                        <TableRow key={g.group_key}>
                          <TableCell className="font-mono text-xs">{g.position}</TableCell>
                          <TableCell className="font-mono text-xs font-semibold">
                            {g.door_tag || '—'}
                          </TableCell>
                          <TableCell className="text-xs font-medium">{g.room_name}</TableCell>
                          <TableCell className="text-xs">{g.classification ?? '—'}</TableCell>
                          <TableCell className="text-xs">{g.leaf ?? '—'}</TableCell>
                          <TableCell className="font-mono text-xs">{g.door_size ?? '—'}</TableCell>
                          <TableCell>
                            <HardwareCell hardware={g.hardware} headers={hwHeaders} prepValues={g.prep_values} part="builder" />
                          </TableCell>
                          <TableCell>
                            <HardwareCell hardware={g.hardware} headers={hwHeaders} prepValues={g.prep_values} part="prep" />
                          </TableCell>
                          <TableCell>
                            <CommentsCell doors={g.source_rows.map((row) => doorByRow.get(row))} />
                          </TableCell>
                          <TableCell className="font-mono text-xs text-right font-semibold">
                            {g.door_qty}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}

                {previewTab === 'doors' && (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Row</TableHead>
                        <TableHead>Door Ref</TableHead>
                        <TableHead>Room Name</TableHead>
                        <TableHead>Classification</TableHead>
                        <TableHead>Leaf</TableHead>
                        <TableHead>Size</TableHead>
                        <TableHead>Builder HW</TableHead>
                        <TableHead>Prep / Install</TableHead>
                        <TableHead>Comments</TableHead>
                        <TableHead className="text-right">Qty</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {parseResult.doors.slice(0, 200).map((d) => (
                        <TableRow key={`${d.source_row}-${d.door_ref}`}>
                          <TableCell className="font-mono text-xs">{d.source_row}</TableCell>
                          <TableCell className="text-xs">
                            {d.door_ref}
                            {d.variation && (
                              <span className="ml-1 inline-block border border-green-700 bg-green-50 px-1 text-[10px] font-semibold uppercase text-green-800">
                                Variation
                              </span>
                            )}
                          </TableCell>
                          <TableCell className="text-xs font-medium">{d.room_name}</TableCell>
                          <TableCell className="text-xs">{d.classification ?? '—'}</TableCell>
                          <TableCell className="text-xs">{d.leaf ?? '—'}</TableCell>
                          <TableCell className="font-mono text-xs">{d.door_size ?? '—'}</TableCell>
                          <TableCell>
                            <HardwareCell hardware={d.hardware} headers={hwHeaders} prepValues={d.prep_values} part="builder" />
                          </TableCell>
                          <TableCell>
                            <HardwareCell hardware={d.hardware} headers={hwHeaders} prepValues={d.prep_values} part="prep" />
                          </TableCell>
                          <TableCell>
                            <CommentsCell doors={[d]} />
                          </TableCell>
                          <TableCell className="font-mono text-xs text-right">{d.qty}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}

                {previewTab === 'variation' && (
                  <Table data-testid="variation-table">
                    <TableHeader>
                      <TableRow>
                        <TableHead>Row</TableHead>
                        <TableHead>Door Ref</TableHead>
                        <TableHead>Room Name</TableHead>
                        <TableHead>Door Specs</TableHead>
                        <TableHead>Builder HW</TableHead>
                        <TableHead>Prep / Install</TableHead>
                        <TableHead className="text-right">Qty</TableHead>
                        <TableHead>Door Group</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {variationDetails.map(({ v, door, group, existing, others, excludedReason, status }) => (
                        <TableRow key={v.row} className={status === 'added' ? '' : 'text-neutral-400'}>
                          <TableCell className="font-mono text-xs">{v.row}</TableCell>
                          <TableCell className="text-xs">{v.rawRef}</TableCell>
                          <TableCell className="text-xs font-medium">{v.room_name}</TableCell>
                          <TableCell className="font-mono text-xs">
                            {door ? [door.classification, door.leaf, door.door_size].filter(Boolean).join(' · ') : '—'}
                          </TableCell>
                          <TableCell>
                            <HardwareCell hardware={door?.hardware} headers={hwHeaders} prepValues={door?.prep_values} part="builder" />
                          </TableCell>
                          <TableCell>
                            <HardwareCell hardware={door?.hardware} headers={hwHeaders} prepValues={door?.prep_values} part="prep" />
                          </TableCell>
                          <TableCell className="font-mono text-xs text-right">{v.qty ?? '—'}</TableCell>
                          <TableCell className="text-xs">
                            {status === 'added' && group ? (
                              existing ? (
                                <span>
                                  Added to existing group #{group.position} {group.room_name}{' '}
                                  <span className="text-neutral-500">
                                    ({others} → {group.door_qty} doors)
                                  </span>
                                </span>
                              ) : (
                                <span className="font-semibold text-green-800">
                                  New door group #{group.position} {group.room_name}{' '}
                                  <span className="font-normal text-neutral-500">(matched to a set in the next step)</span>
                                </span>
                              )
                            ) : status === 'removed' ? (
                              <span className="font-semibold text-red-700">
                                Excluded (red row) — not counted{v.qty ? '; can be included back in Excluded' : ''}
                              </span>
                            ) : status === 'excluded' ? (
                              <span>Excluded — {excludedReason}</span>
                            ) : (
                              <span>Not counted (no QTY)</span>
                            )}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}

                {previewTab === 'excluded' && (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Row</TableHead>
                        <TableHead>Ref</TableHead>
                        <TableHead>Room Name</TableHead>
                        <TableHead>Why</TableHead>
                        <TableHead className="text-right">Qty</TableHead>
                        <TableHead>Include</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {parseResult.excluded.length === 0 ? (
                        <TableRow>
                          <TableCell colSpan={6} className="text-center text-xs text-neutral-500 py-6">
                            No rows were excluded.
                          </TableCell>
                        </TableRow>
                      ) : (
                        parseResult.excluded.map((e) => (
                          <TableRow key={e.row}>
                            <TableCell className="font-mono text-xs">{e.row}</TableCell>
                            <TableCell className="text-xs">{e.rawRef}</TableCell>
                            <TableCell className="text-xs font-medium">{e.room_name || '—'}</TableCell>
                            <TableCell className="text-xs text-neutral-600">{e.reason}</TableCell>
                            <TableCell className="font-mono text-xs text-right">{e.qty ?? '—'}</TableCell>
                            <TableCell>
                              {e.door ? (
                                <input
                                  type="checkbox"
                                  aria-label={`Include row ${e.row}`}
                                  checked={parseResult.includedRows.includes(e.row)}
                                  onChange={() => toggleIncludedRow(e.row)}
                                  className="h-3.5 w-3.5 accent-neutral-950"
                                />
                              ) : (
                                <span className="text-[11px] text-neutral-400" title="No QTY on this row">
                                  —
                                </span>
                              )}
                            </TableCell>
                          </TableRow>
                        ))
                      )}
                    </TableBody>
                  </Table>
                )}

                {previewTab === 'issues' && (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Row</TableHead>
                        <TableHead>Severity</TableHead>
                        <TableHead>Ref</TableHead>
                        <TableHead>Message</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {parseResult.issues.length === 0 ? (
                        <TableRow>
                          <TableCell colSpan={4} className="text-center text-xs text-neutral-500 py-6">
                            No issues detected.
                          </TableCell>
                        </TableRow>
                      ) : (
                        parseResult.issues.map((issue, idx) => (
                          <TableRow key={`${issue.row}-${idx}`}>
                            <TableCell className="font-mono text-xs">{issue.row}</TableCell>
                            <TableCell>
                              <Badge variant="outline" className="uppercase text-[10px]">
                                {issue.severity}
                              </Badge>
                            </TableCell>
                            <TableCell className="text-xs">{issue.rawRef ?? '—'}</TableCell>
                            <TableCell className="text-xs">
                              {issue.message}
                              {issue.splits && issue.splits.length > 1 && (
                                <SplitGroupsTable splits={issue.splits} headers={hwHeaders} />
                              )}
                            </TableCell>
                          </TableRow>
                        ))
                      )}
                    </TableBody>
                  </Table>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {/* STEP 2: Door-to-Set Matching Review */}
      {step === 1 && (
        <div className="space-y-4 pt-2">
          {changesPanel}
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div className="text-xs text-neutral-600 space-y-0.5">
              <div>Match all door groups to Standard Sets before proceeding to Summary.</div>
              {lowConfidenceAutoCount > 0 && (
                <div className="font-medium text-neutral-950">
                  {lowConfidenceAutoCount} low-confidence match
                  {lowConfidenceAutoCount === 1 ? '' : 'es'} (below{' '}
                  {Math.round(AUTO_MATCH_THRESHOLD * 100)}%) need checking: use Confirm in the
                  row, pick a different set, or Confirm All Auto.
                </div>
              )}
            </div>
            <div className="flex items-center gap-2">
              {selectedForMerge.size > 0 && (
                <Button
                  type="button"
                  size="sm"
                  disabled={selectedMergeItems.length < 2}
                  onClick={() => setDraftMergePlan(planDraftMerge(selectedMergeItems.map((m) => m.group)))}
                  title={selectedMergeItems.length < 2 ? 'Tick at least two door groups' : undefined}
                >
                  <Merge className="h-3.5 w-3.5" />
                  <span>Merge {selectedMergeItems.length} groups</span>
                </Button>
              )}
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={standardSets.length === 0}
                onClick={runAutoMatch}
              >
                <Sparkles className="h-3.5 w-3.5" />
                <span>Run Auto-Match</span>
              </Button>
              <Button
                type="button"
                size="sm"
                disabled={highConfidenceAutoCount === 0}
                onClick={confirmAllAuto}
                title={`Confirms auto matches scoring ${Math.round(AUTO_MATCH_THRESHOLD * 100)}% or more`}
              >
                <CheckCheck className="h-3.5 w-3.5" />
                <span>Confirm Auto Matches ({highConfidenceAutoCount})</span>
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={allAutoWithSetCount === 0}
                onClick={confirmEveryAuto}
                title="Confirms every AUTO match, including low-confidence ones"
              >
                <CheckCheck className="h-3.5 w-3.5" />
                <span>Confirm All Auto ({allAutoWithSetCount})</span>
              </Button>
            </div>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div className="border border-neutral-200 p-2.5 rounded">
              <div className="text-[10px] uppercase tracking-wider text-neutral-500 font-semibold">
                Total Groups
              </div>
              <div className="text-lg font-bold font-mono text-neutral-950">
                {draftMatches.length}
              </div>
            </div>
            <div className="border border-neutral-200 p-2.5 rounded">
              <div className="text-[10px] uppercase tracking-wider text-neutral-500 font-semibold">
                Confirmed / Manual
              </div>
              <div className="text-lg font-bold font-mono text-neutral-950">
                {confirmedOrManualCount}
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

          <div className="flex flex-wrap items-center gap-2" data-testid="matching-filter">
            <div className="relative w-full max-w-xs">
              <Search className="absolute left-2.5 top-2 h-3.5 w-3.5 text-neutral-400" />
              <Input
                aria-label="Filter door groups"
                placeholder="Filter door groups (room, tag, size, hardware, set)…"
                value={groupFilter}
                onChange={(e) => setGroupFilter(e.target.value)}
                className="h-8 pl-8 text-xs"
              />
            </div>
            <select
              aria-label="Filter by status"
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as typeof statusFilter)}
              className="h-8 border border-neutral-300 bg-white px-2 text-xs text-neutral-950 focus:outline-none focus:ring-1 focus:ring-neutral-950"
            >
              <option value="ALL">All statuses</option>
              <option value="unmatched">Unmatched</option>
              <option value="auto">Auto</option>
              <option value="confirmed">Confirmed</option>
              <option value="manual">Manual</option>
            </select>
            {(groupFilter || statusFilter !== 'ALL') && (
              <>
                <span className="text-xs text-neutral-600">
                  Showing {visibleMatches.length} of {draftMatches.length}
                </span>
                <button
                  type="button"
                  className="text-xs text-neutral-600 underline hover:text-neutral-950"
                  onClick={() => {
                    setGroupFilter('')
                    setStatusFilter('ALL')
                  }}
                >
                  Clear
                </button>
              </>
            )}
          </div>

          <MergeDraftGroupsDialog
            open={draftMergePlan !== null}
            onOpenChange={(open) => {
              if (!open) setDraftMergePlan(null)
            }}
            plan={draftMergePlan}
            onConfirm={confirmDraftMerge}
          />

          {/* Up to 70% of the screen height, like the upload step's lists. */}
          <div className="max-h-[70vh] overflow-y-auto border border-neutral-200">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>#</TableHead>
                  <TableHead>Door Tag</TableHead>
                  <TableHead>Door Group</TableHead>
                  <TableHead className="text-right">Doors</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Standard Set</TableHead>
                  <TableHead>Score &amp; Reason</TableHead>
                  <TableHead>Comments</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visibleMatches.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={8} className="py-6 text-center text-xs text-neutral-500">
                      No door groups match the filter.
                    </TableCell>
                  </TableRow>
                )}
                {visibleMatches.map((item) => {
                  const g = item.group
                  const topCandidates =
                    candidateMap.get(g.group_key)?.topCandidates ?? []
                  const topIds = new Set(topCandidates.map((c) => c.set.id))
                  const otherSets = standardSets.filter((s) => !topIds.has(s.id))

                  return (
                    <TableRow key={g.group_key}>
                      <TableCell className="font-mono text-xs">
                        <span className="flex items-center gap-1.5">
                          {!item.carriedFromGroupId && (
                            <input
                              type="checkbox"
                              className="h-3.5 w-3.5 accent-neutral-950"
                              checked={selectedForMerge.has(g.group_key)}
                              onChange={() => toggleMergeSelect(g.group_key)}
                              aria-label={`Select ${g.room_name} to merge`}
                            />
                          )}
                          {g.position}
                        </span>
                      </TableCell>
                      <TableCell className="font-mono text-xs font-semibold">
                        {g.door_tag || '—'}
                      </TableCell>
                      <TableCell>
                        <div className="text-xs font-semibold text-neutral-950">
                          {g.room_name}
                        </div>
                        <div className="text-[11px] text-neutral-600 font-mono">
                          {[g.classification || '—', g.leaf || '—', g.door_size || '—'].join(
                            ' · ',
                          )}
                        </div>
                        {g.hardware && (
                          <div className="mt-0.5">
                            <HardwareCell hardware={g.hardware} headers={hwHeaders} prepValues={g.prep_values} className="text-neutral-500" />
                          </div>
                        )}
                        {item.mergedFrom && item.mergedFrom.length > 1 && (
                          <button
                            type="button"
                            onClick={() => unmergeDraft(g.group_key)}
                            className="mt-1 inline-flex items-center gap-1 rounded border border-neutral-300 bg-white px-1.5 py-px text-[10px] font-semibold text-neutral-700 hover:bg-neutral-50"
                            title={`Merged from ${item.mergedFrom.map((p) => `${p.group.room_name} (${p.group.door_qty})`).join(', ')}`}
                            aria-label={`Unmerge ${g.room_name}`}
                          >
                            <Split className="h-2.5 w-2.5" />
                            Unmerge
                          </button>
                        )}
                      </TableCell>
                      <TableCell className="font-mono text-xs text-right font-semibold">
                        {g.door_qty}
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant={
                            item.matchStatus === 'confirmed' ||
                            item.matchStatus === 'manual'
                              ? 'default'
                              : 'outline'
                          }
                          className="uppercase tracking-wider text-[10px]"
                        >
                          {item.matchStatus}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <div className="space-y-1.5">
                          <select
                            aria-label={`Standard Set for ${g.room_name}`}
                            value={
                              item.matchStatus === 'manual' && !item.matchedSetId
                                ? (savedCustomValue(item.customGroupName) ?? CUSTOM_SET_VALUE)
                                : item.matchedSetId ?? ''
                            }
                            onChange={(e) =>
                              updateManualMatch(g.group_key, e.target.value)
                            }
                            className="h-8 w-full max-w-xs border border-neutral-300 bg-white px-2 text-xs text-neutral-950 focus:outline-none focus:ring-1 focus:ring-neutral-950"
                          >
                            <option value="">— Unmatched —</option>
                            <option value={CUSTOM_SET_VALUE}>
                              Custom (Type door group...)
                            </option>
                            {savedCustomNames.length > 0 && (
                              <optgroup label="Custom Door Groups (this project)">
                                {savedCustomNames.map((name) => (
                                  <option key={name} value={SAVED_CUSTOM_PREFIX + name}>
                                    Custom: {name}
                                  </option>
                                ))}
                              </optgroup>
                            )}
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

                          {item.matchStatus === 'manual' && !item.matchedSetId && (
                            <CustomGroupInput
                              aria-label={`Custom door group for ${g.room_name}`}
                              value={item.customGroupName}
                              onCommit={(name) => updateCustomGroupName(g.group_key, name)}
                              placeholder="Type custom door group..."
                              className="h-8 w-full max-w-xs text-xs"
                            />
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="text-xs text-neutral-600 max-w-xs">
                        {item.matchScore !== null && (
                          <span className="font-mono font-semibold text-neutral-900 mr-1.5">
                            {Math.round(item.matchScore * 100)}%
                          </span>
                        )}
                        {item.carriedFromGroupId && (
                          <span className="mr-1.5 inline-block border border-neutral-400 px-1 text-[10px] font-semibold uppercase tracking-wider text-neutral-700">
                            Kept from v{baseVersion?.version_no}
                          </span>
                        )}
                        <span>{item.matchReason || '—'}</span>
                        {(sizedLinesByGroup.get(g.group_key)?.flagNotes.length ?? 0) > 0 && (
                          <NoteList
                            title="Changed from the quotation"
                            notes={sizedLinesByGroup.get(g.group_key)?.flagNotes ?? []}
                            testId="schedule-notes"
                            grouped
                          />
                        )}
                        {(sizedLinesByGroup.get(g.group_key)?.notes.length ?? 0) > 0 && (
                          <NoteList
                            title={`Sized for ${g.door_size}`}
                            notes={sizedLinesByGroup.get(g.group_key)?.notes ?? []}
                            testId="sizing-notes"
                          />
                        )}
                        {item.matchStatus === 'auto' &&
                          item.matchedSetId &&
                          !isHighConfidenceAuto(item) && (
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              className="ml-2 h-6 px-2 text-[11px]"
                              aria-label={`Confirm match for ${g.room_name}`}
                              onClick={() => confirmOne(g.group_key)}
                            >
                              Confirm
                            </Button>
                          )}
                      </TableCell>
                      <TableCell>
                        <CommentsCell doors={g.source_rows.map((row) => doorByRow.get(row))} />
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </div>
        </div>
      )}

      {/* STEP 3: Summary & Create */}
      {step === 2 && parseResult && uploadedFile && (
        <div className="space-y-4 pt-2">
          {changesPanel}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="border border-neutral-200 rounded p-4 space-y-2">
              <div className="text-[11px] font-semibold uppercase tracking-wider text-neutral-500">
                Project
              </div>
              <div className="text-sm font-bold text-neutral-950">{projectName}</div>
              {!isReimport && (
                <div className="text-xs text-neutral-800">
                  Builder: <span className="font-semibold">{builderName.trim()}</span>
                  <br />
                  First sheet: <span className="font-semibold">{supplier?.name}</span>
                </div>
              )}
              <div className="text-xs text-neutral-600">
                {!isReimport
                  ? 'Creates version 1 (draft) of the quote with the matched hardware lines.'
                  : replacesDraft
                    ? `Replaces the quotation in draft v${baseVersion?.version_no}.`
                    : `Creates v${nextVersionNo} (draft); v${baseVersion?.version_no} is kept in the history.`}
              </div>
            </div>

            <div className="border border-neutral-200 rounded p-4 space-y-2">
              <div className="text-[11px] font-semibold uppercase tracking-wider text-neutral-500 flex items-center gap-1.5">
                <FileSpreadsheet className="h-3.5 w-3.5" />
                <span>Quotation File</span>
              </div>
              <div className="text-xs font-semibold text-neutral-950 break-all">
                {uploadedFile.name}
              </div>
              <div className="text-xs text-neutral-600 space-y-1 font-mono">
                <div>Sheet: {parseResult.sheetName}</div>
                <div>Parsed Rows: {parseResult.doors.length}</div>
                <div>Total Door Qty: {parseResult.totalDoorQty}</div>
                <div>Excluded Rows: {parseResult.excludedCount}</div>
                {variationAdded > 0 && <div>Added in Variation: {variationAdded}</div>}
                {parseResult.includedRows.length > 0 && (
                  <div>Included Back: {parseResult.includedRows.length}</div>
                )}
                {parseResult.sheetQtyTotal != null && <div>Sheet QTY Total: {parseResult.sheetQtyTotal}</div>}
              </div>
            </div>

            <div className="border border-neutral-200 rounded p-4 space-y-2">
              <div className="text-[11px] font-semibold uppercase tracking-wider text-neutral-500 flex items-center gap-1.5">
                <CheckCircle2 className="h-3.5 w-3.5" />
                <span>Matching Review</span>
              </div>
              <div className="text-xs text-neutral-600 space-y-1 font-mono">
                <div>Total Door Groups: {draftMatches.length}</div>
                <div>Matched to Standard Set: {matchedCount}</div>
                <div>Custom Door Groups: {customCount}</div>
                <div>Hardware Lines: {totalCopiedLines}</div>
                <div>Groups Sized for Door: {sizedGroupCount}</div>
                <div>Lines Added from Schedule: {addedLineCount}</div>
                <div>Lines Flagged to Check: {flaggedLineCount}</div>
                {isReimport && <div>Kept From v{baseVersion?.version_no}: {keptCount}</div>}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Footer Navigation */}
      <div className="flex items-center justify-between border-t border-neutral-200 pt-4">
        {step === 0 && parseResult ? (
          <Button type="button" variant="outline" size="sm" disabled={parsing} onClick={uploadAgain}>
            <Upload className="h-3.5 w-3.5" />
            <span>Upload again</span>
          </Button>
        ) : (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={step === 0 || importMutation.isPending}
            onClick={() => {
              setStepError(null)
              setStep((s) => Math.max(0, s - 1))
            }}
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            <span>Back</span>
          </Button>
        )}

        {step < 2 ? (
          <Button
            type="button"
            size="sm"
            disabled={
              parsing ||
              (step === 1 &&
                (unmatchedCount > 0 ||
                  blankCustomCount > 0 ||
                  draftMatches.length === 0))
            }
            onClick={handleNext}
          >
            <span>Next</span>
            <ArrowRight className="h-3.5 w-3.5" />
          </Button>
        ) : (
          <Button
            type="button"
            size="sm"
            disabled={importMutation.isPending || (lookupsLoading && !lookupsFailed)}
            onClick={() => (lookupsFailed ? retryLookups() : importMutation.mutate())}
            title={lookupsFailed ? "The parts library or generic items didn't load" : undefined}
          >
            <span>
              {importMutation.isPending
                ? 'Saving...'
                : lookupsFailed
                  ? "Parts didn't load — retry"
                  : lookupsLoading
                    ? 'Loading parts…'
                    : targetLabel}
            </span>
          </Button>
        )}
      </div>
    </div>
  )
}
