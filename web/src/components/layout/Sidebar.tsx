import { useState } from 'react'
import { NavLink } from 'react-router-dom'
import {
  Boxes,
  Building2,
  FolderKanban,
  KeyRound,
  Layers,
  PanelLeftClose,
  PanelLeftOpen,
  Users,
} from 'lucide-react'

import type { UserRole } from '@/types/database'

interface SidebarProps {
  isAdmin: boolean
  role?: UserRole
}

export function Sidebar({ isAdmin, role = isAdmin ? 'admin' : 'viewer' }: SidebarProps) {
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    return localStorage.getItem('mena_sidebar_collapsed') === 'true'
  })

  const toggleCollapsed = () => {
    setCollapsed((prev) => {
      const next = !prev
      localStorage.setItem('mena_sidebar_collapsed', String(next))
      return next
    })
  }

  const navItems = [
    { to: '/projects', label: 'Projects', icon: FolderKanban },
    { to: '/parts', label: 'Parts Library', icon: Boxes },
    { to: '/standard-sets', label: 'Standard Sets', icon: Layers },
    { to: '/manufacturers', label: 'Manufacturers', icon: Building2 },
    ...(isAdmin ? [{ to: '/users', label: 'Users & Roles', icon: Users }] : []),
  ]

  return (
    <aside
      className={`${
        collapsed ? 'w-16' : 'w-60'
      } sticky top-0 h-screen shrink-0 border-r border-neutral-200 bg-neutral-50 flex flex-col justify-between transition-[width] duration-150`}
    >
      <div className="flex flex-col min-h-0">
        <div
          className={`h-14 border-b border-neutral-200 flex items-center ${
            collapsed ? 'justify-center px-2' : 'justify-between px-4'
          }`}
        >
          {!collapsed && (
            <div className="flex items-center gap-2.5 min-w-0">
              <div className="flex h-7 w-7 shrink-0 items-center justify-center border border-neutral-950 bg-neutral-950 text-white">
                <KeyRound className="h-3.5 w-3.5" />
              </div>
              <div className="truncate">
                <div className="text-sm font-bold tracking-tight text-neutral-950 leading-none">
                  MENA HARDWARE
                </div>
                <div className="text-[11px] text-neutral-500 mt-0.5">
                  Door Hardware System
                </div>
              </div>
            </div>
          )}

          <button
            type="button"
            onClick={toggleCollapsed}
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-sm text-neutral-600 hover:bg-neutral-200/70 hover:text-neutral-950 transition-colors cursor-pointer"
          >
            {collapsed ? (
              <PanelLeftOpen className="h-4 w-4" />
            ) : (
              <PanelLeftClose className="h-4 w-4" />
            )}
          </button>
        </div>

        <nav className="p-3 space-y-1 overflow-y-auto" aria-label="Main navigation">
          {navItems.map((item) => {
            const Icon = item.icon
            return (
              <NavLink
                key={item.to}
                to={item.to}
                title={collapsed ? item.label : undefined}
                className={({ isActive }) =>
                  `flex items-center ${
                    collapsed ? 'justify-center px-2' : 'gap-2.5 px-3'
                  } py-2 text-sm font-medium rounded-sm transition-colors ${
                    isActive
                      ? 'bg-neutral-950 text-white'
                      : 'text-neutral-700 hover:bg-neutral-200/70 hover:text-neutral-950'
                  }`
                }
              >
                <Icon className="h-4 w-4 shrink-0" />
                {!collapsed && <span className="truncate">{item.label}</span>}
              </NavLink>
            )
          })}
        </nav>
      </div>

      <div
        className={`border-t border-neutral-200 text-xs text-neutral-500 ${
          collapsed ? 'p-3 text-center' : 'p-4'
        }`}
        title={
          isAdmin
            ? 'Full administrative read/write access'
            : 'Read-only library & sets access'
        }
      >
        {collapsed ? (
          <div className="font-mono text-[10px] font-bold uppercase text-neutral-800">
            {role === 'admin'
              ? 'ADM'
              : role === 'estimator'
                ? 'HW'
                : role === 'pm'
                  ? 'PM'
                  : 'RO'}
          </div>
        ) : (
          <>
            <div className="font-semibold text-neutral-800">Access Mode</div>
            <div className="mt-0.5">
              {role === 'admin' && 'Full administrative read/write access'}
              {role === 'estimator' &&
                'Hardware Team: create & edit draft projects'}
              {role === 'pm' && 'PM: review, remarks & project approvals'}
              {role === 'viewer' && 'Read-only access'}
            </div>
          </>
        )}
      </div>
    </aside>
  )
}
