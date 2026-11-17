import { useState } from 'react'
import { Navigate } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Shield, Users } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/features/auth/AuthContext'
import { updateUserRoleSchema } from '@/lib/schemas'
import type { Profile, UserRole } from '@/types/database'
import { Badge } from '@/components/ui/badge'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'

const ROLES: UserRole[] = ['admin', 'estimator', 'pm', 'viewer']

export function UsersPage() {
  const { isAdmin, user: currentUser, refreshProfile } = useAuth()
  const queryClient = useQueryClient()
  const [actionError, setActionError] = useState<string | null>(null)

  const profilesQuery = useQuery({
    queryKey: ['profiles'],
    enabled: isAdmin,
    queryFn: async (): Promise<Profile[]> => {
      const { data, error } = await supabase
        .from('profiles')
        .select('id, full_name, email, role, created_at')
        .order('created_at', { ascending: true })
      if (error) throw error
      return (data ?? []) as Profile[]
    },
  })

  const updateRoleMutation = useMutation({
    mutationFn: async (input: { userId: string; role: UserRole }) => {
      const parsed = updateUserRoleSchema.parse(input)
      const { error } = await supabase
        .from('profiles')
        .update({ role: parsed.role })
        .eq('id', parsed.userId)
      if (error) throw error
    },
    onSuccess: async (_data, variables) => {
      setActionError(null)
      await queryClient.invalidateQueries({ queryKey: ['profiles'] })
      if (variables.userId === currentUser?.id) {
        await refreshProfile()
      }
    },
    onError: (err: Error) => {
      setActionError(err.message)
    },
  })

  if (!isAdmin) {
    return <Navigate to="/parts" replace />
  }

  return (
    <div className="space-y-6 max-w-5xl">
      <div className="flex items-center justify-between border-b border-neutral-200 pb-4">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-neutral-950 flex items-center gap-2">
            <Users className="h-5 w-5" />
            <span>Users &amp; Roles</span>
          </h1>
          <p className="text-sm text-neutral-600 mt-0.5">
            Manage team member roles. Only administrators can view all profiles and assign roles.
          </p>
        </div>
        <Badge variant="default" className="uppercase tracking-wider">
          Admin Only
        </Badge>
      </div>

      {actionError && (
        <div
          role="alert"
          className="border border-neutral-950 bg-neutral-100 p-3 text-xs font-medium text-neutral-950"
        >
          Failed to update role: {actionError}
        </div>
      )}

      {profilesQuery.isLoading ? (
        <div className="border border-neutral-200 p-8 text-center text-sm text-neutral-600">
          Loading users...
        </div>
      ) : profilesQuery.isError ? (
        <div
          role="alert"
          className="border border-neutral-950 bg-neutral-50 p-6 text-sm text-neutral-950"
        >
          Error loading users: {(profilesQuery.error as Error).message}
        </div>
      ) : (profilesQuery.data?.length ?? 0) === 0 ? (
        <div className="border border-neutral-200 p-8 text-center text-sm text-neutral-600">
          No user profiles found.
        </div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Full Name</TableHead>
              <TableHead>Email</TableHead>
              <TableHead>Current Role</TableHead>
              <TableHead>Created</TableHead>
              <TableHead className="text-right">Change Role</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {profilesQuery.data?.map((p) => {
              const isSelf = p.id === currentUser?.id
              return (
                <TableRow key={p.id}>
                  <TableCell className="font-medium">
                    {p.full_name || 'Unnamed User'}
                    {isSelf && (
                      <span className="ml-2 text-xs text-neutral-500">(You)</span>
                    )}
                  </TableCell>
                  <TableCell className="text-xs text-neutral-700">
                    {p.email || <span className="font-mono text-neutral-400">{p.id}</span>}
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant={p.role === 'admin' ? 'default' : 'secondary'}
                      className="uppercase tracking-wider text-[10px]"
                    >
                      {p.role}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-xs text-neutral-600">
                    {new Date(p.created_at).toLocaleDateString()}
                  </TableCell>
                  <TableCell className="text-right">
                    <select
                      aria-label={`Change role for ${p.full_name || p.id}`}
                      value={p.role}
                      disabled={isSelf || updateRoleMutation.isPending}
                      title={isSelf ? 'You cannot change your own role' : undefined}
                      onChange={(e) => {
                        const nextRole = e.target.value as UserRole
                        updateRoleMutation.mutate({
                          userId: p.id,
                          role: nextRole,
                        })
                      }}
                      className="h-8 rounded-md border border-neutral-300 bg-white px-2.5 text-xs font-medium text-neutral-950 focus:outline-none focus:ring-2 focus:ring-neutral-950 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {ROLES.map((r) => (
                        <option key={r} value={r}>
                          {r.toUpperCase()}
                        </option>
                      ))}
                    </select>
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      )}

      <div className="border border-neutral-200 bg-neutral-50 p-4 text-xs text-neutral-700 flex items-start gap-2.5">
        <Shield className="h-4 w-4 shrink-0 mt-0.5 text-neutral-900" />
        <div>
          <span className="font-semibold text-neutral-950">Role Permissions Summary: </span>
          <strong>admin</strong> has full read/write control over users, roles, manufacturers, parts, prices, and standard sets.{' '}
          <strong>estimator</strong>, <strong>pm</strong>, and <strong>viewer</strong> have read-only access to the library and standard sets, enforced by Postgres Row Level Security.
        </div>
      </div>
    </div>
  )
}
