import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, Merge } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import type { MergePlan } from '@/features/projects/mergeGroups'

interface MergeGroupsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  plan: MergePlan | null
  /** Supplier sheet names, for grouping the hardware choices. */
  sheetName: (sheetId: string) => string
  busy: boolean
  error: string | null
  onConfirm: (roomName: string, include: Set<string>) => void
}

/**
 * Merge door groups: the merged group's name and door qty, and — when the
 * groups' hardware differs — which of the lines only some groups have it gets
 * (all ticked to start with).
 */
export function MergeGroupsDialog({
  open,
  onOpenChange,
  plan,
  sheetName,
  busy,
  error,
  onConfirm,
}: MergeGroupsDialogProps) {
  const [roomName, setRoomName] = useState('')
  const [include, setInclude] = useState<Set<string>>(new Set())

  useEffect(() => {
    if (!open || !plan) return
    setRoomName(plan.roomName)
    setInclude(new Set(plan.uncommon.map((u) => u.key)))
  }, [open, plan])

  const bySheet = useMemo(() => {
    const m = new Map<string, MergePlan['uncommon']>()
    for (const u of plan?.uncommon ?? []) m.set(u.sheetId, [...(m.get(u.sheetId) ?? []), u])
    return [...m]
  }, [plan])

  if (!plan) return null
  const groups = [plan.target, ...plan.others]

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Merge {groups.length} Door Groups</DialogTitle>
          <DialogDescription>
            The doors become one group of {plan.doorQty}. It can be unmerged later: each group comes back with its own
            door qty and this group&apos;s hardware.
          </DialogDescription>
        </DialogHeader>

        <ul className="rounded-md border border-neutral-200 text-sm divide-y divide-neutral-100">
          {groups.map((g) => (
            <li key={g.id} className="flex items-center justify-between px-3 py-1.5">
              <span className="font-medium text-neutral-950">{g.room_name}</span>
              <span className="font-mono text-xs text-neutral-600">
                {[g.classification, g.leaf, g.door_size].filter(Boolean).join(' · ')} · {Number(g.door_qty)} door
                {Number(g.door_qty) === 1 ? '' : 's'}
              </span>
            </li>
          ))}
        </ul>

        <div className="space-y-1.5">
          <Label htmlFor="merge-room-name">Room Name</Label>
          <Input id="merge-room-name" value={roomName} onChange={(e) => setRoomName(e.target.value)} />
        </div>

        {plan.specsDiffer && (
          <p className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 p-2.5 text-xs text-amber-900">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>
              These groups have different ratings, leaves or sizes. The merged group keeps {plan.target.room_name}
              &apos;s: {[plan.target.classification, plan.target.leaf, plan.target.door_size].filter(Boolean).join(' · ')}.
            </span>
          </p>
        )}

        {plan.uncommon.length > 0 ? (
          <div className="space-y-2" data-testid="merge-uncommon">
            <p className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 p-2.5 text-xs text-amber-900">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>
                Some hardware isn&apos;t in every group. Tick what the merged group should have — every door in it will
                get it.
              </span>
            </p>
            <div className="max-h-64 space-y-3 overflow-y-auto pr-1">
              {bySheet.map(([sheetId, items]) => (
                <fieldset key={sheetId} className="space-y-1">
                  <legend className="text-xs font-semibold uppercase tracking-wider text-neutral-700">
                    {sheetName(sheetId)}
                  </legend>
                  {items.map((u) => (
                    <label
                      key={u.key}
                      className="flex cursor-pointer items-start gap-2 rounded-md border border-neutral-200 px-2.5 py-1.5 text-xs hover:bg-neutral-50"
                    >
                      <input
                        type="checkbox"
                        className="mt-0.5 h-3.5 w-3.5 accent-neutral-950"
                        checked={include.has(u.key)}
                        onChange={(e) =>
                          setInclude((prev) => {
                            const next = new Set(prev)
                            if (e.target.checked) next.add(u.key)
                            else next.delete(u.key)
                            return next
                          })
                        }
                        aria-label={`Include ${u.sku} ×${u.qtyPerDoor}`}
                      />
                      <span className="space-y-0.5">
                        <span className="block font-medium text-neutral-950">
                          <span className="font-mono">{u.sku}</span> ×{u.qtyPerDoor} — {u.description}
                        </span>
                        <span className="block text-neutral-600">
                          In {u.inRooms.join(', ')} · not in {u.notInRooms.join(', ')}
                        </span>
                      </span>
                    </label>
                  ))}
                </fieldset>
              ))}
            </div>
          </div>
        ) : (
          <p className="text-xs text-neutral-600">All groups have the same hardware.</p>
        )}

        {error && (
          <p role="alert" className="border border-neutral-950 bg-neutral-50 p-2.5 text-xs text-neutral-950">
            {error}
          </p>
        )}

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button type="button" disabled={busy || !roomName.trim()} onClick={() => onConfirm(roomName.trim(), include)}>
            <Merge className="h-3.5 w-3.5" />
            <span>{busy ? 'Merging…' : 'Merge'}</span>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
