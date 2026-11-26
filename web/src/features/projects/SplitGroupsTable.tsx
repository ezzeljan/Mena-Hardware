import { Check } from 'lucide-react'
import { hardwareParts } from '@/features/projects/hardwareParts'
import type { IssueSplit } from '@/features/projects/quotationParser'

interface Item {
  key: string
  label: string
  yes: boolean
}

/** A group's hardware as display items: the HW columns (as in the quotation), comment items, prep / install. */
function itemsOf(split: IssueSplit, headers: Array<[string, string]>) {
  const { builder, comments, prep } = hardwareParts(split.hardware, headers, split.prep_values)
  const hw: Item[] = [
    ...builder.map((b) => ({
      key: `hw:${b.header}:${b.value ?? 'YES'}`,
      label: b.value === null ? b.header : `${b.header}: ${b.value}`,
      yes: b.value === null,
    })),
    ...comments.map((c) => ({ key: `c:${c}`, label: c, yes: false })),
  ]
  const pi: Item[] = prep.map((p) => ({ key: `p:${p}`, label: p, yes: false }))
  return { hw, pi }
}

function ItemCell({ items, differs }: { items: Item[]; differs: Set<string> }) {
  if (items.length === 0) return <span className="text-neutral-400">—</span>
  return (
    <ul className="space-y-0.5">
      {items.map((i) => (
        <li
          key={i.key}
          className={`flex w-fit items-center gap-1 whitespace-nowrap ${
            differs.has(i.key) ? 'rounded-sm bg-amber-100 px-1 font-medium text-neutral-950' : 'text-neutral-500'
          }`}
          data-differs={differs.has(i.key) || undefined}
        >
          {i.yes && <Check className="h-3 w-3 shrink-0 text-green-700" aria-label="Yes" />}
          {i.label}
        </li>
      ))}
    </ul>
  )
}

/**
 * The door groups one room was split into, one row each, with the items that
 * aren't on every group highlighted (what made them separate groups).
 */
export function SplitGroupsTable({ splits, headers }: { splits: IssueSplit[]; headers: Array<[string, string]> }) {
  const all = splits.map((s) => itemsOf(s, headers))
  const keysOf = (x: { hw: Item[]; pi: Item[] }) => new Set([...x.hw, ...x.pi].map((i) => i.key))
  const sets = all.map(keysOf)
  const differs = new Set([...new Set(sets.flatMap((s) => [...s]))].filter((k) => !sets.every((s) => s.has(k))))
  // What a group lacks that another has.
  const byKey = new Map(all.flatMap((x) => [...x.hw, ...x.pi]).map((it) => [it.key, it]))
  const lacking = (i: number): Item[] =>
    [...differs].filter((k) => !sets[i].has(k)).map((k) => byKey.get(k) ?? { key: k, label: k, yes: false })

  return (
    <table className="mt-2 w-full border border-neutral-200 text-[11px]" data-testid="split-groups">
      <thead className="bg-neutral-50 text-[10px] uppercase tracking-wider text-neutral-500">
        <tr>
          <th className="px-2 py-1 text-left font-semibold">Group</th>
          <th className="px-2 py-1 text-right font-semibold">Doors</th>
          <th className="px-2 py-1 text-left font-semibold">Rows</th>
          <th className="px-2 py-1 text-left font-semibold">Builder HW</th>
          <th className="px-2 py-1 text-left font-semibold">Prep / Install</th>
          <th className="px-2 py-1 text-left font-semibold">Doesn&apos;t have</th>
        </tr>
      </thead>
      <tbody>
        {splits.map((s, i) => {
          const missing = lacking(i)
          return (
            <tr key={s.position} className="border-t border-neutral-200 align-top">
              <td className="px-2 py-1.5">
                <div className="font-mono font-semibold text-neutral-950">#{s.position}</div>
                {s.door_tag && <div className="font-mono text-neutral-500">{s.door_tag}</div>}
              </td>
              <td className="px-2 py-1.5 text-right font-mono font-semibold text-neutral-950">{s.door_qty}</td>
              <td className="px-2 py-1.5 font-mono text-neutral-500">
                {s.source_rows.length > 6 ? `${s.source_rows.slice(0, 6).join(', ')} +${s.source_rows.length - 6}` : s.source_rows.join(', ')}
              </td>
              <td className="px-2 py-1.5">
                <ItemCell items={all[i].hw} differs={differs} />
              </td>
              <td className="px-2 py-1.5">
                <ItemCell items={all[i].pi} differs={differs} />
              </td>
              <td className="px-2 py-1.5 text-neutral-700">
                {/* One item per line, like the hardware columns. */}
                {missing.length ? (
                  <ul className="space-y-0.5" data-testid="split-missing">
                    {missing.map((m) => (
                      <li key={m.key} className="flex w-fit items-center gap-1 whitespace-nowrap">
                        {m.yes && <Check className="h-3 w-3 shrink-0 text-neutral-400" aria-label="Yes" />}
                        {m.label}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <span className="text-neutral-400">—</span>
                )}
              </td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}
