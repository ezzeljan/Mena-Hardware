/**
 * Door group keys: "tag | room | classification | leaf | size | hardware".
 *
 * A door group is one typical door: the same door type, rating, leaf, size and
 * hardware. Doors of one door type in different rooms are merged (the room
 * part of the key is "*" and the group's room name lists the rooms); doors
 * without a door type are grouped per room. Doors whose hardware differs get
 * their own group.
 *
 * Groups saved earlier have the room in the key, and the oldest have no
 * hardware part. A re-import or version comparison still finds them: same
 * door type, rating, leaf and size, and the same hardware when the old key
 * has it.
 */

const SEP = ' | '

/** Room part of the key for groups merged across rooms. */
export const ANY_ROOM = '*'

export interface GroupKeyParts {
  tag: string
  room: string
  classification: string
  leaf: string
  size: string
  hardware: string
  /** Saved before hardware was part of the key (five parts). */
  noHardware: boolean
}

export function parseGroupKey(key: string): GroupKeyParts {
  const p = key.split(SEP)
  return {
    tag: p[0] ?? '',
    room: p[1] ?? '',
    classification: p[2] ?? '',
    leaf: p[3] ?? '',
    size: p[4] ?? '',
    hardware: p.slice(5).join(SEP),
    noHardware: p.length <= 5,
  }
}

const NO_TAG = '—'

export function makeGroupKey(d: {
  tag: string
  room: string
  classification: string | null
  leaf: string | null
  size: string | null
  hardware: string
}): string {
  const tag = d.tag || NO_TAG
  return [
    tag,
    // One door type in several rooms is one group; without a door type, per room.
    tag === NO_TAG ? d.room.replace(/\s+/g, ' ').trim().toUpperCase() : ANY_ROOM,
    d.classification ?? 'UNKNOWN',
    d.leaf ?? 'UNKNOWN',
    d.size ?? 'UNKNOWN',
    ...(d.hardware ? [d.hardware] : []),
  ].join(SEP)
}

/** The hardware part of a key ('' for older keys and doors with no hardware). */
export function groupKeyHardware(key: string): string {
  return parseGroupKey(key).hardware
}

/** Door type, rating, leaf and size (plus the room for doors without a door type). */
export function typicalDoorOf(key: string): string {
  const k = parseGroupKey(key)
  const room = k.tag === NO_TAG ? k.room : ''
  return [k.tag, room, k.classification, k.leaf, k.size].join(SEP)
}

/** Could `older` (an earlier group) hold the doors of `key`? */
function sameDoors(key: string, older: string): boolean {
  if (typicalDoorOf(key) !== typicalDoorOf(older)) return false
  const o = parseGroupKey(older)
  return o.noHardware || o.hardware === parseGroupKey(key).hardware
}

/**
 * Earlier groups for a key: the same key, or older groups with the same door
 * type, rating, leaf, size (and hardware when they have it). `find` gives the
 * one whose lines to keep (the same key, else the one with the most doors);
 * `findAll` gives every earlier group the new group takes doors from.
 */
export function makeGroupFinder<T extends { group_key: string; door_qty?: number | string }>(
  groups: T[],
) {
  const byKey = new Map(groups.map((g) => [g.group_key, g]))
  const byDoor = new Map<string, T[]>()
  for (const g of groups) {
    const k = typicalDoorOf(g.group_key)
    byDoor.set(k, [...(byDoor.get(k) ?? []), g])
  }
  const findAll = (key: string): T[] => {
    const exact = byKey.get(key)
    if (exact) return [exact]
    return (byDoor.get(typicalDoorOf(key)) ?? [])
      .filter((g) => sameDoors(key, g.group_key))
      .sort((a, b) => Number(b.door_qty ?? 0) - Number(a.door_qty ?? 0))
  }
  return Object.assign((key: string): T | undefined => findAll(key)[0], { findAll })
}
