/**
 * Lock rules: the quotation's LOCK PREP / LOCK INST costs say what lock a door
 * needs, and the standard set (only a template) is changed to match:
 *
 *   - 15: non-lockable. Mortice / rim locks, cylinders, cut keys and cylinder
 *     escutcheons come out; a passage latch goes in (a privacy latch and
 *     turnsnib for bathrooms, ensuites, WCs, or when the set had a turnsnib),
 *     with a passage set lever.
 *   - 25: mortice / lockable. Passage and privacy latches come out; a storeroom
 *     lock goes in (a vestibule lock for entries, or when the set had a
 *     turnsnib), with a cylinder, cylinder escutcheon and passage set lever.
 *   - Other values (30, 35, ...): not confirmed yet. The Lock / Latch columns
 *     decide (Lock -> lockable, Latch only -> non-lockable) and the lock lines
 *     are flagged; with neither, nothing changes and the lock is flagged.
 *
 * A door with LOCK PREP 15 but Lock = YES is changed to non-lockable and its
 * lock lines are flagged for the estimator.
 *
 * Runs after the activity rules and before the flag rules and sizing.
 */
import { toPartIndex, type PartIndex, type SizingPart } from './doorSizing'
import type { ActivityLine } from './activityRules'

export type LockKind =
  | 'lock'
  | 'rimlock'
  | 'cylinder'
  | 'key'
  | 'escutcheon'
  | 'latch'
  | 'privacyset'
  | 'turnsnib'
  | 'lever'

/** What kind of lock part a set line is (null for anything else). */
export function lockKindOf(description: string): LockKind | null {
  const d = description
  if (/cut\s*key/i.test(d)) return 'key'
  if (/cylinder\s*escutcheon/i.test(d)) return 'escutcheon'
  if (/night\s*latch/i.test(d)) return 'rimlock'
  if (/privacy\s*set/i.test(d)) return 'privacyset'
  if (/turn\s*snib|emergency\s*release/i.test(d)) return 'turnsnib'
  if (/\b(storeroom|vestibule|entrance|classroom|office|mortice|dead)\s*lock/i.test(d)) return 'lock'
  if (/cylinder/i.test(d) && !/cylinder\s*holes?/i.test(d)) return 'cylinder'
  if (/(passage|privacy)\s*latch/i.test(d)) return 'latch'
  if (/passage\s*set/i.test(d)) return 'lever'
  return null
}

export interface LockDoor {
  /** LOCK PREP / LOCK INST: "15", "25", "25/70" ('' when none). */
  lockCost: string
  /** The group's hardware ("Hinge: BH · Lock · Latch · Lock prep: 25"). */
  hardware: string
  room: string
}

export type LockNeed = 'lockable' | 'nonlockable'

const tokens = (hardware: string) => hardware.split(' · ')
const hasLockColumn = (hardware: string) => tokens(hardware).some((t) => t === 'Lock' || t.startsWith('Lock: '))
const hasLatchColumn = (hardware: string) => tokens(hardware).some((t) => t === 'Latch' || t.startsWith('Latch: '))
const isWetRoom = (room: string) => /bath|ensuite|en-suite|\bwc\b|toilet|shower|powder|\bpwd\b/i.test(room)

/** What the lock cost asks for; `sure` is false when it came from the Lock / Latch columns. */
export function lockNeedOf(door: LockDoor): { need: LockNeed | null; sure: boolean; prep: string } {
  const prep = door.lockCost.split('/')[0] ?? ''
  if (!prep) return { need: null, sure: true, prep }
  if (prep === '15') return { need: 'nonlockable', sure: true, prep }
  if (prep === '25') return { need: 'lockable', sure: true, prep }
  if (hasLockColumn(door.hardware)) return { need: 'lockable', sure: false, prep }
  if (hasLatchColumn(door.hardware)) return { need: 'nonlockable', sure: false, prep }
  return { need: null, sure: false, prep }
}

export interface LockResult<L> {
  lines: L[]
  notes: string[]
}

/** Parts to add, by legend, else by description. */
const PICKS: Record<string, RegExp> = {
  L1: /storeroom\s*lock/i,
  L2: /vestibule\s*lock/i,
  K1A: /oval\s*cylinder/i,
  F2: /cylinder\s*escutcheon/i,
  F7: /passage\s*set/i,
  L5: /passage\s*latch/i,
  L4: /privacy\s*latch/i,
  F3: /^(?!.*disabled).*turn\s*snib/i,
}

