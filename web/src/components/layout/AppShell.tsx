import { Suspense } from 'react'
import { Navigate, Outlet } from 'react-router-dom'
import { useAuth } from '@/features/auth/AuthContext'
import { NotificationBell } from '@/features/notifications/NotificationBell'
import { Sidebar } from './Sidebar'

export function AppShell() {
  const { session, isAdmin, loading } = useAuth()

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
    <div className="min-h-screen flex bg-white text-neutral-950">
      <Sidebar isAdmin={isAdmin} />

      {/* Main Content Area */}
      <div className="flex-1 flex flex-col min-w-0">
        <header className="h-14 border-b border-neutral-200 bg-white px-6 flex items-center justify-between">
          <div className="text-xs font-medium uppercase tracking-wider text-neutral-500">
            Mena Hardware
          </div>

          <div className="flex items-center gap-4">
            <NotificationBell />
          </div>
        </header>

        <main className="flex-1 p-6 overflow-auto">
          {/* Pages load on first visit (see App.tsx). */}
          <Suspense
            fallback={
              <div className="p-10 text-center text-sm text-neutral-600">Loading...</div>
            }
          >
            <Outlet />
          </Suspense>
        </main>
      </div>
    </div>
  )
}
