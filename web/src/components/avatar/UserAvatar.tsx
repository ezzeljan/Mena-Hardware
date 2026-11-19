import { useState } from 'react'
import { initialsFor } from '@/lib/avatar'

const SIZES = {
  xs: 'h-5 w-5 text-[9px]',
  sm: 'h-6 w-6 text-[10px]',
  md: 'h-8 w-8 text-xs',
  lg: 'h-20 w-20 text-2xl',
} as const

export type AvatarSize = keyof typeof SIZES

interface UserAvatarProps {
  name: string | null | undefined
  url?: string | null
  email?: string | null
  size?: AvatarSize
  className?: string
}

/** Round profile photo; initials on a grey circle when there is no photo (or it fails to load). */
export function UserAvatar({ name, url, email, size = 'md', className = '' }: UserAvatarProps) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null)
  const showImage = !!url && failedUrl !== url
  const label = (name ?? '').trim() || email || 'User'

  return (
    <span
      className={`inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-neutral-200 font-semibold text-neutral-700 select-none ${SIZES[size]} ${className}`}
      title={label}
    >
      {showImage ? (
        <img
          src={url}
          alt={label}
          className="h-full w-full object-cover"
          onError={() => setFailedUrl(url)}
        />
      ) : (
        <span aria-label={label}>{initialsFor(name, email)}</span>
      )}
    </span>
  )
}

interface AvatarStackProps {
  people: Array<{ id: string; full_name: string | null; avatar_url: string | null }>
  max?: number
  size?: AvatarSize
}

/** Overlapping avatars ("+N" when there are more than `max`); names show on hover. */
export function AvatarStack({ people, max = 4, size = 'sm' }: AvatarStackProps) {
  if (people.length === 0) return <span className="text-xs text-neutral-400">—</span>
  const shown = people.slice(0, max)
  const extra = people.length - shown.length
  return (
    <span
      className="inline-flex items-center -space-x-1.5"
      aria-label={people.map((p) => p.full_name || 'Unnamed').join(', ')}
    >
      {shown.map((p) => (
        <UserAvatar
          key={p.id}
          name={p.full_name}
          url={p.avatar_url}
          size={size}
          className="ring-2 ring-white"
        />
      ))}
      {extra > 0 && (
        <span
          className={`inline-flex items-center justify-center rounded-full bg-neutral-950 font-semibold text-white ring-2 ring-white ${SIZES[size]}`}
          title={people.slice(max).map((p) => p.full_name).join(', ')}
        >
          +{extra}
        </span>
      )}
    </span>
  )
}
