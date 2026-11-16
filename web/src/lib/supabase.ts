import { createClient } from '@supabase/supabase-js'

const supabaseUrl =
  import.meta.env.VITE_SUPABASE_URL || 'http://127.0.0.1:54321'
const supabaseAnonKey =
  import.meta.env.VITE_SUPABASE_ANON_KEY || 'public-anon-placeholder-key'

/**
 * Browser Supabase client using ONLY the public anon key.
 * All access control is enforced by Postgres Row Level Security (RLS).
 */
export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
  },
})
