/** 9/9/2026 (month/day/year, no leading zeros), as on the hardware schedules. */
export function formatScheduleDate(d: Date | undefined): string {
  return d ? `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}` : ''
}

const pad = (n: number) => String(n).padStart(2, '0')

/** Remember a picked day as a local date ("2026-09-09"), so it never shifts by time zone. */
export function serializeScheduleDate(d: Date | undefined): string {
  return d ? `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` : ''
}

export function parseScheduleDate(raw: string | null): Date | undefined {
  if (!raw || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return undefined
  const [y, m, d] = raw.split('-').map(Number)
  return new Date(y, m - 1, d)
}
