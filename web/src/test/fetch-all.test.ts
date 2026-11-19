import { describe, it, expect, vi } from 'vitest'
import { fetchAllRows } from '@/lib/fetchAll'

describe('fetchAllRows', () => {
  it('stops after a short page (one request when everything fits)', async () => {
    const buildPage = vi.fn(async () => ({ data: [1, 2, 3], error: null }))
    const rows = await fetchAllRows<number>(buildPage, 10)
    expect(rows).toEqual([1, 2, 3])
    expect(buildPage).toHaveBeenCalledTimes(1)
  })

  it('pages through full pages until a short one', async () => {
    const all = Array.from({ length: 25 }, (_, i) => i)
    const buildPage = vi.fn(async (from: number, to: number) => ({
      data: all.slice(from, to + 1),
      error: null,
    }))
    const rows = await fetchAllRows<number>(buildPage, 10)
    expect(rows).toEqual(all)
    expect(buildPage.mock.calls).toEqual([
      [0, 9],
      [10, 19],
      [20, 29],
    ])
  })

  it('makes one extra request when the total is an exact multiple of the page size', async () => {
    const all = Array.from({ length: 20 }, (_, i) => i)
    const buildPage = vi.fn(async (from: number, to: number) => ({
      data: all.slice(from, to + 1),
      error: null,
    }))
    const rows = await fetchAllRows<number>(buildPage, 10)
    expect(rows).toEqual(all)
    expect(buildPage).toHaveBeenCalledTimes(3)
  })

  it('throws the query error', async () => {
    const err = { message: 'boom', details: '', hint: '', code: 'XX000', name: 'PostgrestError' }
    await expect(
      fetchAllRows(async () => ({ data: null, error: err as never }), 10),
    ).rejects.toMatchObject({ message: 'boom' })
  })
})
