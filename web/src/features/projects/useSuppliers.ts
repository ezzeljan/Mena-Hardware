import { useQuery } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import type { Supplier } from '@/types/database'

export type SupplierOption = Pick<Supplier, 'id' | 'name' | 'is_owner_supplied'>

/** All suppliers (id, name), by name. For sheet and award pickers. */
export function useSupplierOptions(enabled = true) {
  return useQuery({
    queryKey: ['suppliers', 'options'],
    enabled,
    queryFn: async (): Promise<SupplierOption[]> => {
      const { data, error } = await supabase
        .from('suppliers')
        .select('id, name, is_owner_supplied')
        .order('name', { ascending: true })
      if (error) throw error
      return (data ?? []) as SupplierOption[]
    },
  })
}
