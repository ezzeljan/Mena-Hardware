import { Navigate, Outlet } from 'react-router-dom'
import { LogOut } from 'lucide-react'
import { useAuth } from '@/features/auth/AuthContext'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Sidebar } from './Sidebar'

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

  return (
    <div className="min-h-screen flex bg-white text-neutral-950">
      <Sidebar isAdmin={isAdmin} />

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
