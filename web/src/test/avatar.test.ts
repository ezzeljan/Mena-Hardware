import { describe, it, expect } from 'vitest'
import { initialsFor } from '@/lib/avatar'

describe('initialsFor', () => {
  it('uses first and last word of the name', () => {
    expect(initialsFor('Mark Lim')).toBe('ML')
    expect(initialsFor('  anna  maria  de souza ')).toBe('AS')
  })
  it('uses the first two letters of a single name', () => {
    expect(initialsFor('louiz')).toBe('LO')
  })
  it('falls back to the email, then "?"', () => {
    expect(initialsFor('', 'erin.tan@mena.com')).toBe('ET')
    expect(initialsFor(null, null)).toBe('?')
  })
})
