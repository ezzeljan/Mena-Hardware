/**
 * Door group keys: "tag | room | classification | leaf | size | hardware".
 *
 * A door group is one typical door in one room: the same room, rating, leaf,
 * size (the same height and every leaf width) and hardware. The door type
 * doesn't change the hardware, so new keys have "*" for it: doors of different door types in the same room are one
 * group (listing its tags, e.g. "D-03 / D-04"). Rooms stay apart because the
 * quotation's columns don't show every hardware difference between rooms
 * (a bathroom's privacy set vs a bedroom's passage set). The room is compared
 * ignoring capitals and spacing. Doors whose hardware differs get their own
 * group.
 *
 * Groups saved earlier have the door type in the key (and "*" for the room
 * when one door type was merged across rooms); the oldest have no hardware
 * part. A re-import or version comparison still finds them: same rating,
 * leaf and size, the same room (any room for "*"), and the same hardware when
 * the old key has it.
 */

const SEP = ' | '

/** Room part of older keys whose group was merged across rooms. */
export const ANY_ROOM = '*'
/** Door type part of new keys: groups are not split by door type. */
export const ANY_TAG = '*'

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

/** Room as compared in keys: capitals and spacing don't matter. */
export function roomKeyOf(room: string): string {
  return room.replace(/\s+/g, ' ').trim().toUpperCase()
}

export function makeGroupKey(d: {
  room: string
  classification: string | null
  leaf: string | null
  size: string | null
  hardware: string
}): string {
  return [
    ANY_TAG,
    roomKeyOf(d.room),
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

/** Rating, leaf and size: what an earlier group must share to be considered. */
export function typicalDoorOf(key: string): string {
  const k = parseGroupKey(key)
  return [k.classification, k.leaf, k.size].join(SEP)
}

/** Could `older` (an earlier group) hold the doors of `key`? */
function sameDoors(key: string, older: string): boolean {
  if (typicalDoorOf(key) !== typicalDoorOf(older)) return false
  const k = parseGroupKey(key)
  const o = parseGroupKey(older)
  const sameRoom = k.room === ANY_ROOM || o.room === ANY_ROOM || roomKeyOf(k.room) === roomKeyOf(o.room)
  return sameRoom && (o.noHardware || o.hardware === k.hardware)
}

/**
 * Earlier groups for a key: the same key, or older groups with the same
 * rating, leaf, size, room (any for "*") and hardware (when they have it).
 * `find` gives the one whose lines to keep (the same key, else the one with
 * the most doors); `findAll` gives every earlier group the new group takes
 * doors from.
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
