import type { PostgrestError } from '@supabase/supabase-js'

/**
 * PostgREST caps every response at `max_rows` (1000 in supabase/config.toml and
 * on hosted Supabase) and silently drops the rest. Use this for any select that
 * can grow past that so results are never truncated.
 *
 * `buildPage(from, to)` must return the query with `.range(from, to)` applied and
 * a deterministic order that ends in a unique column (e.g. `.order('id')`),
 * otherwise rows can repeat or be skipped between pages.
 *
 * `pageSize` must not be larger than the server's `max_rows`: a page shorter
 * than `pageSize` is taken to be the last one.
 */
export async function fetchAllRows<T>(
  buildPage: (
    from: number,
    to: number,
  ) => PromiseLike<{ data: unknown[] | null; error: PostgrestError | null }>,
  pageSize = 1000,
): Promise<T[]> {
  const rows: T[] = []
  let from = 0
  for (;;) {
    const { data, error } = await buildPage(from, from + pageSize - 1)
    if (error) throw error
    const page = (data ?? []) as T[]
    rows.push(...page)
    // A short (or empty) page is the last one. Stopping here also avoids an
    // endless loop if something in between ignores the range.
    if (page.length < pageSize) return rows
    from += pageSize
  }
}