export function applyLockRules<L extends ActivityLine>(
  lines: L[],
  door: LockDoor,
  parts: SizingPart[] | PartIndex,
  makeLine: (part: SizingPart, qty: number) => L,
): LockResult<L> {
  const { need, sure, prep } = lockNeedOf(door)
  if (!prep) return { lines, notes: [] }
  const { byId, bySku, active } = toPartIndex(parts)
  const kind = (l: L): LockKind | null => {
    const p = (l.part_id ? byId.get(l.part_id) : undefined) ?? bySku.get(l.sku.trim().toUpperCase())
    return lockKindOf(`${l.description} ${p?.description ?? ''}`)
  }
  const has = (out: L[], ...kinds: LockKind[]) => out.some((l) => kinds.includes(kind(l) as LockKind))
  const label = `LOCK PREP ${door.lockCost}`
  const notes: string[] = []

  // Not confirmed what the value means and nothing else says: flag only.
  if (!need) {
    const flag = `${label}: meaning not confirmed yet — check the lock`
    notes.push(`${label}: meaning not confirmed and no Lock / Latch column says — lock lines flagged`)
    return {
      lines: lines.map((l) => (kind(l) ? { ...l, review_flag: flag } : l)),
      notes,
    }
  }

  const pick = (legend: string): SizingPart | undefined =>
    active.find((p) => p.legend.trim().toUpperCase() === legend) ?? active.find((p) => PICKS[legend].test(p.description))
  let out = [...lines]
  const added: L[] = []
  const add = (legend: string, why: string) => {
    const part = pick(legend)
    if (!part) {
      notes.push(`${label}: no ${legend} (${why}) in the parts library — not added`)
      return
    }
    const line = makeLine(part, 1)
    out.push(line)
    added.push(line)
    notes.push(`${label}: added ${part.legend || part.sku} (${why})`)
  }
  const remove = (kinds: LockKind[]) => {
    const gone = out.filter((l) => kinds.includes(kind(l) as LockKind))
    if (gone.length === 0) return
    out = out.filter((l) => !gone.includes(l))
    notes.push(`${label}: removed ${gone.map((l) => l.sku).join(', ')}`)
  }

  if (need === 'lockable') {
    if (has(out, 'lock', 'rimlock')) {
      // Already lockable: make sure a mortice lock has its cylinder and escutcheon.
      if (has(out, 'lock') && !has(out, 'cylinder')) add('K1A', 'cylinder')
      if (has(out, 'lock') && has(out, 'lever') && !has(out, 'escutcheon')) add('F2', 'cylinder escutcheon')
    } else {
      const entry = has(out, 'turnsnib', 'privacyset') || tokens(door.hardware).includes('Lock: ENT')
      remove(entry ? ['latch', 'privacyset'] : ['latch', 'privacyset', 'turnsnib'])
      add(entry ? 'L2' : 'L1', entry ? 'vestibule lock' : 'storeroom lock')
      if (!has(out, 'cylinder')) add('K1A', 'cylinder')
      if (!has(out, 'lever')) add('F7', 'passage set lever')
      if (!has(out, 'escutcheon')) add('F2', 'cylinder escutcheon')
    }
  } else {
    const privacy = isWetRoom(door.room) || has(out, 'turnsnib', 'privacyset')
    const wasLocked = has(out, 'lock', 'rimlock', 'cylinder', 'escutcheon', 'key')
    remove(['lock', 'rimlock', 'cylinder', 'escutcheon', 'key'])
    if (!has(out, 'latch', 'privacyset')) {
      if (!wasLocked) notes.push(`${label}: the set had no latch — check the added latch and lever`)
      add(privacy ? 'L4' : 'L5', privacy ? 'privacy latch' : 'passage latch')
      if (!has(out, 'lever')) add('F7', 'passage set lever')
      if (privacy && !has(out, 'turnsnib')) add('F3', 'turnsnib')
    }
  }

  // Flags: the value isn't confirmed, or the Lock column disagrees with 15.
  let flag = ''
  if (!sure) {
    flag = `${label}: meaning not confirmed yet — ${need === 'lockable' ? 'lockable (Lock column)' : 'non-lockable (Latch column)'}; check the lock`
  } else if (need === 'nonlockable' && hasLockColumn(door.hardware)) {
    flag = `${label} means non-lockable, but the Lock column says ${tokens(door.hardware).find((t) => t === 'Lock' || t.startsWith('Lock: '))?.replace(/^Lock(: )?/, '') || 'YES'} — check the lock`
  }
  if (flag) {
    out = out.map((l) => (kind(l) ? { ...l, review_flag: flag } : l))
    notes.push(flag)
  }
  return { lines: out, notes }
}
