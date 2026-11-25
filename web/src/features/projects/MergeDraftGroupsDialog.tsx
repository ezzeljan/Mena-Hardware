import { useEffect, useState } from 'react'
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
import type { DraftMergePlan } from '@/features/projects/mergeParsedGroups'

interface MergeDraftGroupsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  plan: DraftMergePlan | null
  onConfirm: (roomName: string, include: Set<string>) => void
}

/**
 * Merge door groups on the Matching Review step: the merged group's name, and
 * — when the quotation's hardware differs — which items only some groups have
 * it gets (all ticked to start with).
 */
export function MergeDraftGroupsDialog({ open, onOpenChange, plan, onConfirm }: MergeDraftGroupsDialogProps) {
  const [roomName, setRoomName] = useState('')
  const [include, setInclude] = useState<Set<string>>(new Set())

  useEffect(() => {
    if (!open || !plan) return
    setRoomName(plan.roomName)
    setInclude(new Set(plan.uncommon.map((u) => u.label)))
  }, [open, plan])

  if (!plan) return null
  const first = plan.groups[0]

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Merge {plan.groups.length} Door Groups</DialogTitle>
          <DialogDescription>
            The doors become one group of {plan.doorQty}, matched like the first group. It can be unmerged again before
            or after saving.
          </DialogDescription>
        </DialogHeader>

        <ul className="rounded-md border border-neutral-200 text-sm divide-y divide-neutral-100">
          {plan.groups.map((g) => (
            <li key={g.group_key} className="flex items-center justify-between gap-3 px-3 py-1.5">
              <span className="font-medium text-neutral-950">{g.room_name}</span>
              <span className="font-mono text-xs text-neutral-600">
                {[g.classification, g.leaf, g.door_size].filter(Boolean).join(' · ')} · {g.door_qty} door
                {g.door_qty === 1 ? '' : 's'}
              </span>
            </li>
          ))}
        </ul>

        <div className="space-y-1.5">
          <Label htmlFor="merge-draft-room-name">Room Name</Label>
          <Input id="merge-draft-room-name" value={roomName} onChange={(e) => setRoomName(e.target.value)} />
        </div>

        {plan.specsDiffer && (
          <p className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 p-2.5 text-xs text-amber-900">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>
              These groups have different ratings, leaves or sizes. The merged group keeps the first one&apos;s:{' '}
              {[first.classification, first.leaf, first.door_size].filter(Boolean).join(' · ')}.
            </span>
          </p>
        )}

        {plan.uncommon.length > 0 ? (
          <div className="space-y-2" data-testid="merge-draft-uncommon">
            <p className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 p-2.5 text-xs text-amber-900">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>
                Some hardware isn&apos;t in every group. Tick what the merged group should have — every door in it will
                get it.
              </span>
            </p>
            <div className="max-h-64 space-y-1 overflow-y-auto pr-1">
              {plan.uncommon.map((u) => (
                <label
                  key={u.label}
                  className="flex cursor-pointer items-start gap-2 rounded-md border border-neutral-200 px-2.5 py-1.5 text-xs hover:bg-neutral-50"
                >
                  <input
                    type="checkbox"
                    className="mt-0.5 h-3.5 w-3.5 accent-neutral-950"
                    checked={include.has(u.label)}
                    onChange={(e) =>
                      setInclude((prev) => {
                        const next = new Set(prev)
                        if (e.target.checked) next.add(u.label)
                        else next.delete(u.label)
                        return next
                      })
                    }
                    aria-label={`Include ${u.label}`}
                  />
                  <span className="space-y-0.5">
                    <span className="block font-medium text-neutral-950">{u.label}</span>
                    <span className="block text-neutral-600">
                      In {u.inRooms.join(', ')} · not in {u.notInRooms.join(', ')}
                    </span>
                  </span>
                </label>
              ))}
            </div>
          </div>
        ) : (
          <p className="text-xs text-neutral-600">All groups have the same hardware.</p>
        )}

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" disabled={!roomName.trim()} onClick={() => onConfirm(roomName.trim(), include)}>
            <Merge className="h-3.5 w-3.5" />
            <span>Merge</span>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
