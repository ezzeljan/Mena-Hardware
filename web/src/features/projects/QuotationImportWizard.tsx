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
} from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { fetchAllRows } from '@/lib/fetchAll'
import { useAuth } from '@/features/auth/AuthContext'
import type {
  DoorGroup,
  Part,
  ProjectLine,
  ProjectVersion,
  StandardSet,
  StandardSetLine,
} from '@/types/database'
import { fetchVersionGroups, fetchVersionLines } from '@/features/projects/projectData'
import {
  carriedLinesPayload,
  customNameFromReason,
  diffQuotationGroups,
} from '@/features/projects/quotationReimport'
import type {
  ParsedDoorGroupPreview,
  QuotationParseResult,
} from '@/features/projects/quotationParser'
import { parseQuotationInBackground } from '@/features/projects/quotationParseClient'
import {
  AUTO_MATCH_THRESHOLD,
  matchDoorGroup,
  type GroupMatchResult,
} from '@/features/projects/doorMatcher'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
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
   * 'reimport': load an updated quotation into a project that already has one.
   * Door groups that didn't change keep their set, edited lines, prices and PM
   * remarks; new groups are matched; removed groups are dropped.
   */
  mode?: 'import' | 'reimport'
  /** Re-import only: the version the new file is compared with (the draft, or the latest version). */
  baseVersion?: ProjectVersion | null
  /** Re-import only: version number created when baseVersion is not a draft. */
  nextVersionNo?: number
}

