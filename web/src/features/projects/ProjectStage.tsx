import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Check, ChevronDown } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import type { ProjectStage } from '@/types/database'
import { AwardProjectDialog, type AwardChoice } from '@/features/projects/AwardProjectDialog'

export const PROJECT_STAGES: { value: ProjectStage; label: string }[] = [
  { value: 'tender', label: 'Tender' },
  { value: 'awarded', label: 'Awarded' },
]

export const STAGE_LABEL: Record<ProjectStage, string> = {
  tender: 'Tender',
  awarded: 'Awarded',
}

const STAGE_TONE: Record<ProjectStage, string> = {
  tender: 'border-amber-200 bg-amber-50 text-amber-800',
  awarded: 'border-emerald-200 bg-emerald-50 text-emerald-700',
}

const DOT_TONE: Record<ProjectStage, string> = {
  tender: 'bg-amber-500',
  awarded: 'bg-emerald-500',
}

/** Read-only stage pill. */
export function StageBadge({ stage }: { stage: ProjectStage }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] font-semibold ${STAGE_TONE[stage]}`}
      data-testid="project-stage"
    >
      <span className={`h-1.5 w-1.5 rounded-full ${DOT_TONE[stage]}`} aria-hidden="true" />
      {STAGE_LABEL[stage]}
    </span>
  )
}

/**
 * Change a project's stage; refreshes the project, the list and the activity.
 * Awarding needs the winning quote and supplier (migration 021); back to
 * Tender clears them.
 */
export function useUpdateProjectStage() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({
      projectId,
      stage,
      award,
    }: {
      projectId: string
      stage: ProjectStage
      award?: AwardChoice
    }) => {
      const { data, error } = await supabase
        .from('projects')
        .update(
          stage === 'awarded' && award
            ? { stage, awarded_quote_id: award.quoteId, awarded_supplier_id: award.supplierId }
            : { stage },
        )
        .eq('id', projectId)
        .select('id')
      if (error) throw error
      // RLS filters rows the user may not change instead of raising an error.
      if (!data || data.length === 0) throw new Error('You do not have permission to change the stage.')
    },
    onSettled: async (_data, _error, { projectId }) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['projects'] }),
        queryClient.invalidateQueries({ queryKey: ['project', projectId] }),
        queryClient.invalidateQueries({ queryKey: ['award-candidates', projectId] }),
      ])
    },
  })
}

interface StageSelectProps {
  projectId: string
  stage: ProjectStage
  /** Accessible name, e.g. "Stage of SV002 — McLaren". */
  label?: string
}

/**
 * Stage pill that opens a small menu (Tender / Awarded), for the assigned PM
 * and admins. The menu is portalled and fixed-positioned so table scrolling
 * never clips it.
 */
export function StageSelect({ projectId, stage, label = 'Project stage' }: StageSelectProps) {
  const mutation = useUpdateProjectStage()
  const shown = mutation.isPending && mutation.variables ? mutation.variables.stage : stage
  const [open, setOpen] = useState(false)
  const [awardOpen, setAwardOpen] = useState(false)
  const [active, setActive] = useState(0)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)
  const buttonRef = useRef<HTMLButtonElement | null>(null)
  const listRef = useRef<HTMLUListElement | null>(null)
  const listId = useId()

  const close = (focusButton = true) => {
    setOpen(false)
    if (focusButton) buttonRef.current?.focus()
  }

  const openMenu = () => {
    const rect = buttonRef.current?.getBoundingClientRect()
    if (!rect) return
    setPos({ top: rect.bottom + 4, left: rect.left })
    setActive(Math.max(0, PROJECT_STAGES.findIndex((s) => s.value === shown)))
    setOpen(true)
  }

  const choose = (value: ProjectStage) => {
    close()
    if (value === stage) return
    if (value === 'awarded') {
      // Pick the winning quote and supplier first.
      mutation.reset()
      setAwardOpen(true)
    } else {
      mutation.mutate({ projectId, stage: value })
    }
  }

  // Close on outside click, scroll or resize (the menu is fixed-positioned).
  useEffect(() => {
    if (!open) return
    const onPointer = (e: PointerEvent) => {
      const t = e.target as Node
      if (!listRef.current?.contains(t) && !buttonRef.current?.contains(t)) setOpen(false)
    }
    const onMove = () => setOpen(false)
    document.addEventListener('pointerdown', onPointer)
    window.addEventListener('scroll', onMove, true)
    window.addEventListener('resize', onMove)
    listRef.current?.focus()
    return () => {
      document.removeEventListener('pointerdown', onPointer)
      window.removeEventListener('scroll', onMove, true)
      window.removeEventListener('resize', onMove)
    }
  }, [open])

  return (
    <span className="inline-flex flex-col items-start gap-0.5">
      <button
        ref={buttonRef}
        type="button"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        disabled={mutation.isPending}
        onClick={() => (open ? close() : openMenu())}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault()
            openMenu()
          }
        }}
        className={`inline-flex h-6 items-center gap-1.5 rounded-full border pl-2 pr-1.5 text-[11px] font-semibold transition-shadow hover:shadow-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-neutral-950 disabled:cursor-wait disabled:opacity-70 ${STAGE_TONE[shown]}`}
        data-testid="project-stage-select"
      >
        <span className={`h-1.5 w-1.5 rounded-full ${DOT_TONE[shown]}`} aria-hidden="true" />
        {STAGE_LABEL[shown]}
        <ChevronDown className={`h-3 w-3 opacity-70 transition-transform ${open ? 'rotate-180' : ''}`} aria-hidden="true" />
      </button>

      {open &&
        pos &&
        createPortal(
          <ul
            ref={listRef}
            id={listId}
            role="listbox"
            aria-label={label}
            tabIndex={-1}
            aria-activedescendant={`${listId}-${PROJECT_STAGES[active].value}`}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault()
                setActive((i) => (i + 1) % PROJECT_STAGES.length)
              } else if (e.key === 'ArrowUp') {
                e.preventDefault()
                setActive((i) => (i - 1 + PROJECT_STAGES.length) % PROJECT_STAGES.length)
              } else if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                choose(PROJECT_STAGES[active].value)
              } else if (e.key === 'Escape' || e.key === 'Tab') {
                e.preventDefault()
                close()
              }
            }}
            style={{ top: pos.top, left: pos.left }}
            className="fixed z-50 min-w-[9rem] rounded-lg border border-neutral-200 bg-white p-1 shadow-lg outline-none animate-in fade-in-0 zoom-in-95"
          >
            {PROJECT_STAGES.map((s, i) => {
              const selected = s.value === shown
              return (
                <li
                  key={s.value}
                  id={`${listId}-${s.value}`}
                  role="option"
                  aria-selected={selected}
                  onPointerEnter={() => setActive(i)}
                  onClick={() => choose(s.value)}
                  className={`flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-xs text-neutral-900 ${
                    i === active ? 'bg-neutral-100' : ''
                  }`}
                >
                  <span className={`h-2 w-2 rounded-full ${DOT_TONE[s.value]}`} aria-hidden="true" />
                  <span className="flex-1 font-medium">{s.label}</span>
                  {selected && <Check className="h-3.5 w-3.5 text-neutral-950" aria-hidden="true" />}
                </li>
              )
            })}
          </ul>,
          document.body,
        )}

      {mutation.isError && !awardOpen && (
        <span role="alert" className="text-[10px] font-medium text-red-700">
          {(mutation.error as Error).message}
        </span>
      )}

      <AwardProjectDialog
        open={awardOpen}
        onOpenChange={setAwardOpen}
        projectId={projectId}
        pending={mutation.isPending}
        error={mutation.isError ? (mutation.error as Error).message : null}
        onConfirm={(award) =>
          mutation.mutate(
            { projectId, stage: 'awarded', award },
            { onSuccess: () => setAwardOpen(false) },
          )
        }
      />
    </span>
  )
}
