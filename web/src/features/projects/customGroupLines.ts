/**
 * A door group with no standard set (unmatched, or a custom group) still needs
 * hardware. Its lines start from the door itself, then the same rules as a
 * matched set add the rest from the quotation's cells:
 *
 *   - hinges: 3 per leaf (none for a cavity slider or pivot door); the Hinge
 *     column then picks the type (LO lift off, BH ball bearing) and sizing
 *     adds extra hinges for tall doors / the EXTRA HINGE column;
 *   - PREPARATION / INSTALLATION costs: closer, stop, seals, kick plate, bolts
 *     (activityRules.ts);
 *   - LOCK PREP / LOCK INST: the lock, cylinder, lever, escutcheon (lockRules.ts);
 *   - the Builder HW columns and comments: ES, CR, RS, viewer ... (doorFlags.ts).
 */
import { toPartIndex, type PartIndex, type SizingPart } from './doorSizing'

export interface StartingLine {
  part: SizingPart
  qty: number
}

const HINGES_PER_LEAF = 3

/** The standard hinge: owner-supplied MMHINGE, else any active hinge (not lift off / pivot). */
function standardHinge(parts: SizingPart[] | PartIndex): SizingPart | undefined {
  const { active } = toPartIndex(parts)
  const isHinge = (p: SizingPart) =>
    /\bHINGES?\b/i.test(p.description) && !/PIVOT|SOSS|CONCEALED|CONTINUOUS|PIANO|LIFT\s*OFF/i.test(p.description)
  return active.find((p) => p.sku.trim().toUpperCase() === 'MMHINGE') ?? active.find(isHinge)
}

/** The lines a door group with no set starts from (before the rules run). */
export function startingLines(
  group: { leaf: string | null; classification: string | null },
  leaves: number,
  parts: SizingPart[] | PartIndex,
): StartingLine[] {
  const noHinges = /CAVITY|SLID/i.test(group.leaf ?? '') || /PIVOT/i.test(group.classification ?? '')
  if (noHinges) return []
  const hinge = standardHinge(parts)
  return hinge ? [{ part: hinge, qty: HINGES_PER_LEAF * Math.max(1, leaves) }] : []
}
