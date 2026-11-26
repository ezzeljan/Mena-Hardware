import { describe, expect, it } from 'vitest'
import { buildGroupQuoteInfo, combineGroupQuoteInfo, readGroupQuoteInfo } from '@/features/projects/groupQuoteInfo'

describe('buildGroupQuoteInfo', () => {
  it("keeps the group's doors, hardware, used headers, comments and notes", () => {
    const info = buildGroupQuoteInfo(
      { hardware: 'Hinge: LO · Lock · Prep: Stop · Lock prep: 25', prep_values: { 'Lock prep': '25' } },
      [
        { door_ref: 'D-01', schedule_comments: 'Paint grade', comment_colors: { 'Paint grade': 'blue' } },
        { door_ref: 'D-01' },
        { door_ref: ' D-02 ', mena_comments: 'Check frame' },
      ],
      [['Hinge', 'Hinge'], ['Lock', 'Lockable'], ['Closer', 'Self Closing']],
      ['LOCK PREP 25: added L2 (vestibule lock)'],
    )
    expect(info).toEqual({
      doors: ['D-01', 'D-02'],
      hardware: 'Hinge: LO · Lock · Prep: Stop · Lock prep: 25',
      // Closer isn't in this group's hardware.
      headers: [['Hinge', 'Hinge'], ['Lock', 'Lockable']],
      prep_values: { 'Lock prep': '25' },
      comments: [
        { schedule_comments: 'Paint grade', mena_comments: undefined, comment_colors: { 'Paint grade': 'blue' } },
        { schedule_comments: undefined, mena_comments: 'Check frame', comment_colors: undefined },
      ],
      notes: ['LOCK PREP 25: added L2 (vestibule lock)'],
    })
  })

  it('reads saved rows, with defaults for missing parts', () => {
    expect(readGroupQuoteInfo(null)).toBeNull()
    expect(readGroupQuoteInfo({ hardware: 'Hinge: BH' })).toEqual({
      doors: [], hardware: 'Hinge: BH', headers: [], prep_values: {}, comments: [], notes: [],
    })
  })
})

describe('combineGroupQuoteInfo', () => {
  const base = { hardware: '', headers: [] as Array<[string, string]>, prep_values: {}, comments: [], notes: [] }
  it("a merged group's details: every door, comment and note once; the first group's hardware", () => {
    expect(
      combineGroupQuoteInfo([
        { ...base, doors: ['D-02'], hardware: 'Hinge: BH', headers: [['Hinge', 'Hinge']], notes: ['Hinge: BH', 'Stop: added DS'] },
        { ...base, doors: ['D-03', 'D-02'], hardware: 'Lock', headers: [['Hinge', 'Hinge'], ['Lock', 'Lockable']], notes: ['Stop: added DS'], comments: [{ mena_comments: 'Check' }] },
      ]),
    ).toEqual({
      doors: ['D-02', 'D-03'],
      hardware: 'Hinge: BH',
      headers: [['Hinge', 'Hinge'], ['Lock', 'Lockable']],
      prep_values: {},
      comments: [{ mena_comments: 'Check' }],
      notes: ['Hinge: BH', 'Stop: added DS'],
    })
    expect(combineGroupQuoteInfo([])).toBeNull()
  })
})
