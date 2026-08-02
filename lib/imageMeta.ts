/**
 * Reading and removing metadata inside image files.
 *
 * Office embeds pictures byte for byte: a photo inserted into a Word document
 * keeps its EXIF block including GPS position, camera serial number and the
 * name of the editing software. This module inspects those blocks for the risk
 * report and strips them on the way out.
 *
 * Everything works on plain byte arrays so it runs in the browser and in Node.
 */

export type ImageFormat = 'jpeg' | 'png' | 'gif' | 'webp' | 'tiff' | 'bmp' | 'unknown'

export interface ImageFinding {
  /** Short label for the report, e.g. "GPS-Position". */
  label: string
  /** Value if it is safe and useful to show, e.g. the camera model. */
  value?: string
}

const dec = new TextDecoder()

function ascii(bytes: Uint8Array, start: number, length: number): string {
  return dec.decode(bytes.subarray(start, start + length))
}

export function detectFormat(bytes: Uint8Array): ImageFormat {
  if (bytes.length < 12) return 'unknown'
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'jpeg'
  if (bytes[0] === 0x89 && ascii(bytes, 1, 3) === 'PNG') return 'png'
  if (ascii(bytes, 0, 3) === 'GIF') return 'gif'
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') return 'webp'
  if ((bytes[0] === 0x49 && bytes[1] === 0x49) || (bytes[0] === 0x4d && bytes[1] === 0x4d)) return 'tiff'
  if (bytes[0] === 0x42 && bytes[1] === 0x4d) return 'bmp'
  return 'unknown'
}

// ---------------------------------------------------------------------------
// EXIF inspection (for the report — removal does not need to understand tags)
// ---------------------------------------------------------------------------

const EXIF_TAGS: Record<number, string> = {
  0x010f: 'Kamera-Hersteller',
  0x0110: 'Kamera-Modell',
  0x0131: 'Software',
  0x0132: 'Aufnahmedatum',
  0x013b: 'Fotograf',
  0x8298: 'Copyright',
}

const EXIF_SUB_TAGS: Record<number, string> = {
  0x9003: 'Aufnahmedatum',
  0xa430: 'Kamerabesitzer',
  0xa431: 'Seriennummer der Kamera',
  0xa433: 'Objektiv-Hersteller',
  0xa435: 'Objektiv-Seriennummer',
}

const TYPE_SIZES: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 }

function readTiff(bytes: Uint8Array, base: number): ImageFinding[] {
  const findings: ImageFinding[] = []
  if (base + 8 > bytes.length) return findings

  const little = bytes[base] === 0x49 && bytes[base + 1] === 0x49
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const u16 = (o: number) => view.getUint16(o, little)
  const u32 = (o: number) => view.getUint32(o, little)

  if (u16(base + 2) !== 42) return findings

  const readIfd = (offset: number, tags: Record<number, string>, depth: number): void => {
    if (offset <= 0 || offset + 2 > bytes.length || depth > 3) return
    const count = u16(offset)
    if (count > 512) return
    for (let i = 0; i < count; i++) {
      const entry = offset + 2 + i * 12
      if (entry + 12 > bytes.length) return
      const tag = u16(entry)
      const type = u16(entry + 2)
      const num = u32(entry + 4)
      const size = (TYPE_SIZES[type] ?? 0) * num
      const valueOffset = size > 4 ? base + u32(entry + 8) : entry + 8

      if (tag === 0x8769) {
        readIfd(base + u32(entry + 8), EXIF_SUB_TAGS, depth + 1) // Exif sub-IFD
        continue
      }
      if (tag === 0x8825) {
        findings.push({ label: 'GPS-Position' })
        continue
      }
      const name = tags[tag]
      if (!name) continue
      let value: string | undefined
      if (type === 2 && size > 0 && valueOffset + size <= bytes.length) {
        value = ascii(bytes, valueOffset, size).replace(/\0.*$/, '').trim() || undefined
      }
      if (name && !findings.some((f) => f.label === name)) findings.push({ label: name, value })
    }
  }

  readIfd(base + u32(base + 4), EXIF_TAGS, 0)
  return findings
}

