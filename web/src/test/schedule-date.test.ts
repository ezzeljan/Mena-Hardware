import { describe, it, expect } from 'vitest'
import { formatScheduleDate, parseScheduleDate, serializeScheduleDate } from '@/lib/scheduleDate'

describe('schedule date', () => {
  it('formats like the schedules (M/D/YYYY, no leading zeros)', () => {
    expect(formatScheduleDate(new Date(2026, 8, 9))).toBe('9/9/2026')
    expect(formatScheduleDate(new Date(2026, 10, 23))).toBe('11/23/2026')
    expect(formatScheduleDate(undefined)).toBe('')
  })

  it('round-trips the remembered date without shifting the day', () => {
    const back = parseScheduleDate(serializeScheduleDate(new Date(2026, 10, 23)))
    expect(formatScheduleDate(back)).toBe('11/23/2026')
    expect(parseScheduleDate('not a date')).toBeUndefined()
    expect(parseScheduleDate(null)).toBeUndefined()
  })
})
