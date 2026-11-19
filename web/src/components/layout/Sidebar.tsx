import { Boxes, Building2, FolderKanban, KeyRound, Layers, LayoutDashboard, Users } from 'lucide-react'
import { Link } from 'react-router-dom'

import { SideDock, type DockNavItem } from '@/components/shadcn-space/apple-dock/apple-dock-05'
import { UserMenu } from './UserMenu'

interface SidebarProps {
  isAdmin: boolean
}

/**
 * Slim icon rail: logo mark, the navigation dock (icons magnify on hover,
 * labels appear to the right) and the account menu at the bottom.
 */
export function Sidebar({ isAdmin }: SidebarProps) {
  const navItems: DockNavItem[] = [
    { to: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
    { to: '/projects', label: 'Projects', icon: FolderKanban },
    { to: '/parts', label: 'Parts Library', icon: Boxes },
    { to: '/standard-sets', label: 'Standard Sets', icon: Layers },
    { to: '/suppliers', label: 'Suppliers', icon: Building2 },
    ...(isAdmin ? [{ to: '/users', label: 'Users & Roles', icon: Users }] : []),
  ]

  return (
    <aside className="sticky top-0 z-40 flex h-screen w-24 shrink-0 flex-col justify-between border-r border-neutral-200 bg-neutral-50">
      <div className="flex min-h-0 flex-col items-center">
        <div className="flex h-14 w-full items-center justify-center border-b border-neutral-200">
          <Link
            to="/dashboard"
            aria-label="Mena Hardware — Door Hardware System"
            title="Mena Hardware — Door Hardware System"
            className="flex h-8 w-8 items-center justify-center border border-neutral-950 bg-neutral-950 text-white"
          >
            <KeyRound className="h-4 w-4" />
          </Link>
        </div>

        <div className="pt-3">
          <SideDock items={navItems} />
        </div>
      </div>

      <div className="border-t border-neutral-200 p-2">
        <UserMenu collapsed />
      </div>
    </aside>
  )
}
