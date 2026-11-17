import { useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AlertTriangle,
  CheckCircle2,
  FileSpreadsheet,
  Upload,
  X,
} from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/features/auth/AuthContext'
import type { ProjectVersion, QuotationUpload } from '@/types/database'
import {
  parseQuotationWorkbook,
  type QuotationParseResult,
} from '@/features/projects/quotationParser'
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

interface QuotationUploadPanelProps {
  projectId: string
  activeDraftVersion: ProjectVersion | null
  canEdit: boolean
}

type PreviewTab = 'groups' | 'doors' | 'issues'

export function QuotationUploadPanel({
  projectId,
  activeDraftVersion,
  canEdit,
}: QuotationUploadPanelProps) {
  const { user } = useAuth()
  const queryClient = useQueryClient()
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  const [isDragging, setIsDragging] = useState(false)
  const [parsing, setParsing] = useState(false)
  const [parseError, setParseError] = useState<string | null>(null)
  const [saveSuccess, setSaveSuccess] = useState<string | null>(null)
  const [previewTab, setPreviewTab] = useState<PreviewTab>('groups')
  const [preview, setPreview] = useState<{
    file: File
    result: QuotationParseResult
  } | null>(null)

  const uploadsQuery = useQuery({
    queryKey: ['quotation_uploads', projectId],
    queryFn: async (): Promise<QuotationUpload[]> => {
      const { data, error } = await supabase
        .from('quotation_uploads')
        .select(
          'id, project_id, storage_path, original_filename, uploaded_by, parse_report, created_at',
        )
        .eq('project_id', projectId)
        .order('created_at', { ascending: false })
      if (error) throw error
      return (data ?? []) as QuotationUpload[]
    },
  })

  const handleFile = async (file: File | undefined) => {
    if (!file) return
    setParseError(null)
    setSaveSuccess(null)

    if (!file.name.toLowerCase().endsWith('.xlsx')) {
      setParseError('Only .xlsx quotation workbooks are supported.')
      return
    }

    setParsing(true)
    try {
      const buffer = await file.arrayBuffer()
      const result = await parseQuotationWorkbook(buffer)
      setPreview({ file, result })
      setPreviewTab('groups')
    } catch (err) {
      setParseError(
        err instanceof Error ? err.message : 'Failed to parse quotation workbook.',
      )
      setPreview(null)
    } finally {
      setParsing(false)
    }
  }

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (!preview || !activeDraftVersion || !user) {
        throw new Error('A draft project version and authenticated user are required.')
      }

      const { file, result } = preview
      const safeName = file.name.replace(/[^a-zA-Z0-9._-]+/g, '_')
      const storagePath = `${projectId}/${Date.now()}-${safeName}`

      // 1. Upload raw .xlsx to private quotations bucket
      const { error: storageError } = await supabase.storage
        .from('quotations')
        .upload(storagePath, file, {
          contentType:
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          upsert: false,
        })
      if (storageError) throw storageError

      // 2. Insert quotation_uploads record
      const { data: uploadRow, error: uploadError } = await supabase
        .from('quotation_uploads')
        .insert({
          project_id: projectId,
          storage_path: storagePath,
          original_filename: file.name,
          uploaded_by: user.id,
          parse_report: result.report,
        })
        .select('id')
        .single()
      if (uploadError) throw uploadError

      const uploadId = (uploadRow as { id: string }).id

      // 3. Batch insert quotation_doors
      const doorRows = result.doors.map((d) => ({
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
        const chunk = doorRows.slice(i, i + 200)
        const { error: doorsError } = await supabase
          .from('quotation_doors')
          .insert(chunk)
        if (doorsError) throw doorsError
      }

      // 4. Link upload_id to the active draft version
      const { error: versionError } = await supabase
        .from('project_versions')
        .update({ upload_id: uploadId })
        .eq('id', activeDraftVersion.id)
      if (versionError) throw versionError

      // 5. Replace door_groups for this draft version
      const { error: deleteGroupsError } = await supabase
        .from('door_groups')
        .delete()
        .eq('version_id', activeDraftVersion.id)
      if (deleteGroupsError) throw deleteGroupsError

      const groupRows = result.groups.map((g) => ({
        version_id: activeDraftVersion.id,
        position: g.position,
        group_key: g.group_key,
        room_name: g.room_name,
        classification: g.classification ?? '',
        leaf: g.leaf ?? '',
        door_size: g.door_size ?? '',
        door_qty: g.door_qty,
        match_status: 'unmatched' as const,
      }))

      for (let i = 0; i < groupRows.length; i += 200) {
        const chunk = groupRows.slice(i, i + 200)
        const { error: insertGroupsError } = await supabase
          .from('door_groups')
          .insert(chunk)
        if (insertGroupsError) throw insertGroupsError
      }

      return { uploadId, doorsCount: doorRows.length, groupsCount: groupRows.length }
    },
    onSuccess: async (info) => {
      setPreview(null)
      setParseError(null)
      setSaveSuccess(
        `Saved ${info.doorsCount} parsed door rows into ${info.groupsCount} door groups for v${activeDraftVersion?.version_no}.`,
      )
      await queryClient.invalidateQueries({ queryKey: ['project', projectId] })
      await queryClient.invalidateQueries({
        queryKey: ['quotation_uploads', projectId],
      })
      if (activeDraftVersion) {
        await queryClient.invalidateQueries({
          queryKey: ['door_groups', activeDraftVersion.id],
        })
      }
    },
    onError: (err: Error) => {
      setParseError(err.message)
    },
  })

  const uploads = uploadsQuery.data ?? []

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-neutral-700 flex items-center gap-2">
          <FileSpreadsheet className="h-4 w-4" />
          <span>Quotation Workbook Upload</span>
        </h2>
        {activeDraftVersion ? (
          <Badge variant="outline" className="font-mono text-[11px]">
            Target: v{activeDraftVersion.version_no} (DRAFT)
          </Badge>
        ) : (
          <Badge variant="outline" className="text-[11px] text-neutral-500">
            No active draft version
          </Badge>
        )}
      </div>

      {parseError && (
        <div
          role="alert"
          className="border border-neutral-950 bg-neutral-50 p-3 text-xs text-neutral-950 flex items-start gap-2"
        >
          <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
          <span>{parseError}</span>
        </div>
      )}

      {saveSuccess && (
        <div className="border border-neutral-950 bg-neutral-50 p-3 text-xs text-neutral-950 flex items-start gap-2">
          <CheckCircle2 className="h-4 w-4 shrink-0 mt-0.5" />
          <span>{saveSuccess}</span>
        </div>
      )}

      {/* Dropzone (only for admin/estimator when a draft version exists and no preview is open) */}
      {canEdit && activeDraftVersion && !preview && (
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
              : 'Drop a Mena quotation .xlsx file here, or click to browse'}
          </div>
          <p className="text-xs text-neutral-600 mt-1">
            Rows are parsed and previewed locally before anything is saved.
          </p>
          <div className="mt-4">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={parsing}
              onClick={() => fileInputRef.current?.click()}
            >
              Select .xlsx File
            </Button>
          </div>
        </div>
      )}

      {/* Client-side Parse Preview */}
      {preview && (
        <div className="border border-neutral-950 rounded-md p-4 space-y-4 bg-white">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-neutral-200 pb-3">
            <div>
              <div className="text-sm font-semibold text-neutral-950">
                Preview: {preview.file.name}
              </div>
              <div className="text-xs text-neutral-600 mt-0.5">
                Sheet: <span className="font-mono">{preview.result.sheetName}</span> •
                Header row: <span className="font-mono">{preview.result.headerRow}</span>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={saveMutation.isPending}
                onClick={() => setPreview(null)}
              >
                <X className="h-3.5 w-3.5" />
                <span>Discard</span>
              </Button>
              <Button
                type="button"
                size="sm"
                disabled={
                  saveMutation.isPending || preview.result.doors.length === 0
                }
                onClick={() => saveMutation.mutate()}
              >
                {saveMutation.isPending ? 'Saving...' : 'Confirm & Save Upload'}
              </Button>
            </div>
          </div>

          {/* Summary KPIs */}
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
            <div className="border border-neutral-200 p-2.5 rounded">
              <div className="text-[10px] uppercase tracking-wider text-neutral-500 font-semibold">
                Parsed Rows
              </div>
              <div className="text-lg font-bold font-mono text-neutral-950">
                {preview.result.doors.length}
              </div>
            </div>
            <div className="border border-neutral-200 p-2.5 rounded">
              <div className="text-[10px] uppercase tracking-wider text-neutral-500 font-semibold">
                Total Door Qty
              </div>
              <div className="text-lg font-bold font-mono text-neutral-950">
                {preview.result.totalDoorQty}
              </div>
            </div>
            <div className="border border-neutral-200 p-2.5 rounded">
              <div className="text-[10px] uppercase tracking-wider text-neutral-500 font-semibold">
                Door Groups
              </div>
              <div className="text-lg font-bold font-mono text-neutral-950">
                {preview.result.groups.length}
              </div>
            </div>
            <div className="border border-neutral-200 p-2.5 rounded">
              <div className="text-[10px] uppercase tracking-wider text-neutral-500 font-semibold">
                Excluded
              </div>
              <div className="text-lg font-bold font-mono text-neutral-950">
                {preview.result.excludedCount}
              </div>
            </div>
            <div className="border border-neutral-200 p-2.5 rounded">
              <div className="text-[10px] uppercase tracking-wider text-neutral-500 font-semibold">
                Issues
              </div>
              <div className="text-lg font-bold font-mono text-neutral-950">
                {preview.result.issues.length}
              </div>
            </div>
          </div>

          {/* Preview Tabs */}
          <div className="flex items-center gap-2 border-b border-neutral-200 pb-2">
            <Button
              type="button"
              variant={previewTab === 'groups' ? 'default' : 'outline'}
              size="sm"
              onClick={() => setPreviewTab('groups')}
            >
              Door Groups ({preview.result.groups.length})
            </Button>
            <Button
              type="button"
              variant={previewTab === 'doors' ? 'default' : 'outline'}
              size="sm"
              onClick={() => setPreviewTab('doors')}
            >
              Parsed Rows ({preview.result.doors.length})
            </Button>
            <Button
              type="button"
              variant={previewTab === 'issues' ? 'default' : 'outline'}
              size="sm"
              onClick={() => setPreviewTab('issues')}
            >
              Issues ({preview.result.issues.length})
            </Button>
          </div>

          <div className="max-h-80 overflow-y-auto border border-neutral-200">
            {previewTab === 'groups' && (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>#</TableHead>
                    <TableHead>Room Name</TableHead>
                    <TableHead>Classification</TableHead>
                    <TableHead>Leaf</TableHead>
                    <TableHead>Door Size</TableHead>
                    <TableHead className="text-right">Qty</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {preview.result.groups.map((g) => (
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
                    <TableHead>Size</TableHead>
                    <TableHead className="text-right">Qty</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {preview.result.doors.slice(0, 200).map((d) => (
                    <TableRow key={`${d.source_row}-${d.door_ref}`}>
                      <TableCell className="font-mono text-xs">{d.source_row}</TableCell>
                      <TableCell className="text-xs">{d.door_ref}</TableCell>
                      <TableCell className="text-xs font-medium">{d.room_name}</TableCell>
                      <TableCell className="text-xs">{d.classification ?? '—'}</TableCell>
                      <TableCell className="text-xs">{d.leaf ?? '—'}</TableCell>
                      <TableCell className="font-mono text-xs">{d.door_size ?? '—'}</TableCell>
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
                  {preview.result.issues.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={4} className="text-center text-xs text-neutral-500 py-6">
                        No issues detected.
                      </TableCell>
                    </TableRow>
                  ) : (
                    preview.result.issues.map((issue, idx) => (
                      <TableRow key={`${issue.row}-${idx}`}>
                        <TableCell className="font-mono text-xs">{issue.row}</TableCell>
                        <TableCell>
                          <Badge
                            variant={issue.severity === 'error' ? 'default' : 'outline'}
                            className="uppercase text-[10px]"
                          >
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

      {/* Upload History */}
      {uploads.length > 0 && (
        <div className="space-y-2">
          <div className="text-xs font-semibold uppercase tracking-wider text-neutral-500">
            Uploaded Quotations ({uploads.length})
          </div>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Filename</TableHead>
                <TableHead>Sheet</TableHead>
                <TableHead className="text-right">Doors</TableHead>
                <TableHead className="text-right">Groups</TableHead>
                <TableHead>Uploaded</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {uploads.map((u) => {
                const rep = u.parse_report as Record<string, unknown>
                return (
                  <TableRow key={u.id}>
                    <TableCell className="text-xs font-medium">
                      {u.original_filename}
                    </TableCell>
                    <TableCell className="font-mono text-xs text-neutral-600">
                      {typeof rep.sheetName === 'string' ? rep.sheetName : '—'}
                    </TableCell>
                    <TableCell className="font-mono text-xs text-right">
                      {typeof rep.totalDoorQty === 'number' ? rep.totalDoorQty : '—'}
                    </TableCell>
                    <TableCell className="font-mono text-xs text-right">
                      {typeof rep.doorGroupsCount === 'number'
                        ? rep.doorGroupsCount
                        : '—'}
                    </TableCell>
                    <TableCell className="text-xs text-neutral-600">
                      {new Date(u.created_at).toLocaleString()}
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  )
}
