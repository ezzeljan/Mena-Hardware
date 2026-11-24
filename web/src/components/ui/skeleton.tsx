import type { HTMLAttributes, ReactNode } from 'react'
import { cn } from '@/lib/utils'

/** A grey placeholder block that pulses while content loads. */
export function Skeleton({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      aria-hidden="true"
      className={cn('animate-pulse rounded bg-neutral-200', className)}
      {...props}
    />
  )
}

/** Wraps a skeleton so screen readers hear "Loading…" once instead of nothing. */
function LoadingRegion({
  label,
  className,
  children,
}: {
  label: string
  className?: string
  children: ReactNode
}) {
  return (
    <div role="status" aria-live="polite" className={className} data-testid="loading-skeleton">
      <span className="sr-only">{label}</span>
      {children}
    </div>
  )
}

// Varied widths so the rows look like real text, not a barcode.
const WIDTHS = ['w-3/4', 'w-1/2', 'w-2/3', 'w-5/6', 'w-2/5', 'w-3/5']

/** A table: a header row and `rows` rows of `columns` cells. */
export function TableSkeleton({
  rows = 6,
  columns = 4,
  label = 'Loading…',
  className,
}: {
  rows?: number
  columns?: number
  label?: string
  className?: string
}) {
  return (
    <LoadingRegion
      label={label}
      className={cn('overflow-hidden rounded-md border border-neutral-200', className)}
    >
      <div className="flex gap-4 border-b border-neutral-200 bg-neutral-50 px-4 py-3">
        {Array.from({ length: columns }, (_, c) => (
          <Skeleton key={c} className="h-3 flex-1 bg-neutral-300/70" />
        ))}
      </div>
      {Array.from({ length: rows }, (_, r) => (
        <div key={r} className="flex gap-4 border-b border-neutral-100 px-4 py-3.5 last:border-b-0">
          {Array.from({ length: columns }, (_, c) => (
            <div key={c} className="flex-1">
              <Skeleton className={cn('h-3', WIDTHS[(r + c) % WIDTHS.length])} />
            </div>
          ))}
        </div>
      ))}
    </LoadingRegion>
  )
}

/** A list of cards/rows (dashboard sections, activity). */
export function ListSkeleton({
  rows = 4,
  label = 'Loading…',
  className,
}: {
  rows?: number
  label?: string
  className?: string
}) {
  return (
    <LoadingRegion
      label={label}
      className={cn('divide-y divide-neutral-100 rounded-md border border-neutral-200', className)}
    >
      {Array.from({ length: rows }, (_, r) => (
        <div key={r} className="flex items-center justify-between gap-4 px-4 py-3">
          <div className="flex-1 space-y-2">
            <Skeleton className={cn('h-3.5', WIDTHS[r % WIDTHS.length], 'max-w-xs')} />
            <Skeleton className="h-2.5 w-32" />
          </div>
          <Skeleton className="h-5 w-24 rounded-full" />
        </div>
      ))}
    </LoadingRegion>
  )
}

/** A page heading (title, subtitle, a few buttons) above its content. */
export function PageHeaderSkeleton({ buttons = 2 }: { buttons?: number }) {
  return (
    <div
      className="flex flex-wrap items-center justify-between gap-4 border-b border-neutral-200 pb-4"
      aria-hidden="true"
    >
      <div className="space-y-2">
        <Skeleton className="h-5 w-56" />
        <Skeleton className="h-3 w-40" />
      </div>
      <div className="flex gap-2">
        {Array.from({ length: buttons }, (_, i) => (
          <Skeleton key={i} className="h-8 w-28" />
        ))}
      </div>
    </div>
  )
}

/**
 * Fallback while a page's code loads: the hardware grid page gets the grid's
 * shape (so it doesn't switch from a table to a grid skeleton), others a
 * heading and a table.
 */
export function PageSkeleton({ path = '' }: { path?: string }) {
  if (/^\/projects\/[^/]+\/hardware/.test(path)) {
    return (
      <div className="space-y-4">
        <PageHeaderSkeleton buttons={5} />
        <GridSkeleton />
      </div>
    )
  }
  return (
    <div className="space-y-6">
      <PageHeaderSkeleton />
      <TableSkeleton rows={8} columns={5} label="Loading page…" />
    </div>
  )
}

// Column widths (px) roughly matching the hardware grid's columns.
const GRID_WIDTHS = [150, 80, 80, 140, 60, 60, 110, 130, 220, 44, 70, 80, 70, 80, 120, 120, 90, 140]

/**
 * The hardware grid's shape: the status strip, the Excel header rows, the
 * column headers, then door groups (a grey DOOR QTY row and a few line rows).
 */
export function GridSkeleton({
  groups = 4,
  label = 'Loading the hardware grid…',
}: {
  groups?: number
  label?: string
}) {
  const cells = (h: string, tone = '', seed = 0) =>
    GRID_WIDTHS.map((w, i) => (
      <div key={i} className="shrink-0 border-r border-neutral-200 px-2 py-2" style={{ width: w }}>
        <Skeleton className={cn(h, tone, WIDTHS[(i + seed) % WIDTHS.length])} />
      </div>
    ))
  return (
    <LoadingRegion label={label} className="overflow-hidden border border-neutral-400 bg-white">
      <div className="flex items-center justify-between border-b border-neutral-400 px-3 py-2">
        <Skeleton className="h-2.5 w-72" />
        <Skeleton className="h-5 w-16" />
      </div>
      <div className="space-y-2 px-3 py-3">
        {[56, 48, 32].map((w, i) => (
          <div key={i} className="flex items-center justify-between">
            <Skeleton className="h-3.5" style={{ width: `${w * 4}px` }} />
            {i < 2 && <Skeleton className="h-5 w-24" />}
          </div>
        ))}
      </div>
      <div className="flex border-y border-neutral-400 bg-neutral-200">
        {cells('h-3', 'bg-neutral-300')}
      </div>
      {Array.from({ length: groups }, (_, g) => (
        <div key={g}>
          <div className="flex border-b border-neutral-200 bg-neutral-50">
            {cells('h-3', 'bg-neutral-300/70', g)}
          </div>
          {Array.from({ length: 2 + (g % 3) }, (_, r) => (
            <div key={r} className="flex border-b border-neutral-100">
              {cells('h-2.5', '', g + r + 1)}
            </div>
          ))}
        </div>
      ))}
    </LoadingRegion>
  )
}
