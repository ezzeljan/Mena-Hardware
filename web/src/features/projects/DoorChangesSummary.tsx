import { changeCounts, type DoorChange, type DoorChanges } from '@/features/projects/doorChanges'
import { cn } from '@/lib/utils'

function VariationBadge() {
  return (
    <span className="ml-1 inline-block border border-green-700 bg-green-50 px-1 text-[10px] font-semibold uppercase text-green-800">
      Variation
    </span>
  )
}

const spec = (d: DoorChange) => [d.classification, d.leaf, d.door_size].filter(Boolean).join(' · ')

function DoorTable({ rows }: { rows: DoorChange[] }) {
  return (
    <table className="w-full text-left text-[11px]">
      <thead className="text-neutral-500">
        <tr>
          <th className="py-1 pr-2 font-medium">Row</th>
          <th className="py-1 pr-2 font-medium">Door</th>
          <th className="py-1 pr-2 font-medium">Room</th>
          <th className="py-1 pr-2 font-medium">Door Specs</th>
          <th className="py-1 text-right font-medium">Qty</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((d, i) => (
          <tr key={`${d.row}-${i}`} className="border-t border-neutral-200">
            <td className="py-1 pr-2 font-mono">{d.row}</td>
            <td className="py-1 pr-2 font-mono">
              {d.door_ref}
              {d.variation && <VariationBadge />}
            </td>
            <td className="py-1 pr-2">{d.room_name}</td>
            <td className="py-1 pr-2 font-mono text-neutral-600">{spec(d)}</td>
            <td className="py-1 text-right font-mono">{d.qty}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function Section({ title, count, children }: { title: string; count: number; children: React.ReactNode }) {
  if (count === 0) return null
  return (
    <details className="border border-neutral-200 bg-white">
      <summary className="cursor-pointer select-none px-2 py-1.5 text-xs font-semibold text-neutral-950">
        {title} ({count})
      </summary>
      <div className="max-h-72 overflow-y-auto px-2 pb-2">{children}</div>
    </details>
  )
}

/** Doors added, removed and changed since the previous upload. */
export function DoorChangesSummary({
  changes,
  className,
}: {
  changes: DoorChanges
  className?: string
}) {
  const n = changeCounts(changes)
  const none = n.added === 0 && n.removed === 0 && n.changed === 0
  return (
    <div className={cn('space-y-1.5', className)} data-testid="door-changes">
      <div className="flex flex-wrap gap-x-4 gap-y-1 font-mono text-xs text-neutral-800">
        <span>
          Doors added: {n.added}
          {n.addedInVariation > 0 && ` (${n.addedInVariation} in variation)`}
        </span>
        <span>Removed: {n.removed}</span>
        <span>Changed: {n.changed}</span>
        <span>
          Total doors: {changes.previousTotal} → {changes.currentTotal}
        </span>
      </div>
      {none ? (
        <div className="text-xs text-neutral-600">No doors added, removed or changed.</div>
      ) : (
        <div className="space-y-1">
          <Section title="Added doors" count={n.added}>
            <DoorTable rows={changes.added} />
          </Section>
          <Section title="Removed doors" count={n.removed}>
            <DoorTable rows={changes.removed} />
          </Section>
          <Section title="Changed doors" count={n.changed}>
            <table className="w-full text-left text-[11px]">
              <thead className="text-neutral-500">
                <tr>
                  <th className="py-1 pr-2 font-medium">Row</th>
                  <th className="py-1 pr-2 font-medium">Door</th>
                  <th className="py-1 pr-2 font-medium">Room</th>
                  <th className="py-1 pr-2 font-medium">Before</th>
                  <th className="py-1 pr-2 font-medium">Now</th>
                  <th className="py-1 text-right font-medium">Qty</th>
                </tr>
              </thead>
              <tbody>
                {changes.changed.map((c, i) => (
                  <tr key={`${c.after.row}-${i}`} className="border-t border-neutral-200">
                    <td className="py-1 pr-2 font-mono">{c.after.row}</td>
                    <td className="py-1 pr-2 font-mono">
                      {c.after.door_ref}
                      {c.after.variation && <VariationBadge />}
                    </td>
                    <td className="py-1 pr-2">{c.after.room_name}</td>
                    <td className="py-1 pr-2 font-mono text-neutral-500 line-through">{spec(c.before)}</td>
                    <td className="py-1 pr-2 font-mono">{spec(c.after)}</td>
                    <td className="py-1 text-right font-mono">{c.after.qty}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Section>
        </div>
      )}
    </div>
  )
}
