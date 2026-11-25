import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Bell } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/features/auth/AuthContext'
import type { AppNotification } from '@/types/database'
import { UserAvatar } from '@/components/avatar/UserAvatar'
import { useProfileDirectory } from '@/features/account/useProfileDirectory'

const POLL_MS = 30_000

function timeAgo(iso: string): string {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `${hours}h ago`
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
}

/**
 * Where a notification leads: assignments to the overview, version events to
 * the grid, comments to the grid with the comments drawer open.
 */
function hrefFor(n: AppNotification): string | null {
  if (!n.project_id) return null
  if (n.kind === 'assigned_estimator' || n.kind === 'assigned_pm') return `/projects/${n.project_id}`
  const version = n.version_id ? `version=${n.version_id}` : ''
  if (n.kind === 'comment') return `/projects/${n.project_id}/hardware?comments=open${version ? `&${version}` : ''}`
  // The version opens its builder quote.
  return `/projects/${n.project_id}/hardware${version ? `?${version}` : ''}`
}

/** Header bell: unread count and the latest notifications (refreshed every 30s). */
export function NotificationBell() {
  const { user } = useAuth()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const { byId } = useProfileDirectory()
  const panelRef = useRef<HTMLDivElement | null>(null)

  const notificationsQuery = useQuery({
    queryKey: ['notifications', user?.id],
    enabled: !!user,
    refetchInterval: POLL_MS,
    queryFn: async (): Promise<AppNotification[]> => {
      const { data, error } = await supabase
        .from('notifications')
        .select('id, user_id, project_id, version_id, kind, title, body, actor_id, read_at, created_at')
        .order('created_at', { ascending: false })
        .limit(50)
      if (error) throw error
      return (data ?? []) as AppNotification[]
    },
  })

  const notifications = notificationsQuery.data ?? []
  const unread = notifications.filter((n) => !n.read_at).length

  const markRead = useMutation({
    mutationFn: async (ids: string[] | 'all') => {
      let query = supabase.from('notifications').update({ read_at: new Date().toISOString() })
      query = ids === 'all' ? query.is('read_at', null) : query.in('id', ids)
      const { error } = await query
      if (error) throw error
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['notifications'] }),
  })

  // Close when clicking outside the panel.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  const openNotification = (n: AppNotification) => {
    if (!n.read_at) markRead.mutate([n.id])
    setOpen(false)
    const href = hrefFor(n)
    if (href) navigate(href)
  }

  return (
    <div className="relative" ref={panelRef}>
      <button
        type="button"
        aria-label={unread > 0 ? `Notifications (${unread} unread)` : 'Notifications'}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="relative flex h-8 w-8 cursor-pointer items-center justify-center rounded-md border border-neutral-300 bg-white hover:bg-neutral-50"
      >
        <Bell className="h-4 w-4" />
        {unread > 0 && (
          <span
            data-testid="notification-count"
            className="absolute -right-1.5 -top-1.5 min-w-4 rounded-full bg-neutral-950 px-1 text-center text-[10px] font-bold leading-4 text-white"
          >
            {unread > 9 ? '9+' : unread}
          </span>
        )}
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Notifications"
          className="absolute right-0 z-50 mt-2 w-96 max-w-[90vw] rounded-md border border-neutral-300 bg-white shadow-lg"
        >
          <div className="flex items-center justify-between border-b border-neutral-200 px-3 py-2">
            <span className="text-xs font-semibold uppercase tracking-wider text-neutral-600">
              Notifications
            </span>
            {unread > 0 && (
              <button
                type="button"
                onClick={() => markRead.mutate('all')}
                className="cursor-pointer text-xs font-medium text-neutral-700 hover:underline"
              >
                Mark all read
              </button>
            )}
          </div>
          {notifications.length === 0 ? (
            <div className="px-3 py-6 text-center text-xs text-neutral-500">No notifications yet.</div>
          ) : (
            <ul className="max-h-96 divide-y divide-neutral-100 overflow-y-auto">
              {notifications.map((n) => (
                <li key={n.id}>
                  <button
                    type="button"
                    onClick={() => openNotification(n)}
                    className={`block w-full cursor-pointer px-3 py-2.5 text-left hover:bg-neutral-50 ${
                      n.read_at ? '' : 'bg-neutral-50'
                    }`}
                  >
                    <div className="flex items-start gap-2">
                      {!n.read_at && (
                        <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-neutral-950" aria-label="Unread" />
                      )}
                      <UserAvatar
                        name={n.actor_id ? byId.get(n.actor_id)?.full_name : 'System'}
                        url={n.actor_id ? byId.get(n.actor_id)?.avatar_url : null}
                        size="sm"
                      />
                      <div className="min-w-0">
                        <div className={`text-xs text-neutral-950 ${n.read_at ? '' : 'font-semibold'}`}>
                          {n.title}
                        </div>
                        {n.body && <div className="mt-0.5 text-xs text-neutral-600">{n.body}</div>}
                        <div className="mt-0.5 text-[11px] text-neutral-500">{timeAgo(n.created_at)}</div>
                      </div>
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}
