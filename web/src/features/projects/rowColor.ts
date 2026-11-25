/**
 * Row colours in the quotation: doors added in a variation are on green rows,
 * doors taken out (excluded) are on red rows. A fill is
 * either an RGB colour (FF00B050, FF92D050) or a theme colour, whose RGB comes
 * from the workbook's theme (in the 2007 Office theme accent 3 is green; in
 * later ones accent 6 is). A tint only lightens a colour, so the hue decides.
 */

/** Theme colours in Excel's index order: lt1, dk1, lt2, dk2, accent1-6, hlink, folHlink. */
const THEME_ORDER = ['lt1', 'dk1', 'lt2', 'dk2', 'accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6', 'hlink', 'folHlink']

/** The workbook theme's colours by index ("RRGGBB"), from its theme XML. */
export function themeColorsOf(themeXml: string): string[] {
  return THEME_ORDER.map((name) => {
    const m = new RegExp(`<a:${name}>\\s*<a:(?:srgbClr val|sysClr[^>]*?lastClr)="([0-9A-Fa-f]{6})"`).exec(themeXml)
    return m ? m[1].toUpperCase() : ''
  })
}

/** Hue (0-360) and saturation (0-1) of "RRGGBB". */
function hueSat(rgb: string): { hue: number; sat: number } {
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(rgb.slice(i, i + 2), 16) / 255)
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const d = max - min
  if (d === 0) return { hue: 0, sat: 0 }
  const l = (max + min) / 2
  const sat = d / (1 - Math.abs(2 * l - 1))
  let hue = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4
  hue *= 60
  if (hue < 0) hue += 360
  return { hue, sat }
}

/** Is this RGB green (not yellow, not teal / blue)? */
export function isGreenRgb(rgb: string): boolean {
  if (!/^[0-9A-Fa-f]{6}$/.test(rgb)) return false
  const { hue, sat } = hueSat(rgb)
  return sat >= 0.25 && hue >= 70 && hue <= 170
}

/** Is this RGB red (not orange, not pink-purple)? */
export function isRedRgb(rgb: string): boolean {
  if (!/^[0-9A-Fa-f]{6}$/.test(rgb)) return false
  const { hue, sat } = hueSat(rgb)
  return sat >= 0.4 && (hue <= 12 || hue >= 345)
}

/** Is this RGB blue? */
export function isBlueRgb(rgb: string): boolean {
  if (!/^[0-9A-Fa-f]{6}$/.test(rgb)) return false
  const { hue, sat } = hueSat(rgb)
  return sat >= 0.3 && hue >= 185 && hue <= 260
}

interface ColorLike { argb?: string; theme?: number }
interface FontCell {
  font?: { color?: ColorLike }
  value?: unknown
}

/**
 * A comment cell's text colour: 'blue', 'red' or null (black / anything else).
 * Rich text takes its first coloured run.
 */
export function fontColorOf(cell: unknown, themeColors: string[]): 'blue' | 'red' | null {
  const c = cell as FontCell | undefined
  const rgbOf = (col?: ColorLike) =>
    col?.argb ? col.argb.slice(-6) : col?.theme !== undefined ? themeColors[col.theme] ?? '' : ''
  const runs = (c?.value as { richText?: Array<{ font?: { color?: ColorLike } }> } | null)?.richText
  const rgb = runs?.map((r) => rgbOf(r.font?.color)).find(Boolean) || rgbOf(c?.font?.color)
  return isBlueRgb(rgb) ? 'blue' : isRedRgb(rgb) ? 'red' : null
}

interface FillLike {
  type?: string
  pattern?: string
  fgColor?: { argb?: string; theme?: number; tint?: number }
}

/** A cell's fill colour as "RRGGBB" ('' when none). */
function fillRgb(fill: unknown, themeColors: string[]): string {
  const f = fill as FillLike | undefined
  if (!f || f.type !== 'pattern' || !f.pattern || f.pattern === 'none' || !f.fgColor) return ''
  const { argb, theme } = f.fgColor
  if (argb) return argb.slice(-6)
  if (theme !== undefined) return themeColors[theme] ?? ''
  return ''
}

/** Is a cell's fill green? */
export function isGreenFill(fill: unknown, themeColors: string[]): boolean {
  return isGreenRgb(fillRgb(fill, themeColors))
}

/** Is a cell's fill red? A theme red lightened a lot is pink, not a red highlight. */
export function isRedFill(fill: unknown, themeColors: string[]): boolean {
  const tint = (fill as FillLike | undefined)?.fgColor?.tint ?? 0
  return tint < 0.4 && isRedRgb(fillRgb(fill, themeColors))
}