const CUSTOM_SET_VALUE = '__CUSTOM__'

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
  const [previewTab, setPreviewTab] = useState<'groups' | 'doors' | 'issues'>('groups')
  const [uploadedFile, setUploadedFile] = useState<File | null>(null)
  const [parseResult, setParseResult] = useState<QuotationParseResult | null>(null)

  // Step 2: Matching state
  const [draftMatches, setDraftMatches] = useState<DraftGroupMatch[]>([])

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
    queryFn: (): Promise<Pick<Part, 'id' | 'sku'>[]> =>
      fetchAllRows<Pick<Part, 'id' | 'sku'>>((from, to) =>
        supabase
          .from('parts')
          .select('id, sku')
          .order('id', { ascending: true })
          .range(from, to),
      ),
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

  const baseGroups = useMemo(() => baseQuery.data?.groups ?? [], [baseQuery.data])
  const baseByKey = useMemo(() => new Map(baseGroups.map((g) => [g.group_key, g])), [baseGroups])
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

  const partBySku = useMemo(() => {
    const map = new Map<string, string>()
    for (const p of partsQuery.data ?? []) {
      map.set(p.sku.trim().toUpperCase(), p.id)
    }
    return map
  }, [partsQuery.data])

  const candidateMap = useMemo(() => {
    const map = new Map<string, GroupMatchResult>()
    if (standardSets.length === 0) return map
    for (const item of draftMatches) {
      map.set(
        item.group.group_key,
        matchDoorGroup(
          {
            id: item.group.group_key,
            room_name: item.group.room_name,
            classification: item.group.classification ?? '',
            leaf: item.group.leaf ?? '',
            door_size: item.group.door_size ?? '',
          },
          standardSets,
        ),
      )
    }
    return map
  }, [draftMatches, standardSets])

  const initializeMatchesFromParse = useCallback(
    (result: QuotationParseResult) => {
      const next: DraftGroupMatch[] = result.groups.map((g) => {
        // Re-import: an unchanged door group keeps what it had.
        const base = isReimport ? baseByKey.get(g.group_key) : undefined
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
            room_name: g.room_name,
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
    [standardSets, isReimport, baseByKey],
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
    setParsing(true)
    try {
      const buffer = await file.arrayBuffer()
      const result = await parseQuotationInBackground(buffer)
      setUploadedFile(file)
      setParseResult(result)
      setPreviewTab('groups')
      initializeMatchesFromParse(result)
    } catch (err) {
      setStepError(
        err instanceof Error ? err.message : 'Failed to parse quotation workbook.',
      )
      setUploadedFile(null)
      setParseResult(null)
      setDraftMatches([])
    } finally {
      setParsing(false)
    }
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
            room_name: item.group.room_name,
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
        if (setId === CUSTOM_SET_VALUE) {
          const trimmed = item.customGroupName.trim()
          return {
            ...item,
          carriedFromGroupId: null,
            matchedSetId: null,
            matchStatus: 'manual',
            matchScore: null,
            matchReason: trimmed ? `Custom: ${trimmed}` : 'Custom door group',
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
  const unmatchedCount = draftMatches.filter((m) => m.matchStatus === 'unmatched').length

  const importMutation = useMutation({
    mutationFn: async (): Promise<string> => {
      if (!user) throw new Error('Must be signed in to import a quotation.')
      if (!uploadedFile || !parseResult) {
        throw new Error('Quotation workbook is required.')
      }
      if (unmatchedCount > 0 || blankCustomCount > 0) {
        throw new Error('All door groups must be matched or have a custom door group name.')
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

      const groups = draftMatches.map((m) => {
        if (m.carriedFromGroupId) {
          // Unchanged group: keep its lines (edits and prices) and PM remarks; new door qty.
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
            lines: carriedLinesPayload(baseLinesByGroup.get(m.carriedFromGroupId) ?? []),
          }
        }
        const set = m.matchedSetId ? setById.get(m.matchedSetId) : undefined
        const setLines = [...(set?.standard_set_lines ?? [])].sort(
          (a: StandardSetLine, b: StandardSetLine) => a.position - b.position,
        )
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
          // Copy the standard set's lines; a blank set price stays null (never 0).
          lines: setLines.map((line, idx) => ({
            position: idx + 1,
            sku: line.sku,
            description: line.description,
            qty_per_door: line.qty,
            unit_price: line.unit_price,
            origin: 'set',
            part_id: partBySku.get(line.sku.trim().toUpperCase()) ?? null,
          })),
        }
      })

      const { data: versionId, error: importErr } = await supabase.rpc(
        isReimport ? 'reimport_quotation' : 'import_quotation',
        {
        p_project_id: projectId,
        p_storage_path: storagePath,
        p_original_filename: uploadedFile.name,
        p_parse_report: parseResult.report,
        p_doors: doors,
          p_groups: groups,
        },
      )
      if (importErr) throw importErr

      return versionId as string
    },
    onSuccess: async (versionId) => {
      await queryClient.invalidateQueries({ queryKey: ['project', projectId] })
      await queryClient.invalidateQueries({ queryKey: ['projects'] })
      // A re-imported draft keeps its id, so its cached groups/lines must refresh.
      await queryClient.invalidateQueries({ queryKey: ['door_groups'] })
      await queryClient.invalidateQueries({ queryKey: ['project_lines'] })
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

  const targetLabel = !isReimport
    ? 'Create Version 1'
    : replacesDraft
      ? 'Replace Draft Quotation'
      : `Create Version ${nextVersionNo}`

  const changesPanel = quotationChanges && baseVersion && (
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
    </div>
  )

  const totalCopiedLines = draftMatches.reduce((sum, m) => {
    if (m.carriedFromGroupId) {
      return sum + (baseLinesByGroup.get(m.carriedFromGroupId)?.length ?? 0)
    }
    if (!m.matchedSetId) return sum
    return sum + (setById.get(m.matchedSetId)?.standard_set_lines?.length ?? 0)
  }, 0)

  return (
    <div className="border border-neutral-950 rounded-md bg-white p-6 space-y-6">
      <div className="flex items-center justify-between border-b border-neutral-200 pb-4">
        <div>
          <h2 className="text-lg font-bold tracking-tight text-neutral-950">
            {isReimport ? 'Re-import Quotation' : 'Import Quotation'}
          </h2>
          <p className="text-xs text-neutral-600 mt-0.5">
            {isReimport
              ? `Upload the updated quotation for ${projectName}. Door groups that haven't changed keep their hardware, edits and prices; new groups are matched to standard sets. ${
                  replacesDraft
                    ? `This replaces the quotation in draft v${baseVersion?.version_no}.`
                    : `This creates v${nextVersionNo}; v${baseVersion?.version_no} is kept in the history.`
                }`
              : `Upload the quotation, review the door-to-set matches, then create version 1 of ${projectName}.`}
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
      {step === 0 && (
        <div className="space-y-4 pt-2">
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
            className={`border border-dashed rounded-md p-6 text-center transition-colors ${
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

          {parseResult && (
            <div className="space-y-4">
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
                <Button
                  type="button"
                  variant={previewTab === 'issues' ? 'default' : 'outline'}
                  size="sm"
                  onClick={() => setPreviewTab('issues')}
                >
                  Issues ({parseResult.issues.length})
                </Button>
              </div>

              <div className="max-h-72 overflow-y-auto border border-neutral-200">
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
                        <TableHead className="text-right">Qty</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {parseResult.doors.slice(0, 200).map((d) => (
                        <TableRow key={`${d.source_row}-${d.door_ref}`}>
                          <TableCell className="font-mono text-xs">{d.source_row}</TableCell>
                          <TableCell className="text-xs">{d.door_ref}</TableCell>
                          <TableCell className="text-xs font-medium">{d.room_name}</TableCell>
                          <TableCell className="text-xs">{d.classification ?? '—'}</TableCell>
                          <TableCell className="text-xs">{d.leaf ?? '—'}</TableCell>
                          <TableCell className="font-mono text-xs text-right">{d.qty}</TableCell>
                        </TableRow>
                      ))}
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
                            <TableCell className="text-xs">{issue.message}</TableCell>
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
                  {Math.round(AUTO_MATCH_THRESHOLD * 100)}%) must be checked one by one: use
                  Confirm in the row, or pick a different set.
                </div>
              )}
            </div>
            <div className="flex items-center gap-2">
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

          <div className="max-h-96 overflow-y-auto border border-neutral-200">
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
                </TableRow>
              </TableHeader>
              <TableBody>
                {draftMatches.map((item) => {
                  const g = item.group
                  const topCandidates =
                    candidateMap.get(g.group_key)?.topCandidates ?? []
                  const topIds = new Set(topCandidates.map((c) => c.set.id))
                  const otherSets = standardSets.filter((s) => !topIds.has(s.id))

                  return (
                    <TableRow key={g.group_key}>
                      <TableCell className="font-mono text-xs">{g.position}</TableCell>
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
                                ? CUSTOM_SET_VALUE
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
                            <Input
                              aria-label={`Custom door group for ${g.room_name}`}
                              value={item.customGroupName}
                              onChange={(e) =>
                                updateCustomGroupName(g.group_key, e.target.value)
                              }
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
              <div className="text-xs text-neutral-600">
                {!isReimport
                  ? 'Creates version 1 (draft) with the matched hardware lines.'
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
                {isReimport && <div>Kept From v{baseVersion?.version_no}: {keptCount}</div>}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Footer Navigation */}
      <div className="flex items-center justify-between border-t border-neutral-200 pt-4">
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
            disabled={importMutation.isPending}
            onClick={() => importMutation.mutate()}
          >
            <span>
              {importMutation.isPending ? 'Saving...' : targetLabel}
            </span>
          </Button>
        )}
      </div>
    </div>
  )
}
