/**
 * Door-by-door changes between two uploads of a quotation: doors added,
 * removed, and changed (same door, other size / rating / leaf). A door is
 * known by its reference (level · apt · door type) and room; rows of the same
 * door are added up, so a QTY going from 2 to 3 is one door added.
 */

export interface DoorRecord {
  door_ref: string
  room_name: string
  classification: string | null
  leaf: string | null
  door_size: string | null
  qty: number
  source_row: number
  /** On a green (variation) row. */
  variation?: boolean
}

export interface DoorChange {
  door_ref: string
  room_name: string
  classification: string
  leaf: string
  door_size: string
  qty: number
  /** Row in the file it's from (the new file for added / changed, the old one for removed). */
  row: number
  variation: boolean
}

export interface DoorChanges {
  added: DoorChange[]
  removed: DoorChange[]
  /** Same door with another size, rating or leaf. */
  changed: Array<{ before: DoorChange; after: DoorChange }>
  previousTotal: number
  currentTotal: number
  unchangedQty: number
}

const norm = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim().toUpperCase()
const doorKey = (d: DoorRecord) => `${norm(d.door_ref)}|${norm(d.room_name)}`
const specKey = (d: DoorRecord) => `${norm(d.classification)}|${norm(d.leaf)}|${norm(d.door_size)}`

const toChange = (d: DoorRecord, qty: number): DoorChange => ({
  door_ref: d.door_ref,
  room_name: d.room_name,
  classification: d.classification ?? '',
  leaf: d.leaf ?? '',
  door_size: d.door_size ?? '',
  qty,
  row: d.source_row,
  variation: Boolean(d.variation),
})

export function compareDoors(previous: DoorRecord[], current: DoorRecord[]): DoorChanges {
  const byDoor = (doors: DoorRecord[]) => {
    const m = new Map<string, Map<string, { d: DoorRecord; qty: number }>>()
    for (const d of doors) {
      const specs = m.get(doorKey(d)) ?? new Map()
      m.set(doorKey(d), specs)
      const e = specs.get(specKey(d))
      if (e) {
        e.qty += Number(d.qty)
        if (d.variation) e.d = { ...e.d, variation: true }
      } else specs.set(specKey(d), { d, qty: Number(d.qty) })
    }
    return m
  }
  const prev = byDoor(previous)
  const cur = byDoor(current)
  const out: DoorChanges = {
    added: [],
    removed: [],
    changed: [],
    previousTotal: previous.reduce((n, d) => n + Number(d.qty), 0),
    currentTotal: current.reduce((n, d) => n + Number(d.qty), 0),
    unchangedQty: 0,
  }

  for (const key of new Set([...prev.keys(), ...cur.keys()])) {
    const before = [...(prev.get(key)?.entries() ?? [])].map(([spec, e]) => ({ spec, ...e }))
    const after = [...(cur.get(key)?.entries() ?? [])].map(([spec, e]) => ({ spec, ...e }))
    // The same spec in both: the difference in qty is added or removed.
    for (const a of after) {
      const b = before.find((x) => x.spec === a.spec)
      if (!b) continue
      const same = Math.min(a.qty, b.qty)
      out.unchangedQty += same
      a.qty -= same
      b.qty -= same
    }
    const leftBefore = before.filter((x) => x.qty > 0)
    const leftAfter = after.filter((x) => x.qty > 0)
    // Left on both sides: the door changed (size, rating or leaf). Without a
    // door ref the doors in a room can't be told apart, so they're added and
    // removed instead.
    const known = !key.startsWith('|')
    while (known && leftBefore.length && leftAfter.length) {
      const b = leftBefore[0]
      const a = leftAfter[0]
      const n = Math.min(a.qty, b.qty)
      out.changed.push({ before: toChange(b.d, n), after: toChange(a.d, n) })
      a.qty -= n
      b.qty -= n
      if (b.qty === 0) leftBefore.shift()
      if (a.qty === 0) leftAfter.shift()
    }
    for (const a of leftAfter) out.added.push(toChange(a.d, a.qty))
    for (const b of leftBefore) out.removed.push(toChange(b.d, b.qty))
  }
  const byRow = (x: DoorChange, y: DoorChange) => x.row - y.row
  out.added.sort(byRow)
  out.removed.sort(byRow)
  out.changed.sort((x, y) => x.after.row - y.after.row)
  return out
}

/** Doors added / removed / changed, counted by qty. */
export function changeCounts(c: DoorChanges) {
  const sum = (xs: DoorChange[]) => xs.reduce((n, x) => n + x.qty, 0)
  return {
    added: sum(c.added),
    addedInVariation: sum(c.added.filter((x) => x.variation)),
    removed: sum(c.removed),
    changed: c.changed.reduce((n, x) => n + x.after.qty, 0),
  }
}
