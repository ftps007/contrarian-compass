/**
 * Cutting an image down to the part a document actually shows.
 *
 * Office stores a cropped picture in full and only records the visible window
 * (`<a:srcRect>`), so the cut-away area travels with the file. Removing it for
 * real means re-encoding the image, which needs a canvas — available in the
 * browser, not in Node. Callers treat `null` as "could not be done here" and
 * report it instead of pretending the crop was removed.
 */

import { detectFormat } from './imageMeta'

export interface CropRect {
  /** Fractions of the original size, e.g. 0.25 for a quarter cut off. */
  left: number
  top: number
  right: number
  bottom: number
}

const MIME: Record<string, string> = {
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
}

export function canFlattenCrops(): boolean {
  return typeof createImageBitmap === 'function' && typeof OffscreenCanvas === 'function'
}

export async function flattenCrop(bytes: Uint8Array, rect: CropRect): Promise<Uint8Array | null> {
  if (!canFlattenCrops()) return null

  const mime = MIME[detectFormat(bytes)]
  if (!mime) return null

  const keptWidth = 1 - rect.left - rect.right
  const keptHeight = 1 - rect.top - rect.bottom
  if (keptWidth <= 0 || keptHeight <= 0 || (keptWidth > 0.999 && keptHeight > 0.999)) return null

  try {
    const bitmap = await createImageBitmap(new Blob([bytes as BlobPart], { type: mime }))
    const width = Math.max(1, Math.round(bitmap.width * keptWidth))
    const height = Math.max(1, Math.round(bitmap.height * keptHeight))

    const canvas = new OffscreenCanvas(width, height)
    const context = canvas.getContext('2d')
    if (!context) return null
    context.drawImage(
      bitmap,
      Math.round(bitmap.width * rect.left),
      Math.round(bitmap.height * rect.top),
      Math.round(bitmap.width * keptWidth),
      Math.round(bitmap.height * keptHeight),
      0,
      0,
      width,
      height
    )
    bitmap.close()

    // JPEG is re-compressed; PNG stays lossless.
    const blob = await canvas.convertToBlob({ type: mime, quality: 0.92 })
    return new Uint8Array(await blob.arrayBuffer())
  } catch {
    return null
  }
}
