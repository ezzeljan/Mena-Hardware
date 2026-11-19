import type { Project } from '@/types/database'

/** "SV002 — McLaren St" when there is a Reference No., otherwise just the name. */
export function projectDisplayName(project: Pick<Project, 'reference_no' | 'name'>): string {
  const ref = (project.reference_no ?? '').trim()
  return ref ? `${ref} — ${project.name}` : project.name
}
