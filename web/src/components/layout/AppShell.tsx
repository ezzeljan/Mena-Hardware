import { Suspense } from 'react'
import { Navigate, Outlet, useLocation } from 'react-router-dom'
import { useAuth } from '@/features/auth/AuthContext'
import { PageSkeleton } from '@/components/ui/skeleton'
import { NotificationBell } from '@/features/notifications/NotificationBell'
import { Sidebar } from './Sidebar'

export function AppShell() {
  const { session, isAdmin, loading } = useAuth()
  const { pathname } = useLocation()

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

  return (
    // Fits the screen: only the page area scrolls, so the header stays put and
    // sticky parts of a page (like the hardware grid's bottom bar) stick to the screen.
    // h-dvh: the visible height, also on mobile browsers with toolbars.
    <div className="h-dvh flex overflow-hidden bg-white text-neutral-950">
      <Sidebar isAdmin={isAdmin} />

      {/* Main Content Area */}
      <div className="flex-1 flex flex-col min-w-0 min-h-0">
        <header className="h-14 border-b border-neutral-200 bg-white px-6 flex items-center justify-between">
          <div className="text-xs font-medium uppercase tracking-wider text-neutral-500">
            Mena Hardware
          </div>

          <div className="flex items-center gap-4">
            <NotificationBell />
          </div>
        </header>

        {/* --page-pad is the padding; sticky page parts offset by it (e.g. the grid's bottom bar). */}
        <main className="flex-1 min-h-0 overflow-auto p-[var(--page-pad)] [--page-pad:1.5rem]">
          {/* Pages load on first visit (see App.tsx). */}
          <Suspense
            fallback={<PageSkeleton path={pathname} />}
          >
            <Outlet />
          </Suspense>
        </main>
      </div>
    </div>
  )
}
