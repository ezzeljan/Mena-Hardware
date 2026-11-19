import { supabase } from '@/lib/supabase'
import { fetchAllRows } from '@/lib/fetchAll'
import type { DoorGroup, ProjectLine } from '@/types/database'

export const DOOR_GROUP_COLUMNS =
  'id, version_id, position, group_key, door_tag, room_name, classification, leaf, door_size, door_qty, matched_set_id, match_status, match_score, match_reason, pm_remarks, created_at, updated_at'

export const PROJECT_LINE_COLUMNS =
  'id, group_id, position, sku, description, qty_per_door, unit_price, origin, part_id, mhqt_remarks, created_at, updated_at'

/** All door groups of a version, ordered by position (paginated past the 1000-row cap). */
export function fetchVersionGroups(versionId: string): Promise<DoorGroup[]> {
  return fetchAllRows<DoorGroup>((from, to) =>
    supabase
      .from('door_groups')
      .select(DOOR_GROUP_COLUMNS)
      .eq('version_id', versionId)
      .order('position', { ascending: true })
      .order('id', { ascending: true })
      .range(from, to),
  )
}

/**
 * All project lines of a version (paginated past the 1000-row cap).
 * Filters through the door_groups join instead of `.in('group_id', [...])`,
 * which put every group id in the URL and broke on large projects.
 */
export async function fetchVersionLines(versionId: string): Promise<ProjectLine[]> {
  const rows = await fetchAllRows<ProjectLine & { door_groups?: unknown }>(
    (from, to) =>
      supabase
        .from('project_lines')
        .select(`${PROJECT_LINE_COLUMNS}, door_groups!inner(version_id)`)
        .eq('door_groups.version_id', versionId)
        .order('position', { ascending: true })
        .order('id', { ascending: true })
        .range(from, to),
  )
  return rows.map((row) => {
    const line = { ...row }
    delete line.door_groups
    return line as ProjectLine
  })
}
