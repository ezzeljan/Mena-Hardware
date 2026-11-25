/** A door schedule (HW) column with a value on the door. */
export interface BuilderItem {
  /** The column's header as written in the quotation ("Self Closing"). */
  header: string
  /** The cell's value ("CL", "LO"); null for YES / Y (shown with a check mark). */
  value: string | null
}

/**
 * A door's hardware split by where it comes from:
 *   - builder: the door schedule's HW columns (Self Closing … Keying), with
 *     the header as in the quotation and the cell's value.
 *   - comments: items the comments ask for (kick plate, card reader…).
 *   - prep: the PREPARATION / INSTALLATION cost columns and extra hinges
 *     ("Stop", "Closer ×2", "Lock prep: 25", "Extra hinge ×1").
 *
 * `headers` maps each HW column's label in the hardware text ("Closer") to its
 * header in the quotation ("Self Closing"); see QuotationParseResult.hardwareHeaders.
 * Without headers every other item counts as builder hardware. `prepValues`
 * (item -> cell value) adds each prep / install item's value: "Closer ×2: 44".
 */
export function hardwareParts(
  hardware: string,
  headers: Array<[label: string, header: string]> = [],
  prepValues: Record<string, string> = {},
): { builder: BuilderItem[]; comments: string[]; prep: string[] } {
  // "Closer ×2" -> "Closer ×2: 44" (the cell's value), when known.
  const withValue = (item: string) => {
    const v = prepValues[item.replace(/ ×\d+$/, '')]
    return v ? `${item}: ${v}` : item
  }
  const headerOf = new Map(headers)
  const builder: BuilderItem[] = []
  const comments: string[] = []
  const prep: string[] = []
  for (const t of hardware.split(' · ').map((x) => x.trim()).filter(Boolean)) {
    if (t.startsWith('Prep: ')) {
      prep.push(...t.slice(6).split(', ').map(withValue))
      continue
    }
    if (t.startsWith('Lock prep: ') || t.startsWith('Extra hinge')) {
      prep.push(t.startsWith('Extra hinge') ? withValue(t) : t)
      continue
    }
    const i = t.indexOf(': ')
    const label = i >= 0 ? t.slice(0, i) : t
    const value = i >= 0 ? t.slice(i + 2) : null
    const header = headerOf.get(label)
    if (header !== undefined) builder.push({ header, value })
    else if (headers.length === 0) builder.push({ header: label, value })
    else comments.push(t)
  }
  // In the quotation's column order.
  const order = headers.map(([, h]) => h)
  if (order.length) builder.sort((a, b) => order.indexOf(a.header) - order.indexOf(b.header))
  return { builder, comments, prep }
}
