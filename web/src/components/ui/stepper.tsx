import { Check } from 'lucide-react'
import { cn } from '@/lib/utils'

export interface StepperStep {
  id: string
  title: string
  description?: string
}

interface StepperProps {
  steps: StepperStep[]
  currentStep: number
  onStepClick?: (index: number) => void
  className?: string
}

export function Stepper({
  steps,
  currentStep,
  onStepClick,
  className,
}: StepperProps) {
  return (
    <nav aria-label="Progress" className={cn('w-full', className)}>
      <ol className="flex flex-col sm:flex-row sm:items-start gap-4 sm:gap-0">
        {steps.map((step, index) => {
          const isCompleted = index < currentStep
          const isCurrent = index === currentStep
          const canClick = Boolean(onStepClick && index < currentStep)

          return (
            <li
              key={step.id}
              className={cn(
                'relative flex-1 flex sm:flex-col items-center sm:items-start gap-3 sm:gap-2',
              )}
            >
              {/* Connector line on desktop */}
              {index < steps.length - 1 && (
                <div
                  aria-hidden="true"
                  className={cn(
                    'hidden sm:block absolute top-4 left-9 right-2 h-px transition-colors',
                    isCompleted ? 'bg-neutral-950' : 'bg-neutral-200',
                  )}
                />
              )}

              <button
                type="button"
                disabled={!canClick}
                onClick={() => canClick && onStepClick?.(index)}
                className={cn(
                  'relative z-10 flex items-center gap-3 sm:flex-col sm:items-start sm:gap-2 text-left',
                  canClick ? 'cursor-pointer' : 'cursor-default',
                )}
              >
                <span
                  className={cn(
                    'flex h-8 w-8 shrink-0 items-center justify-center rounded-full border text-xs font-mono font-semibold transition-colors',
                    isCompleted &&
                      'border-neutral-950 bg-neutral-950 text-white',
                    isCurrent &&
                      'border-neutral-950 bg-white text-neutral-950 ring-2 ring-neutral-950/15',
                    !isCompleted &&
                      !isCurrent &&
                      'border-neutral-300 bg-white text-neutral-400',
                  )}
                >
                  {isCompleted ? (
                    <Check className="h-4 w-4" />
                  ) : (
                    <span>{index + 1}</span>
                  )}
                </span>

                <span className="pr-4">
                  <span
                    className={cn(
                      'block text-xs font-semibold tracking-tight',
                      isCurrent || isCompleted
                        ? 'text-neutral-950'
                        : 'text-neutral-400',
                    )}
                  >
                    {step.title}
                  </span>
                  {step.description && (
                    <span className="block text-[11px] text-neutral-500 mt-0.5">
                      {step.description}
                    </span>
                  )}
                </span>
              </button>
            </li>
          )
        })}
      </ol>
    </nav>
  )
}
