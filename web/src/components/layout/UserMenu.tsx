import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { LogOut, UserRound } from 'lucide-react'
import { useAuth } from '@/features/auth/AuthContext'
import { UserAvatar } from '@/components/avatar/UserAvatar'
import { Badge } from '@/components/ui/badge'

interface UserMenuProps {
  /** Sidebar collapsed: show the avatar only. */
  collapsed?: boolean
}

/**
 * Account control at the bottom of the sidebar: avatar (plus name and role when
 * the sidebar is expanded). Opens a menu upward with My Account and Sign out.
 */
export function UserMenu({ collapsed = false }: UserMenuProps) {
  const { user, profile, role, isAdmin, signOut } = useAuth()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement | null>(null)
  const displayName = profile?.full_name?.trim() || user?.email || 'Authenticated User'

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        aria-label="Account menu"
        aria-expanded={open}
        title={collapsed ? displayName : undefined}
        onClick={() => setOpen((o) => !o)}
        className={`flex w-full cursor-pointer items-center rounded-sm text-left transition-colors hover:bg-neutral-200/70 focus:outline-none focus:ring-2 focus:ring-neutral-950 ${
          collapsed ? 'justify-center p-1.5' : 'gap-2.5 p-2'
        }`}
      >
        <UserAvatar name={profile?.full_name} email={profile?.email || user?.email} url={profile?.avatar_url} size="md" />
        {!collapsed && (
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-semibold text-neutral-950">{displayName}</span>
            <span className="block text-[10px] font-semibold uppercase tracking-wider text-neutral-500">
              {role}
            </span>
          </span>
        )}
      </button>

      {open && (
        <div
          role="menu"
          className={`absolute bottom-full z-50 mb-2 w-64 rounded-md border border-neutral-300 bg-white shadow-lg ${
            collapsed ? 'left-0' : 'left-0 right-0 w-auto'
          }`}
        >
          <div className="flex items-center gap-3 border-b border-neutral-200 px-3 py-3">
            <UserAvatar name={profile?.full_name} email={profile?.email || user?.email} url={profile?.avatar_url} size="md" />
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold text-neutral-950" data-testid="header-user-name">
                {displayName}
              </div>
              <div className="truncate text-xs text-neutral-600">{profile?.email || user?.email}</div>
              <Badge
                variant={isAdmin ? 'default' : 'secondary'}
                className="mt-1 uppercase tracking-wider text-[10px]"
                data-testid="header-user-role"
              >
                {role}
              </Badge>
            </div>
          </div>
          <div className="p-1">
            <Link
              to="/account"
              role="menuitem"
              onClick={() => setOpen(false)}
              className="flex items-center gap-2 rounded px-2.5 py-2 text-sm text-neutral-950 hover:bg-neutral-50"
            >
              <UserRound className="h-4 w-4" />
              <span>My Account</span>
            </Link>
            <button
              type="button"
              role="menuitem"
              onClick={() => void signOut()}
              className="flex w-full cursor-pointer items-center gap-2 rounded px-2.5 py-2 text-left text-sm text-neutral-950 hover:bg-neutral-50"
            >
              <LogOut className="h-4 w-4" />
              <span>Sign out</span>
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
