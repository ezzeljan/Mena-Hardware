/** "Mark Lim" -> "ML", "louiz" -> "LO", "" -> "?" (falls back to the email). */
export function initialsFor(name: string | null | undefined, email?: string | null): string {
  const source = (name ?? '').trim() || (email ?? '').split('@')[0].trim()
  if (!source) return '?'
  const words = source.split(/[\s._-]+/).filter(Boolean)
  if (words.length >= 2) return (words[0][0] + words[words.length - 1][0]).toUpperCase()
  return source.slice(0, 2).toUpperCase()
}

export const AVATAR_SIZE_PX = 256
export const AVATAR_MAX_UPLOAD_BYTES = 10 * 1024 * 1024 // before resizing

/**
 * Crops an image file to a centred square and scales it to 256x256, returning
 * a small WebP (JPEG where WebP encoding isn't supported).
 */
export async function resizeAvatar(file: File, size = AVATAR_SIZE_PX): Promise<Blob> {
  if (!file.type.startsWith('image/')) throw new Error('Please choose an image file.')
  if (file.size > AVATAR_MAX_UPLOAD_BYTES) throw new Error('That image is over 10 MB.')

  const bitmap = await createImageBitmap(file)
  const side = Math.min(bitmap.width, bitmap.height)
  const sx = (bitmap.width - side) / 2
  const sy = (bitmap.height - side) / 2

  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Could not process the image.')
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(bitmap, sx, sy, side, side, 0, 0, size, size)
  bitmap.close()

  const toBlob = (type: string, quality: number) =>
    new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, quality))
  const webp = await toBlob('image/webp', 0.85)
  if (webp && webp.type === 'image/webp') return webp
  const jpeg = await toBlob('image/jpeg', 0.88)
  if (!jpeg) throw new Error('Could not process the image.')
  return jpeg
}
