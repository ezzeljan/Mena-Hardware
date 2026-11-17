import { supabase } from '@/lib/supabase'
import type { DoorGroup, ProjectLine, ProjectVersion } from '@/types/database'

export async function createNewDraftRevision(
  projectId: string,
  sourceVersion: ProjectVersion,
  nextVersionNo: number,
  userId: string,
): Promise<string> {
  // 1. Insert new draft version
  const { data: newVersion, error: verErr } = await supabase
    .from('project_versions')
    .insert({
      project_id: projectId,
      version_no: nextVersionNo,
      status: 'draft',
      upload_id: sourceVersion.upload_id,
      markup_pct: sourceVersion.markup_pct,
      created_by: userId,
    })
    .select('id')
    .single()
  if (verErr) throw verErr

  const newVersionId = (newVersion as { id: string }).id

  // 2. Fetch source door_groups
  const { data: srcGroups, error: grpFetchErr } = await supabase
    .from('door_groups')
    .select(
      'id, version_id, position, group_key, room_name, classification, leaf, door_size, door_qty, matched_set_id, match_status, match_score, match_reason, pm_remarks',
    )
    .eq('version_id', sourceVersion.id)
    .order('position', { ascending: true })
  if (grpFetchErr) throw grpFetchErr

  const groups = (srcGroups ?? []) as DoorGroup[]
  if (groups.length > 0) {
    const groupInsertRows = groups.map((g) => ({
      version_id: newVersionId,
      position: g.position,
      group_key: g.group_key,
      room_name: g.room_name,
      classification: g.classification,
      leaf: g.leaf,
      door_size: g.door_size,
      door_qty: g.door_qty,
      matched_set_id: g.matched_set_id,
      match_status: g.match_status,
      match_score: g.match_score,
      match_reason: g.match_reason,
      pm_remarks: g.pm_remarks,
    }))

    const { data: insertedGroups, error: grpInsErr } = await supabase
      .from('door_groups')
      .insert(groupInsertRows)
      .select('id, group_key')
    if (grpInsErr) throw grpInsErr

    const newGroupIdByKey = new Map<string, string>()
    for (const ig of (insertedGroups ?? []) as Array<{
      id: string
      group_key: string
    }>) {
      newGroupIdByKey.set(ig.group_key, ig.id)
    }

    const oldGroupIds = groups.map((g) => g.id)
    const oldGroupKeyById = new Map(groups.map((g) => [g.id, g.group_key]))

    // 3. Fetch source project_lines and clone into new groups
    const { data: srcLines, error: lineFetchErr } = await supabase
      .from('project_lines')
      .select(
        'group_id, position, sku, description, qty_per_door, unit_price, origin, part_id',
      )
      .in('group_id', oldGroupIds)
      .order('position', { ascending: true })
    if (lineFetchErr) throw lineFetchErr

    const clonedLines: Array<{
      group_id: string
      position: number
      sku: string
      description: string
      qty_per_door: number
      unit_price: number | null
      origin: 'set' | 'added' | 'edited'
      part_id: string | null
    }> = []

    for (const l of (srcLines ?? []) as ProjectLine[]) {
      const key = oldGroupKeyById.get(l.group_id)
      const targetGroupId = key ? newGroupIdByKey.get(key) : undefined
      if (!targetGroupId) continue
      clonedLines.push({
        group_id: targetGroupId,
        position: l.position,
        sku: l.sku,
        description: l.description,
        qty_per_door: l.qty_per_door,
        unit_price: l.unit_price,
        origin: l.origin,
        part_id: l.part_id,
      })
    }

    for (let i = 0; i < clonedLines.length; i += 200) {
      const { error: lineInsErr } = await supabase
        .from('project_lines')
        .insert(clonedLines.slice(i, i + 200))
      if (lineInsErr) throw lineInsErr
    }
  }

  // 4. Mark approved/changes_requested source version as superseded
  if (
    sourceVersion.status === 'approved' ||
    sourceVersion.status === 'changes_requested'
  ) {
    const { error: supErr } = await supabase
      .from('project_versions')
      .update({ status: 'superseded' })
      .eq('id', sourceVersion.id)
    if (supErr) throw supErr
  }

  return newVersionId
}
