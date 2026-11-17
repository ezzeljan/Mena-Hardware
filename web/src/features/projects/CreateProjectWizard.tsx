import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
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
import { useAuth } from '@/features/auth/AuthContext'
import type {
  Part,
  Profile,
  ProjectStatus,
  StandardSet,
  StandardSetLine,
} from '@/types/database'
import {
  parseQuotationWorkbook,
  type ParsedDoorGroupPreview,
  type QuotationParseResult,
} from '@/features/projects/quotationParser'
import {
  matchDoorGroup,
  type GroupMatchResult,
} from '@/features/projects/doorMatcher'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Stepper, type StepperStep } from '@/components/ui/stepper'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'

interface CreateProjectWizardProps {
  pmProfiles: Pick<Profile, 'id' | 'full_name' | 'email' | 'role'>[]
  onCancel: () => void
}

const CUSTOM_SET_VALUE = '__CUSTOM__'

interface DraftGroupMatch {
  group: ParsedDoorGroupPreview
  matchedSetId: string | null
  matchStatus: 'auto' | 'confirmed' | 'manual' | 'unmatched'
  matchScore: number | null
  matchReason: string
  customGroupName: string
}

const WIZARD_STEPS: StepperStep[] = [
  { id: 'details', title: 'Project Details', description: 'Ref no., name & builder' },
  { id: 'upload', title: 'Upload Quotation', description: 'Parse .xlsx schedule' },
  { id: 'matching', title: 'Matching Review', description: 'Door-to-set mapping' },
  { id: 'summary', title: 'Summary', description: 'Review & create' },
]

