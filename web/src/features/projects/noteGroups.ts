/**
 * The rules' notes for a door group ("LOCK PREP 25: removed B0435SSS",
 * "LOCK PREP 25: added L2 (vestibule lock)", "Hinge: LO (Lift Off): ...")
 * grouped by what caused them, so one cell's changes read as one list:
 *
 *   LOCK PREP 25 (lockable)
 *     removed B0435SSS
 *     added L2 (vestibule lock)
 */

export interface NoteGroup {
  /** What caused the changes ("LOCK PREP 25 (lockable)", "Hinge", "Stop"); '' for notes without one. */
  cause: string
  items: string[]
}

const LOCK_PREP = /^LOCK PREP (\S+?)(?::\s*|\s+)(.*)$/

/** "LOCK PREP 25" -> "LOCK PREP 25 (lockable)" (what the value means, when known). */
function lockCause(value: string): string {
  const prep = value.split('/')[0]
  const meaning = prep === '15' ? 'non-lockable' : prep === '25' ? 'lockable' : 'meaning not confirmed'
  return `LOCK PREP ${value} (${meaning})`
}

export function groupNotes(notes: string[]): NoteGroup[] {
  const groups: NoteGroup[] = []
  const add = (cause: string, item: string) => {
    const g = groups.find((x) => x.cause === cause)
    if (g) {
      if (!g.items.includes(item)) g.items.push(item)
    } else groups.push({ cause, items: [item] })
  }
  for (const note of notes) {
    const lock = LOCK_PREP.exec(note)
    if (lock) {
      add(lockCause(lock[1]), lock[2])
      continue
    }
    const i = note.indexOf(': ')
    // A short lead-in before ": " names the cause ("Hinge", "Stop", "Kick plate (comment)").
    if (i > 0 && i <= 40) add(note.slice(0, i), note.slice(i + 2))
    else add('', note)
  }
  // Notes without a cause last.
  return [...groups.filter((g) => g.cause), ...groups.filter((g) => !g.cause)]
}
