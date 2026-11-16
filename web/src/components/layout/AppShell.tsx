import { Navigate, NavLink, Outlet } from 'react-router-dom'
import {
  Boxes,
  Building2,
  KeyRound,
  Layers,
  LogOut,
  Users,
} from 'lucide-react'
import { useAuth } from '@/features/auth/AuthContext'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'

export function AppShell() {
  const { session, user, profile, role, isAdmin, loading, signOut } = useAuth()

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-white text-neutral-950">
        <div className="flex flex-col items-center gap-2">
          <div className="h-5 w-5 animate-spin rounded-full border-2 border-neutral-950 border-t-transparent" />
          <p className="text-xs font-medium uppercase tracking-wider text-neutral-600">
            Loading workspace...
          </p>
        </div>
      </div>
    )
  }

  if (!session) {
    return <Navigate to="/login" replace />
  }

  const displayName =
    profile?.full_name?.trim() || user?.email || 'Authenticated User'

  const navItems = [
    { to: '/parts', label: 'Parts Library', icon: Boxes },
    { to: '/standard-sets', label: 'Standard Sets', icon: Layers },
    { to: '/manufacturers', label: 'Manufacturers', icon: Building2 },
    ...(isAdmin ? [{ to: '/users', label: 'Users & Roles', icon: Users }] : []),
  ]

  return (
    <div className="min-h-screen flex bg-white text-neutral-950">
      {/* Sidebar */}
      <aside className="w-60 shrink-0 border-r border-neutral-200 bg-neutral-50 flex flex-col justify-between">
        <div>
          <div className="h-14 px-4 border-b border-neutral-200 flex items-center gap-2.5">
            <div className="flex h-7 w-7 items-center justify-center border border-neutral-950 bg-neutral-950 text-white">
              <KeyRound className="h-3.5 w-3.5" />
            </div>
            <div>
              <div className="text-sm font-bold tracking-tight text-neutral-950 leading-none">
                MENA HARDWARE
              </div>
              <div className="text-[11px] text-neutral-500 mt-0.5">
                Door Hardware System
              </div>
            </div>
          </div>

          <nav className="p-3 space-y-1" aria-label="Main navigation">
            {navItems.map((item) => {
              const Icon = item.icon
              return (
                <NavLink
                  key={item.to}
                  to={item.to}
                  className={({ isActive }) =>
                    `flex items-center gap-2.5 px-3 py-2 text-sm font-medium rounded-sm transition-colors ${
                      isActive
                        ? 'bg-neutral-950 text-white'
                        : 'text-neutral-700 hover:bg-neutral-200/70 hover:text-neutral-950'
                    }`
                  }
                >
                  <Icon className="h-4 w-4 shrink-0" />
                  <span>{item.label}</span>
                </NavLink>
              )
            })}
          </nav>
        </div>

        <div className="p-4 border-t border-neutral-200 text-xs text-neutral-500">
          <div className="font-semibold text-neutral-800">Access Mode</div>
          <div className="mt-0.5">
            {isAdmin
              ? 'Full administrative read/write access'
              : 'Read-only library & sets access'}
          </div>
        </div>
      </aside>

      {/* Main Content Area */}
      <div className="flex-1 flex flex-col min-w-0">
        <header className="h-14 border-b border-neutral-200 bg-white px-6 flex items-center justify-between">
          <div className="text-xs font-medium uppercase tracking-wider text-neutral-500">
            Hardware Pricing Foundation
          </div>

          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2.5 text-sm">
              <span className="font-medium text-neutral-900" data-testid="header-user-name">
                {displayName}
              </span>
              <Badge
                variant={isAdmin ? 'default' : 'secondary'}
                className="uppercase tracking-wider text-[10px]"
                data-testid="header-user-role"
              >
                {role}
              </Badge>
            </div>

            <Button
              variant="outline"
              size="sm"
              onClick={() => void signOut()}
              title="Sign out"
            >
              <LogOut className="h-3.5 w-3.5" />
              <span>Sign Out</span>
            </Button>
          </div>
        </header>

        <main className="flex-1 p-6 overflow-auto">
          <Outlet />
        </main>
      </div>
    </div>
  )
}
