/**
 * Assertions and fixture builders shared by the test files.
 */

declare const __test: (name: string, fn: () => unknown | Promise<unknown>) => Promise<void>

export const test = (name: string, fn: () => unknown | Promise<unknown>) => __test(name, fn)

export function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

export function equal<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) throw new Error(`${message}\n  erwartet: ${String(expected)}\n  bekommen: ${String(actual)}`)
}

export function includes(haystack: string, needle: string, message: string): void {
  if (!haystack.includes(needle)) throw new Error(`${message}\n  "${needle}" fehlt in: ${haystack.slice(0, 200)}…`)
}

export function excludes(haystack: string, needle: string, message: string): void {
  if (haystack.includes(needle)) throw new Error(`${message}\n  "${needle}" ist noch enthalten`)
}

const encoder = new TextEncoder()

export const bytes = (text: string) => encoder.encode(text)

export function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0))
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }
  return out
}

// ---------------------------------------------------------------------------
// Image fixtures — built by hand so the metadata blocks are exactly known
// ---------------------------------------------------------------------------

/** Big-endian TIFF/EXIF block with camera details, a serial number and GPS. */
export function exifBlock(): Uint8Array {
  const entries: { tag: number; type: number; count: number; value: number | string }[] = []
  const strings: { offset: number; text: string }[] = []

  // Layout: header(8) + IFD0 + values.
  const ifd0Tags = [
    { tag: 0x010f, text: 'ACME Cameras' },
    { tag: 0x0110, text: 'X-1000' },
    { tag: 0x0131, text: 'Bildbearbeitung 3.0' },
    { tag: 0x0132, text: '2024:02:01 10:00:00' },
    { tag: 0x013b, text: 'Max Mustermann' },
  ]
  const exifSub = [{ tag: 0xa431, text: 'SN-12345678' }]

  const ifd0Count = ifd0Tags.length + 2 // + Exif IFD pointer + GPS IFD pointer
  const ifd0Start = 8
  const ifd0Size = 2 + ifd0Count * 12 + 4
  const subStart = ifd0Start + ifd0Size
  const subSize = 2 + exifSub.length * 12 + 4
  const gpsStart = subStart + subSize
  const gpsSize = 2 + 1 * 12 + 4
  let valueOffset = gpsStart + gpsSize

  for (const { tag, text } of ifd0Tags) {
    const padded = text + '\0'
    strings.push({ offset: valueOffset, text: padded })
    entries.push({ tag, type: 2, count: padded.length, value: valueOffset })
    valueOffset += padded.length + (padded.length % 2)
  }

  const serial = exifSub[0].text + '\0'
  const serialOffset = valueOffset
  const total = valueOffset + serial.length
  const buffer = new Uint8Array(total)
  const view = new DataView(buffer.buffer)
  const enc = new TextEncoder()

  buffer[0] = 0x4d
  buffer[1] = 0x4d // big endian
  view.setUint16(2, 42)
  view.setUint32(4, ifd0Start)

  view.setUint16(ifd0Start, ifd0Count)
  entries.forEach((entry, index) => {
    const at = ifd0Start + 2 + index * 12
    view.setUint16(at, entry.tag)
    view.setUint16(at + 2, entry.type)
    view.setUint32(at + 4, entry.count)
    view.setUint32(at + 8, entry.value as number)
  })
  let at = ifd0Start + 2 + entries.length * 12
  view.setUint16(at, 0x8769) // Exif IFD pointer
  view.setUint16(at + 2, 4)
  view.setUint32(at + 4, 1)
  view.setUint32(at + 8, subStart)
  at += 12
  view.setUint16(at, 0x8825) // GPS IFD pointer
  view.setUint16(at + 2, 4)
  view.setUint32(at + 4, 1)
  view.setUint32(at + 8, gpsStart)
  view.setUint32(ifd0Start + 2 + ifd0Count * 12, 0)

  // Exif sub-IFD with the serial number stored inline via an offset.
  view.setUint16(subStart, exifSub.length)
  view.setUint16(subStart + 2, exifSub[0].tag)
  view.setUint16(subStart + 4, 2)
  view.setUint32(subStart + 6, serial.length)
  view.setUint32(subStart + 10, serialOffset)
  view.setUint32(subStart + 2 + 12, 0)

  // Minimal GPS IFD — its mere presence is what the report flags.
  view.setUint16(gpsStart, 1)
  view.setUint16(gpsStart + 2, 0x0001)
  view.setUint16(gpsStart + 4, 2)
  view.setUint32(gpsStart + 6, 2)
  buffer.set(enc.encode('N\0'), gpsStart + 10)
  view.setUint32(gpsStart + 2 + 12, 0)

  for (const { offset, text } of strings) buffer.set(enc.encode(text), offset)
  buffer.set(enc.encode(serial), serialOffset)
  return buffer
}

