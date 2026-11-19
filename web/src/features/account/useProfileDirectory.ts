import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import type { DirectoryProfile } from '@/types/database'

/**
 * Everyone's name, role and photo (profile_directory, readable by any signed-in
 * user). Cached for a few minutes and shared by every screen that shows people.
 */
export function useProfileDirectory() {
  const query = useQuery({
    queryKey: ['profile_directory', 'all'],
    staleTime: 5 * 60 * 1000,
    queryFn: async (): Promise<DirectoryProfile[]> => {
      const { data, error } = await supabase
        .from('profile_directory')
        .select('id, full_name, role, avatar_url')
        .order('full_name', { ascending: true })
      if (error) throw error
      return (data ?? []) as DirectoryProfile[]
    },
  })
  const people = useMemo(() => query.data ?? [], [query.data])
  const byId = useMemo(() => new Map(people.map((p) => [p.id, p])), [people])
  return { ...query, people, byId }
}
