import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { ArrowLeft } from 'lucide-react'
import { projectDisplayName } from '@/lib/projectName'
import { QuotationImportWizard } from '@/features/projects/QuotationImportWizard'
import { canReviseFrom } from '@/features/projects/versionActions'
import { useProjectDetail } from '@/features/projects/useProjectDetail'
import { useSupplierOptions } from '@/features/projects/useSuppliers'
import { Button } from '@/components/ui/button'

/**
 * The quotation import wizard on its own page.
 *   New quote:  /projects/:id/import?builder=<name>&supplier=<supplier id>
 *   Re-import:  /projects/:id/import?quote=<quote id>
 * Cancel goes back to where the import started (overview / the quote).
 */
export function ImportQuotationPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const { projectQuery, project, quotes, canEditContent, canAddQuote } = useProjectDetail(id)

  const quoteId = searchParams.get('quote')
  const builderName = (searchParams.get('builder') ?? '').trim()
  const supplierId = searchParams.get('supplier') ?? ''
  const isReimport = !!quoteId
  const suppliersQuery = useSupplierOptions(!isReimport && !!supplierId)

  const backTo = isReimport ? `/projects/${id}/hardware?quote=${quoteId}` : `/projects/${id}`
  const backLabel = isReimport ? 'Back to the quote' : 'Project overview'

  const shell = (body: React.ReactNode) => (
    <div className="space-y-4">
      <Button variant="outline" size="sm" asChild>
        <Link to={backTo}>
          <ArrowLeft className="h-3.5 w-3.5" />
          <span>{backLabel}</span>
        </Link>
      </Button>
      {body}
    </div>
  )

  const notice = (text: string) =>
    shell(
      <div role="alert" className="border border-neutral-950 bg-neutral-50 p-6 text-sm text-neutral-950">
        {text}
      </div>,
    )

  if (projectQuery.isLoading || (!isReimport && suppliersQuery.isLoading)) {
    return (
      <div className="border border-neutral-200 p-10 text-center text-sm text-neutral-600">Loading...</div>
    )
  }
  if (projectQuery.isError || !project) return notice('Project not found or failed to load.')
  if (!canEditContent) return notice('Only an estimator assigned to this project (or an admin) can import a quotation.')

  const projectName = projectDisplayName(project)
  const done = (versionId: string) => navigate(`/projects/${project.id}/hardware?version=${versionId}`)

  if (isReimport) {
    const quote = quotes.find((q) => q.id === quoteId)
    if (!quote || quote.needsQuotation) return notice('This quote was not found, or its quotation was never imported.')
    if (quote.locked) return notice('The project was awarded to another quote, so this quote is read-only.')
    const base = quote.draftVersion ?? quote.versions[0] ?? null
    const reimportable =
      !!base &&
      !quote.versions.some((v) => v.status === 'submitted') &&
      (base.status === 'draft' || canReviseFrom(base.status))
    if (!reimportable || !base) {
      return notice('A version of this quote is waiting for PM review. Re-import after it is approved or changes are requested.')
    }
    return shell(
      <QuotationImportWizard
        mode="reimport"
        projectId={project.id}
        projectName={`${projectName} — ${quote.builder_name}`}
        quoteId={quote.id}
        baseVersion={base}
        nextVersionNo={Math.max(0, ...quote.versions.map((v) => v.version_no)) + 1}
        onCancel={() => navigate(backTo)}
        onDone={done}
      />,
    )
  }

  const supplier = suppliersQuery.data?.find((s) => s.id === supplierId)
  if (!canAddQuote) return notice('The project is awarded, so no new builder quotes can be added.')
  if (!builderName || !supplier) return notice('Start a new quote from the project overview (New Quote).')
  if (quotes.some((q) => q.builder_name.trim().toLowerCase() === builderName.toLowerCase())) {
    return notice(`This project already has a quote for "${builderName}". Open it and use Re-import Quotation instead.`)
  }
  return shell(
    <QuotationImportWizard
      projectId={project.id}
      projectName={projectName}
      builderName={builderName}
      supplier={{ id: supplier.id, name: supplier.name }}
      onCancel={() => navigate(backTo)}
      onDone={done}
    />,
  )
}
