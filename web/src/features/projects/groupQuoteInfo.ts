/**
 * What the quotation said about a door group, saved with the upload
 * (quotation_group_info) so the Hardware grid can show it later: the doors,
 * their hardware (Builder HW columns, prep / install with each cell's value),
 * their comments, and the notes the import rules left (what they changed, and
 * hardware to consider).
 */
import type { CommentSource } from '@/features/projects/quotationDisplay'

export interface GroupQuoteInfo {
  /** Door refs of the group's doors, as in the quotation. */
  doors: string[]
  /** The group's hardware text ("Hinge: LO · Lock · Prep: Stop · Lock prep: 25"). */
  hardware: string
  /** HW column label -> its header in the quotation (see hardwareParts). */
  headers: Array<[string, string]>
  /** Prep / install item -> its cell value ("Lock prep" -> "25"). */
  prep_values: Record<string, string>
  /** Each door's comments (the popover shows each comment once). */
  comments: CommentSource[]
  /** The import rules' notes ("LOCK PREP 25: added L2 (vestibule lock)"). */
  notes: string[]
}

export function buildGroupQuoteInfo(
  group: { hardware: string; prep_values?: Record<string, string> },
  doors: Array<{ door_ref?: string | null } & CommentSource>,
  headers: Array<[string, string]>,
  notes: string[],
): GroupQuoteInfo {
  // Only the headers this group's hardware uses.
  const used = headers.filter(([label]) => group.hardware.split(' · ').some((t) => t === label || t.startsWith(`${label}: `)))
  const comments = doors
    .filter((d) => d.schedule_comments || d.mena_comments)
    .map((d) => ({
      schedule_comments: d.schedule_comments,
      mena_comments: d.mena_comments,
      comment_colors: d.comment_colors,
    }))
  return {
    doors: [...new Set(doors.map((d) => (d.door_ref ?? '').trim()).filter(Boolean))],
    hardware: group.hardware,
    headers: used,
    prep_values: group.prep_values ?? {},
    comments,
    notes,
  }
}

/** A saved row back to the type (older or partial rows get defaults). */
export function readGroupQuoteInfo(raw: unknown): GroupQuoteInfo | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Partial<GroupQuoteInfo>
  return {
    doors: Array.isArray(r.doors) ? r.doors : [],
    hardware: typeof r.hardware === 'string' ? r.hardware : '',
    headers: Array.isArray(r.headers) ? r.headers : [],
    prep_values: r.prep_values && typeof r.prep_values === 'object' ? r.prep_values : {},
    comments: Array.isArray(r.comments) ? r.comments : [],
    notes: Array.isArray(r.notes) ? r.notes : [],
  }
}

/**
 * A merged door group's details: every group it was made from, together
 * (each door once, every comment and note once). The hardware and its values
 * are the first group's, the one the merged group kept.
 */
export function combineGroupQuoteInfo(infos: GroupQuoteInfo[]): GroupQuoteInfo | null {
  if (infos.length === 0) return null
  if (infos.length === 1) return infos[0]
  const unique = <T,>(xs: T[], key: (x: T) => string) => {
    const seen = new Set<string>()
    return xs.filter((x) => {
      const k = key(x)
      if (seen.has(k)) return false
      seen.add(k)
      return true
    })
  }
  const [first] = infos
  return {
    doors: unique(infos.flatMap((i) => i.doors), (d) => d),
    hardware: first.hardware,
    headers: unique(infos.flatMap((i) => i.headers), ([label]) => label),
    prep_values: first.prep_values,
    comments: unique(infos.flatMap((i) => i.comments), (c) => JSON.stringify(c)),
    notes: unique(infos.flatMap((i) => i.notes), (n) => n),
  }
}
