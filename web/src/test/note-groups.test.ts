import { describe, expect, it } from 'vitest'
import { groupNotes } from '@/features/projects/noteGroups'

describe('groupNotes', () => {
  it("groups one cell's changes under it, with what the lock prep means", () => {
    expect(
      groupNotes([
        'LOCK PREP 25: removed B0435SSS',
        'LOCK PREP 25: added L2 (vestibule lock)',
        'Hinge: LO (Lift Off): MMHINGE → MMHINGELIFTOFF',
        'LOCK PREP 25: added K1A (cylinder)',
        'LOCK PREP 15 means non-lockable, but the Lock column says YES — check the lock',
        'Closer 1 → 2 (priced in the quotation)',
      ]),
    ).toEqual([
      { cause: 'LOCK PREP 25 (lockable)', items: ['removed B0435SSS', 'added L2 (vestibule lock)', 'added K1A (cylinder)'] },
      { cause: 'Hinge', items: ['LO (Lift Off): MMHINGE → MMHINGELIFTOFF'] },
      { cause: 'LOCK PREP 15 (non-lockable)', items: ['means non-lockable, but the Lock column says YES — check the lock'] },
      // No short lead-in: listed last, without a cause.
      { cause: '', items: ['Closer 1 → 2 (priced in the quotation)'] },
    ])
  })

  it('an unconfirmed lock prep value says so', () => {
    expect(groupNotes(['LOCK PREP 30: meaning not confirmed yet — check the lock'])[0].cause).toBe(
      'LOCK PREP 30 (meaning not confirmed)',
    )
  })
})