/** What identifying data an image carries. Empty means nothing was found. */
export function inspectImage(bytes: Uint8Array): ImageFinding[] {
  const format = detectFormat(bytes)
  const findings: ImageFinding[] = []

  if (format === 'jpeg') {
    let offset = 2
    while (offset + 4 <= bytes.length) {
      if (bytes[offset] !== 0xff) break
      const marker = bytes[offset + 1]
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        offset += 2
        continue
      }
      if (marker === 0xda || marker === 0xd9) break
      const length = (bytes[offset + 2] << 8) | bytes[offset + 3]
      const dataStart = offset + 4
      if (marker === 0xe1) {
        if (ascii(bytes, dataStart, 6) === 'Exif\0\0') {
          findings.push(...readTiff(bytes, dataStart + 6))
        } else if (ascii(bytes, dataStart, 28).startsWith('http://ns.adobe.com/xap')) {
          findings.push({ label: 'XMP-Block (Bearbeitungsverlauf)' })
        }
      } else if (marker === 0xed) {
        findings.push({ label: 'IPTC-Block (Bildagentur-Daten)' })
      } else if (marker === 0xfe) {
        findings.push({ label: 'JPEG-Kommentar' })
      }
      offset += 2 + length
    }
  } else if (format === 'png') {
    let offset = 8
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    while (offset + 8 <= bytes.length) {
      const length = view.getUint32(offset)
      const type = ascii(bytes, offset + 4, 4)
      if (type === 'eXIf') findings.push(...readTiff(bytes, offset + 8))
      else if (type === 'tEXt' || type === 'zTXt') findings.push({ label: 'PNG-Textfeld' })
      else if (type === 'iTXt') findings.push({ label: 'XMP-Block (Bearbeitungsverlauf)' })
      else if (type === 'tIME') findings.push({ label: 'Änderungszeitstempel im Bild' })
      if (type === 'IEND') break
      offset += 12 + length
    }
  } else if (format === 'tiff') {
    findings.push(...readTiff(bytes, 0))
  } else if (format === 'webp' || format === 'gif') {
    if (stripImageMetadata(bytes).length !== bytes.length) {
      findings.push({ label: 'Eingebettete Metadaten' })
    }
  }

  // Collapse duplicates from multiple IFDs.
  const seen = new Set<string>()
  return findings.filter((f) => (seen.has(f.label) ? false : (seen.add(f.label), true)))
}

// ---------------------------------------------------------------------------
// Removal
// ---------------------------------------------------------------------------

function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, c) => sum + c.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }
  return out
}

/** Chunks that carry no identifying data and are needed for correct display. */
const PNG_KEEP = new Set(['IHDR', 'PLTE', 'IDAT', 'IEND', 'tRNS', 'gAMA', 'cHRM', 'sRGB', 'iCCP', 'bKGD', 'pHYs', 'sBIT', 'hIST', 'sPLT'])

/**
 * Returns the image without metadata blocks. Pixel data is untouched — this is
 * a byte-level filter, not a re-encode, so quality stays identical. Formats we
 * do not understand are returned unchanged.
 */
export function stripImageMetadata(bytes: Uint8Array): Uint8Array {
  switch (detectFormat(bytes)) {
    case 'jpeg':
      return stripJpeg(bytes)
    case 'png':
      return stripPng(bytes)
    case 'webp':
      return stripWebp(bytes)
    case 'gif':
      return stripGif(bytes)
    default:
      return bytes
  }
}