function jpegSegment(marker: number, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(4 + payload.length)
  out[0] = 0xff
  out[1] = marker
  out[2] = ((payload.length + 2) >> 8) & 0xff
  out[3] = (payload.length + 2) & 0xff
  out.set(payload, 4)
  return out
}

/** A JPEG carrying EXIF (with GPS), XMP, an IPTC block and a comment. */
export function jpegWithMetadata(): Uint8Array {
  const exif = concatBytes([bytes('Exif\0\0'), exifBlock()])
  const xmp = bytes('http://ns.adobe.com/xap/1.0/\0<x:xmpmeta>Bearbeitet von Max</x:xmpmeta>')
  const iptc = bytes('Photoshop 3.0\0IPTC-Daten')
  const jfif = bytes('JFIF\0\0\0\0\0\0')
  const icc = concatBytes([bytes('ICC_PROFILE\0'), new Uint8Array([1, 1, 0, 0])])

  return concatBytes([
    new Uint8Array([0xff, 0xd8]),
    jpegSegment(0xe0, jfif),
    jpegSegment(0xe1, exif),
    jpegSegment(0xe1, xmp),
    jpegSegment(0xe2, icc),
    jpegSegment(0xed, iptc),
    jpegSegment(0xfe, bytes('Internes Foto, nicht weitergeben')),
    jpegSegment(0xdb, new Uint8Array(64).fill(16)), // quantisation table
    new Uint8Array([0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00]), // SOS
    new Uint8Array([0x12, 0x34, 0x56, 0x78]), // "pixel data"
    new Uint8Array([0xff, 0xd9]),
  ])
}

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i]
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  }
  return (c ^ 0xffffffff) >>> 0
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const body = concatBytes([bytes(type), data])
  const out = new Uint8Array(8 + data.length + 4)
  const view = new DataView(out.buffer)
  view.setUint32(0, data.length)
  out.set(body, 4)
  view.setUint32(8 + data.length, crc32(body))
  return out
}

/** A PNG with tEXt, iTXt (XMP), eXIf and tIME chunks around real pixel data. */
export function pngWithMetadata(): Uint8Array {
  const ihdr = new Uint8Array(13)
  const view = new DataView(ihdr.buffer)
  view.setUint32(0, 1)
  view.setUint32(4, 1)
  ihdr[8] = 8
  ihdr[9] = 6

  return concatBytes([
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('tEXt', bytes('Author\0Max Mustermann')),
    pngChunk('iTXt', bytes('XML:com.adobe.xmp\0\0\0\0\0<x:xmpmeta/>')),
    pngChunk('eXIf', exifBlock()),
    pngChunk('tIME', new Uint8Array([0x07, 0xe8, 2, 1, 10, 0, 0])),
    pngChunk('pHYs', new Uint8Array([0, 0, 0x0b, 0x13, 0, 0, 0x0b, 0x13, 1])),
    pngChunk('IDAT', new Uint8Array([0x78, 0x9c, 0x62, 0x00, 0x00, 0x00, 0x02, 0x00, 0x01])),
    pngChunk('IEND', new Uint8Array(0)),
  ])
}
