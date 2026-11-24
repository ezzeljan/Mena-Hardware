import type { Project } from '@/types/database'

/** "SV002 — McLaren St" when there is a Reference No., otherwise just the name. */
export function projectDisplayName(project: Pick<Project, 'reference_no' | 'name'>): string {
  const ref = (project.reference_no ?? '').trim()
  return ref ? `${ref} — ${project.name}` : project.name
}

/**
 * The project's builder: the awarded quote's builder once the project is
 * awarded, else the optional Builder entered on the project ('' during tender
 * when none was entered: the quotes are from competing builders).
 */
export function projectBuilder(
  project: Pick<Project, 'client'> & {
    stage?: Project['stage']
    awarded_quote_id?: string | null
    hardware_quotes?: { id: string; builder_name: string }[]
  },
): string {
  if (project.stage === 'awarded' && project.awarded_quote_id) {
    const won = project.hardware_quotes?.find((q) => q.id === project.awarded_quote_id)
    if (won?.builder_name.trim()) return won.builder_name.trim()
  }
  return (project.client ?? '').trim()
}