function stripJpeg(bytes: Uint8Array): Uint8Array {
  const out: Uint8Array[] = [bytes.subarray(0, 2)] // SOI
  let offset = 2

  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) break
    const marker = bytes[offset + 1]
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      out.push(bytes.subarray(offset, offset + 2))
      offset += 2
      continue
    }
    if (marker === 0xda) {
      // Start of scan: the rest is entropy-coded image data, copy verbatim.
      out.push(bytes.subarray(offset))
      return concat(out)
    }
    const length = (bytes[offset + 2] << 8) | bytes[offset + 3]
    const segment = bytes.subarray(offset, offset + 2 + length)
    const dataStart = offset + 4

    const isExifOrXmp = marker === 0xe1
    const isIptc = marker === 0xed
    const isComment = marker === 0xfe
    // APP2 usually carries the ICC profile, which is needed for correct colour
    // and holds no personal data — keep it, drop the other APPn slots.
    const isIcc = marker === 0xe2 && ascii(bytes, dataStart, 11) === 'ICC_PROFILE'
    const isJfif = marker === 0xe0
    const isOtherApp = marker >= 0xe0 && marker <= 0xef && !isJfif && !isIcc

    if (!isExifOrXmp && !isIptc && !isComment && !isOtherApp) out.push(segment)
    offset += 2 + length
  }

  return concat(out)
}

function stripPng(bytes: Uint8Array): Uint8Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const out: Uint8Array[] = [bytes.subarray(0, 8)]
  let offset = 8

  while (offset + 12 <= bytes.length) {
    const length = view.getUint32(offset)
    const type = ascii(bytes, offset + 4, 4)
    const end = offset + 12 + length
    if (PNG_KEEP.has(type)) out.push(bytes.subarray(offset, end))
    if (type === 'IEND') break
    offset = end
  }

  return concat(out)
}

function stripWebp(bytes: Uint8Array): Uint8Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const kept: Uint8Array[] = []
  let offset = 12
  let sawMetadata = false

  while (offset + 8 <= bytes.length) {
    const fourcc = ascii(bytes, offset, 4)
    const size = view.getUint32(offset + 4, true)
    const padded = size + (size % 2)
    const chunk = bytes.subarray(offset, offset + 8 + padded)
    if (fourcc === 'EXIF' || fourcc === 'XMP ') sawMetadata = true
    else kept.push(chunk)
    offset += 8 + padded
  }
  if (!sawMetadata) return bytes

  const body = concat(kept)
  // The VP8X header flags advertise EXIF/XMP presence — clear those bits.
  if (ascii(body, 0, 4) === 'VP8X' && body.length > 12) body[8] &= ~0b00001100

  const out = new Uint8Array(12 + body.length)
  out.set(bytes.subarray(0, 12))
  out.set(body, 12)
  new DataView(out.buffer).setUint32(4, out.length - 8, true)
  return out
}

function stripGif(bytes: Uint8Array): Uint8Array {
  // Global colour table size is encoded in the logical screen descriptor.
  let offset = 13
  if (bytes[10] & 0x80) offset += 3 * (1 << ((bytes[10] & 0x07) + 1))

  const out: Uint8Array[] = [bytes.subarray(0, offset)]
  let changed = false

  const skipBlocks = (start: number): number => {
    let position = start
    while (position < bytes.length && bytes[position] !== 0) position += bytes[position] + 1
    return position + 1
  }

  while (offset < bytes.length) {
    const marker = bytes[offset]
    if (marker === 0x3b) {
      out.push(bytes.subarray(offset, offset + 1))
      break
    }
    if (marker === 0x21) {
      const label = bytes[offset + 1]
      const end = skipBlocks(offset + 2)
      // Comment and application extensions (XMP lives in the latter).
      if (label === 0xfe || label === 0xff) changed = true
      else out.push(bytes.subarray(offset, end))
      offset = end
      continue
    }
    if (marker === 0x2c) {
      let position = offset + 10
      if (bytes[offset + 9] & 0x80) position += 3 * (1 << ((bytes[offset + 9] & 0x07) + 1))
      position = skipBlocks(position + 1) // LZW minimum code size, then blocks
      out.push(bytes.subarray(offset, position))
      offset = position
      continue
    }
    break
  }

  return changed ? concat(out) : bytes
}
