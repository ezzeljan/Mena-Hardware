import { useState } from 'react'
import { Navigate } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, Pencil, Users, X } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { TableSkeleton } from '@/components/ui/skeleton'
import { useAuth } from '@/features/auth/AuthContext'
import { updateUserRoleSchema } from '@/lib/schemas'
import type { Profile, UserRole } from '@/types/database'
import { UserAvatar } from '@/components/avatar/UserAvatar'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
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
  // Admin rename (photos can only be changed by the user, on My Account).
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')

  const profilesQuery = useQuery({
    queryKey: ['profiles'],
    enabled: isAdmin,
    queryFn: async (): Promise<Profile[]> => {
      const { data, error } = await supabase
        .from('profiles')
        .select('id, full_name, email, role, avatar_url, created_at')
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

  const renameMutation = useMutation({
    mutationFn: async (input: { userId: string; fullName: string }) => {
      const fullName = input.fullName.trim()
      if (!fullName) throw new Error('Name is required.')
      const { error } = await supabase
        .from('profiles')
        .update({ full_name: fullName })
        .eq('id', input.userId)
      if (error) throw error
    },
    onSuccess: async (_data, variables) => {
      setActionError(null)
      setRenamingId(null)
      await queryClient.invalidateQueries({ queryKey: ['profiles'] })
      await queryClient.invalidateQueries({ queryKey: ['profile_directory'] })
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
            Manage team member roles.
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
          Failed to update user: {actionError}
        </div>
      )}

      {profilesQuery.isLoading ? (
        <TableSkeleton rows={6} columns={4} label="Loading users…" />
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
                    {renamingId === p.id ? (
                      <form
                        className="flex items-center gap-1.5"
                        onSubmit={(e) => {
                          e.preventDefault()
                          renameMutation.mutate({ userId: p.id, fullName: renameValue })
                        }}
                      >
                        <UserAvatar name={renameValue || p.full_name} email={p.email} url={p.avatar_url} size="sm" />
                        <Input
                          autoFocus
                          aria-label={`New name for ${p.full_name || p.email}`}
                          value={renameValue}
                          maxLength={120}
                          onChange={(e) => setRenameValue(e.target.value)}
                          className="h-7 w-44 text-sm"
                        />
                        <button
                          type="submit"
                          aria-label="Save name"
                          disabled={renameMutation.isPending}
                          className="cursor-pointer p-1 text-neutral-700 hover:text-neutral-950 disabled:opacity-50"
                        >
                          <Check className="h-4 w-4" />
                        </button>
                        <button
                          type="button"
                          aria-label="Cancel rename"
                          onClick={() => setRenamingId(null)}
                          className="cursor-pointer p-1 text-neutral-500 hover:text-neutral-950"
                        >
                          <X className="h-4 w-4" />
                        </button>
                      </form>
                    ) : (
                      <div className="flex items-center gap-2.5">
                        <UserAvatar name={p.full_name} email={p.email} url={p.avatar_url} size="md" />
                        <span>{p.full_name || 'Unnamed User'}</span>
                        {isSelf && <span className="text-xs text-neutral-500">(You)</span>}
                        <button
                          type="button"
                          aria-label={`Rename ${p.full_name || p.email}`}
                          title="Rename"
                          onClick={() => {
                            setRenameValue(p.full_name ?? '')
                            setRenamingId(p.id)
                          }}
                          className="cursor-pointer p-1 text-neutral-400 hover:text-neutral-950"
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </button>
                      </div>
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
    </div>
  )
}
