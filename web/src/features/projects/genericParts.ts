/**
 * Generic set items ("PASSAGE SET LEVER ROUND") -> the part to quote.
 *
 * A standard set names generic items (migration 027); a quotation import swaps
 * each one for a part from the quote's supplier, in this order:
 *
 *   1. the generic item's preferred part for that supplier;
 *   2. the supplier's part in the item's folder that clearly matches the
 *      item's name (folders are broad: a passage set, privacy set and
 *      turnsnib share one, so the name's distinctive words count most);
 *   3. the item's preferred part from any supplier (owner-supplied first);
 *   4. none: the line stays generic, with no price, flagged for review.
 *
 * The door rules (lock prep, hinge type, sizing, ...) then adjust the part for
 * the door, as they do for any set line.
 */

export interface GenericItem {
  id: string
  code: string
  description: string
  folder_id: string | null
  active: boolean
}

export interface GenericPreference {
  generic_id: string
  supplier_id: string
  part_id: string
}

export interface ResolvablePart {
  id: string
  sku: string
  description: string
  supplier_id: string
  unit_cost: number | null
  active: boolean
  folder_id?: string | null
}

export type GenericPick = 'preferred' | 'folder' | 'default'

export interface GenericResolution<P extends ResolvablePart> {
  part: P
  how: GenericPick
}

const words = (s: string) =>
  new Set(
    s
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, ' ')
      .split(' ')
      .filter((w) => w.length > 1 && !['WITH', 'AND', 'FOR', 'THE', 'TO', 'SUIT'].includes(w)),
  )

/**
 * How well a part's description matches the item's name (0-1): the share of
 * the name's words it has, each word weighted by how distinctive it is among
 * the names of the folder's items ("PASSAGE" counts more than "SET", "LEVER",
 * "ROUND", which many items share). Without other names, every word counts the same.
 */
export function nameMatch(
  itemName: string,
  partDescription: string,
  folderNames: string[] = [],
): number {
  const want = words(itemName)
  if (want.size === 0) return 0
  const others = folderNames.map(words)
  const weight = (w: string) => 1 / Math.max(1, others.filter((o) => o.has(w)).length)
  const have = words(partDescription)
  let total = 0
  let got = 0
  for (const w of want) {
    total += weight(w)
    if (have.has(w)) got += weight(w)
  }
  return got / total
}

export function resolveGenericItem<P extends ResolvablePart>(
  item: GenericItem,
  supplierId: string | null,
  preferences: GenericPreference[],
  parts: { byId: Map<string, P>; all: P[] },
  ownerSupplierIds: Set<string> = new Set(),
  /** Every generic item, for weighting the name's words within its folder. */
  allItems: GenericItem[] = [],
): GenericResolution<P> | null {
  const usable = (id: string | undefined) => {
    const p = id ? parts.byId.get(id) : undefined
    return p && p.active ? p : undefined
  }
  const mine = preferences.filter((x) => x.generic_id === item.id)

  if (supplierId) {
    const pref = usable(mine.find((x) => x.supplier_id === supplierId)?.part_id)
    if (pref) return { part: pref, how: 'preferred' }

    if (item.folder_id) {
      const inFolder = parts.all.filter(
        (p) => p.active && p.supplier_id === supplierId && p.folder_id === item.folder_id,
      )
      const names = [
        item.description,
        ...allItems
          .filter((g) => g.id !== item.id && g.folder_id === item.folder_id)
          .map((g) => g.description),
      ]
      const scored = inFolder
        .map((p) => ({ p, score: nameMatch(item.description, p.description, names) }))
        .sort((a, b) => b.score - a.score)
      // Clearly the best fit (even when it's the only part there): most of the
      // name's weight, and ahead of the next part.
      if (scored.length && scored[0].score >= 0.6 && scored[0].score > (scored[1]?.score ?? 0)) {
        return { part: scored[0].p, how: 'folder' }
      }
    }
  }

  const fallback = mine
    .map((x) => usable(x.part_id))
    .filter((p): p is P => !!p)
    .sort(
      (a, b) =>
        Number(ownerSupplierIds.has(b.supplier_id)) - Number(ownerSupplierIds.has(a.supplier_id)),
    )[0]
  return fallback ? { part: fallback, how: 'default' } : null
}