export function CreateProjectWizard({
  pmProfiles,
  onCancel,
}: CreateProjectWizardProps) {
  const { user, isAdmin } = useAuth()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  const [step, setStep] = useState(0)
  const [stepError, setStepError] = useState<string | null>(null)

  // Step 1: Project details
  const [projectCode, setProjectCode] = useState('')
  const [projectName, setProjectName] = useState('')
  const [client, setClient] = useState('')
  const [site, setSite] = useState('')
  const [status, setStatus] = useState<ProjectStatus>('active')
  const [assignedPm, setAssignedPm] = useState('')

  // Step 2: Upload & parse
  const [isDragging, setIsDragging] = useState(false)
  const [parsing, setParsing] = useState(false)
  const [previewTab, setPreviewTab] = useState<'groups' | 'doors' | 'issues'>('groups')
  const [uploadedFile, setUploadedFile] = useState<File | null>(null)
  const [parseResult, setParseResult] = useState<QuotationParseResult | null>(null)

  // Step 3: Matching state
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
    queryFn: async (): Promise<Pick<Part, 'id' | 'sku'>[]> => {
      const { data, error } = await supabase.from('parts').select('id, sku')
      if (error) throw error
      return (data ?? []) as Pick<Part, 'id' | 'sku'>[]
    },
  })

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
        if (standardSets.length === 0) {
          return {
            group: g,
            matchedSetId: null,
            matchStatus: 'unmatched',
            matchScore: null,
            matchReason: '',
            customGroupName: '',
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
        }
      })
      setDraftMatches(next)
    },
    [standardSets],
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
    if (!file.name.toLowerCase().endsWith('.xlsx')) {
      setStepError('Only .xlsx quotation workbooks are supported.')
      return
    }
    setParsing(true)
    try {
      const buffer = await file.arrayBuffer()
      const result = await parseQuotationWorkbook(buffer)
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
        item.matchStatus === 'auto' && item.matchedSetId
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
  const unmatchedCount = draftMatches.filter((m) => m.matchStatus === 'unmatched').length

  const formattedProjectName = projectCode.trim()
    ? projectName.trim().toUpperCase().startsWith(projectCode.trim().toUpperCase())
      ? projectName.trim()
      : `${projectCode.trim()} — ${projectName.trim()}`
    : projectName.trim()

  const createProjectMutation = useMutation({
    mutationFn: async (): Promise<string> => {
      if (!user) throw new Error('Must be signed in to create a project.')
      if (!uploadedFile || !parseResult) {
        throw new Error('Quotation workbook is required.')
      }
      if (unmatchedCount > 0 || blankCustomCount > 0) {
        throw new Error('All door groups must be matched or have a custom door group name.')
      }

      // 1. Insert project
      const { data: createdProject, error: projectErr } = await supabase
        .from('projects')
        .insert({
          name: formattedProjectName,
          client: client.trim(),
          site: site.trim(),
          status,
          created_by: user.id,
          assigned_pm: assignedPm === '' ? null : assignedPm,
        })
        .select('id')
        .single()
      if (projectErr) throw projectErr

      const projectId = (createdProject as { id: string }).id

      // 2. Insert v1 draft version
      const { data: createdVersion, error: versionErr } = await supabase
        .from('project_versions')
        .insert({
          project_id: projectId,
          version_no: 1,
          status: 'draft',
          created_by: user.id,
        })
        .select('id')
        .single()
      if (versionErr) throw versionErr

      const versionId = (createdVersion as { id: string }).id

      // 3. Upload .xlsx to Storage
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

      // 4. Insert quotation_uploads
      const reportWithCode = {
        ...parseResult.report,
        projectCode: projectCode.trim() || null,
      }
      const { data: uploadRow, error: uploadErr } = await supabase
        .from('quotation_uploads')
        .insert({
          project_id: projectId,
          storage_path: storagePath,
          original_filename: uploadedFile.name,
          uploaded_by: user.id,
          parse_report: reportWithCode,
        })
        .select('id')
        .single()
      if (uploadErr) throw uploadErr

      const uploadId = (uploadRow as { id: string }).id

      // 5. Batch insert quotation_doors
      const doorRows = parseResult.doors.map((d) => ({
        upload_id: uploadId,
        door_ref: d.door_ref,
        room_name: d.room_name,
        classification: d.classification ?? '',
        leaf: d.leaf ?? '',
        door_size: d.door_size ?? '',
        qty: d.qty,
        source_row: d.source_row,
      }))
      for (let i = 0; i < doorRows.length; i += 200) {
        const { error: doorsErr } = await supabase
          .from('quotation_doors')
          .insert(doorRows.slice(i, i + 200))
        if (doorsErr) throw doorsErr
      }

      // 6. Link upload_id on v1
      const { error: linkErr } = await supabase
        .from('project_versions')
        .update({ upload_id: uploadId })
        .eq('id', versionId)
      if (linkErr) throw linkErr

      // 7. Insert door_groups with match results
      const groupRows = draftMatches.map((m) => ({
        version_id: versionId,
        position: m.group.position,
        group_key: m.group.group_key,
        room_name: m.group.room_name,
        classification: m.group.classification ?? '',
        leaf: m.group.leaf ?? '',
        door_size: m.group.door_size ?? '',
        door_qty: m.group.door_qty,
        matched_set_id: m.matchedSetId,
        match_status: m.matchStatus,
        match_score: m.matchScore,
        match_reason: m.matchReason,
      }))

      const { data: insertedGroups, error: groupsErr } = await supabase
        .from('door_groups')
        .insert(groupRows)
        .select('id, group_key, matched_set_id')
      if (groupsErr) throw groupsErr

      // 8. Copy standard_set_lines into project_lines for all matched groups
      const lineRows: Array<{
        group_id: string
        position: number
        sku: string
        description: string
        qty_per_door: number
        unit_price: number | null
        origin: 'set'
        part_id: string | null
      }> = []

      for (const ig of (insertedGroups ?? []) as Array<{
        id: string
        group_key: string
        matched_set_id: string | null
      }>) {
        if (!ig.matched_set_id) continue
        const set = setById.get(ig.matched_set_id)
        if (!set) continue
        const setLines = [...(set.standard_set_lines ?? [])].sort(
          (a: StandardSetLine, b: StandardSetLine) => a.position - b.position,
        )
        setLines.forEach((line, idx) => {
          lineRows.push({
            group_id: ig.id,
            position: idx + 1,
            sku: line.sku,
            description: line.description,
            qty_per_door: line.qty,
            unit_price: line.unit_price,
            origin: 'set',
            part_id: partBySku.get(line.sku.trim().toUpperCase()) ?? null,
          })
        })
      }

      for (let i = 0; i < lineRows.length; i += 200) {
        const { error: linesErr } = await supabase
          .from('project_lines')
          .insert(lineRows.slice(i, i + 200))
        if (linesErr) throw linesErr
      }

      return projectId
    },
    onSuccess: async (projectId) => {
      await queryClient.invalidateQueries({ queryKey: ['projects'] })
      navigate(`/projects/${projectId}`)
    },
    onError: (err: Error) => {
      setStepError(err.message)
    },
  })

  const handleNext = () => {
    setStepError(null)
    if (step === 0) {
      if (!projectName.trim()) {
        setStepError('Project Name is required.')
        return
      }
      setStep(1)
      return
    }
    if (step === 1) {
      if (!uploadedFile || !parseResult || parseResult.doors.length === 0) {
        setStepError('Please upload and parse a valid quotation .xlsx workbook.')
        return
      }
      if (draftMatches.length === 0) {
        initializeMatchesFromParse(parseResult)
      }
      setStep(2)
      return
    }
    if (step === 2) {
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
      setStep(3)
    }
  }

  const assignedPmProfile = pmProfiles.find((p) => p.id === assignedPm)
  const totalCopiedLines = draftMatches.reduce((sum, m) => {
    if (!m.matchedSetId) return sum
    return sum + (setById.get(m.matchedSetId)?.standard_set_lines?.length ?? 0)
  }, 0)

  return (
    <div className="border border-neutral-950 rounded-md bg-white p-6 space-y-6">
      <div className="flex items-center justify-between border-b border-neutral-200 pb-4">
        <div>
          <h2 className="text-lg font-bold tracking-tight text-neutral-950">
            New Project Setup
          </h2>
          <p className="text-xs text-neutral-600 mt-0.5">
            Complete all 4 steps to create the project with its parsed door schedule and hardware matches.
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={createProjectMutation.isPending}
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
          if (!createProjectMutation.isPending && idx < step) {
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

      {/* STEP 1: Project Details */}
      {step === 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-2">
          <div className="space-y-1.5">
            <Label htmlFor="wiz-code">Reference No.</Label>
            <Input
              id="wiz-code"
              value={projectCode}
              onChange={(e) => setProjectCode(e.target.value)}
              placeholder="e.g. SV002"
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="wiz-name">Project Name *</Label>
            <Input
              id="wiz-name"
              value={projectName}
              onChange={(e) => setProjectName(e.target.value)}
              placeholder="e.g. McLaren St North Sydney"
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="wiz-client">Builder</Label>
            <Input
              id="wiz-client"
              value={client}
              onChange={(e) => setClient(e.target.value)}
              placeholder="e.g. DECODE"
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="wiz-site">Site</Label>
            <Input
              id="wiz-site"
              value={site}
              onChange={(e) => setSite(e.target.value)}
              placeholder="e.g. North Sydney"
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="wiz-status">Status</Label>
            <select
              id="wiz-status"
              value={status}
              onChange={(e) => setStatus(e.target.value as ProjectStatus)}
              className="flex h-9 w-full border border-neutral-300 bg-white px-3 py-1 text-sm text-neutral-950 focus:outline-none focus:ring-1 focus:ring-neutral-950"
            >
              <option value="active">Active</option>
              <option value="archived">Archived</option>
            </select>
          </div>

          {isAdmin && (
            <div className="space-y-1.5">
              <Label htmlFor="wiz-pm">Assigned PM</Label>
              <select
                id="wiz-pm"
                value={assignedPm}
                onChange={(e) => setAssignedPm(e.target.value)}
                className="flex h-9 w-full border border-neutral-300 bg-white px-3 py-1 text-sm text-neutral-950 focus:outline-none focus:ring-1 focus:ring-neutral-950"
              >
                <option value="">Unassigned</option>
                {pmProfiles.map((pm) => (
                  <option key={pm.id} value={pm.id}>
                    {pm.full_name || pm.email} ({pm.role.toUpperCase()})
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>
      )}

      {/* STEP 2: Upload Quotation */}
      {step === 1 && (
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
              Parsed locally for review — nothing is saved until Step 4.
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

      {/* STEP 3: Door-to-Set Matching Review */}
      {step === 2 && (
        <div className="space-y-4 pt-2">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div className="text-xs text-neutral-600">
              Match all door groups to Standard Sets before proceeding to Summary.
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
                disabled={autoCount === 0}
                onClick={confirmAllAuto}
              >
                <CheckCheck className="h-3.5 w-3.5" />
                <span>Confirm Auto Matches ({autoCount})</span>
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
                        <span>{item.matchReason || '—'}</span>
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </div>
        </div>
      )}

      {/* STEP 4: Summary & Create */}
      {step === 3 && parseResult && uploadedFile && (
        <div className="space-y-4 pt-2">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="border border-neutral-200 rounded p-4 space-y-2">
              <div className="text-[11px] font-semibold uppercase tracking-wider text-neutral-500">
                1. Project Details
              </div>
              <div className="text-sm font-bold text-neutral-950">
                {formattedProjectName}
              </div>
              <div className="text-xs text-neutral-600 space-y-1">
                <div>Reference No.: {projectCode.trim() || '—'}</div>
                <div>Builder: {client.trim() || '—'}</div>
                <div>Site: {site.trim() || '—'}</div>
                <div>Status: {status.toUpperCase()}</div>
                <div>
                  Assigned PM:{' '}
                  {assignedPmProfile
                    ? assignedPmProfile.full_name || assignedPmProfile.email
                    : 'Unassigned'}
                </div>
              </div>
            </div>

            <div className="border border-neutral-200 rounded p-4 space-y-2">
              <div className="text-[11px] font-semibold uppercase tracking-wider text-neutral-500 flex items-center gap-1.5">
                <FileSpreadsheet className="h-3.5 w-3.5" />
                <span>2. Quotation File</span>
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
                <span>3. Matching Review</span>
              </div>
              <div className="text-xs text-neutral-600 space-y-1 font-mono">
                <div>Total Door Groups: {draftMatches.length}</div>
                <div>Matched to Standard Set: {matchedCount}</div>
                <div>Custom Door Groups: {customCount}</div>
                <div>Hardware Lines to Copy: {totalCopiedLines}</div>
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
          disabled={step === 0 || createProjectMutation.isPending}
          onClick={() => {
            setStepError(null)
            setStep((s) => Math.max(0, s - 1))
          }}
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          <span>Back</span>
        </Button>

        {step < 3 ? (
          <Button
            type="button"
            size="sm"
            disabled={
              parsing ||
              (step === 2 &&
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
            disabled={createProjectMutation.isPending}
            onClick={() => createProjectMutation.mutate()}
          >
            <span>
              {createProjectMutation.isPending ? 'Creating Project...' : 'Create Project'}
            </span>
          </Button>
        )}
      </div>
    </div>
  )
}
