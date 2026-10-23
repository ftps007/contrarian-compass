/**
 * Minimal ZIP reader/writer for OOXML packages (.docx/.xlsx/.pptx).
 *
 * Runs entirely in the browser: deflate is handled by the native
 * CompressionStream/DecompressionStream APIs, so there is no dependency and
 * no file ever leaves the machine.
 *
 * Reading is strict — a wrong CRC, an encrypted entry or a compression method
 * we cannot undo is reported instead of producing garbage. Writing is lazy —
 * an entry whose bytes were not touched is copied in its original compressed
 * form, so cleaning a 20 MB deck does not re-compress 20 MB of photos.
 */

export interface ZipEntry {
  name: string
  /** Uncompressed bytes. Replace the array to change the entry; never edit it in place. */
  data: Uint8Array
  /** Compression method (0 = stored, 8 = deflate). 0 is honoured on write. */
  method: number
  /** DOS date/time word pair, kept so we can preserve it if asked. */
  dosTime: number
  dosDate: number
  externalAttr: number
  /**
   * How the entry arrived. While `data` is still the very same array the
   * reader produced, the writer reuses these compressed bytes untouched.
   */
  source?: {
    data: Uint8Array
    raw: Uint8Array
    method: number
    crc: number
  }
}

export class ZipError extends Error {}

const SIG_LOCAL = 0x04034b50
const SIG_CENTRAL = 0x02014b50
const SIG_EOCD = 0x06054b50

const FLAG_ENCRYPTED = 0x0001

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[i] = c >>> 0
  }
  return table
})()

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

async function inflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate-raw'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

async function deflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new CompressionStream('deflate-raw'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

/** Convert a Date to the (dosTime, dosDate) pair used in ZIP headers. */
export function toDosDateTime(date: Date): { dosTime: number; dosDate: number } {
  const year = Math.max(1980, date.getFullYear())
  const dosDate = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
  const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1)
  return { dosTime, dosDate }
}

export function fromDosDateTime(dosTime: number, dosDate: number): Date {
  return new Date(
    ((dosDate >> 9) & 0x7f) + 1980,
    ((dosDate >> 5) & 0x0f) - 1,
    dosDate & 0x1f,
    (dosTime >> 11) & 0x1f,
    (dosTime >> 5) & 0x3f,
    (dosTime & 0x1f) * 2
  )
}

/** Runs async jobs with at most `limit` in flight, keeping result order. */
async function mapLimited<T, R>(items: T[], limit: number, job: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next++
      if (index >= items.length) return
      results[index] = await job(items[index], index)
    }
  })
  await Promise.all(workers)
  return results
}

export async function readZip(buffer: ArrayBuffer): Promise<ZipEntry[]> {
  const view = new DataView(buffer)
  const bytes = new Uint8Array(buffer)
  if (bytes.length < 22) throw new ZipError('Die Datei ist zu klein für ein ZIP-Archiv.')

  // Locate the end-of-central-directory record by scanning backwards.
  let eocd = -1
  const scanStart = Math.max(0, bytes.length - 0xffff - 22)
  for (let i = bytes.length - 22; i >= scanStart; i--) {
    if (view.getUint32(i, true) === SIG_EOCD) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new ZipError('Keine gültige ZIP-Struktur gefunden — ist das wirklich eine Office-Datei?')

  const entryCount = view.getUint16(eocd + 10, true)
  const directoryOffset = view.getUint32(eocd + 16, true)
  if (directoryOffset === 0xffffffff || entryCount === 0xffff) throw new ZipError('ZIP64-Archive werden nicht unterstützt.')
  if (directoryOffset + 46 > bytes.length) throw new ZipError('Das Inhaltsverzeichnis des Archivs liegt außerhalb der Datei.')

  // First pass: the directory, which is small and sequential.
  interface Header {
    name: string
    method: number
    flags: number
    crc: number
    dosTime: number
    dosDate: number
    compressedSize: number
    uncompressedSize: number
    externalAttr: number
    localOffset: number
  }
  const headers: Header[] = []
  let offset = directoryOffset
  for (let i = 0; i < entryCount; i++) {
    if (offset + 46 > bytes.length || view.getUint32(offset, true) !== SIG_CENTRAL) {
      throw new ZipError('Beschädigtes Inhaltsverzeichnis im Archiv.')
    }
    const nameLength = view.getUint16(offset + 28, true)
    const extraLength = view.getUint16(offset + 30, true)
    const commentLength = view.getUint16(offset + 32, true)
    headers.push({
      flags: view.getUint16(offset + 8, true),
      method: view.getUint16(offset + 10, true),
      dosTime: view.getUint16(offset + 12, true),
      dosDate: view.getUint16(offset + 14, true),
      crc: view.getUint32(offset + 16, true),
      compressedSize: view.getUint32(offset + 20, true),
      uncompressedSize: view.getUint32(offset + 24, true),
      externalAttr: view.getUint32(offset + 38, true),
      localOffset: view.getUint32(offset + 42, true),
      name: new TextDecoder().decode(bytes.subarray(offset + 46, offset + 46 + nameLength)),
    })
    offset += 46 + nameLength + extraLength + commentLength
  }

  // Second pass: payloads, inflated concurrently.
  const files = headers.filter((h) => !h.name.endsWith('/'))
  return mapLimited(files, 4, async (header) => {
    const { name, localOffset, compressedSize } = header
    if (header.flags & FLAG_ENCRYPTED) {
      throw new ZipError(`Das Archiv ist passwortgeschützt (${name}) — bitte zuerst ohne Kennwort speichern.`)
    }
    if (header.method !== 0 && header.method !== 8) {
      throw new ZipError(`Kompressionsverfahren ${header.method} in ${name} wird nicht unterstützt.`)
    }
    if (localOffset + 30 > bytes.length || view.getUint32(localOffset, true) !== SIG_LOCAL) {
      throw new ZipError(`Beschädigter Eintrag im Archiv: ${name}`)
    }
    const localNameLength = view.getUint16(localOffset + 26, true)
    const localExtraLength = view.getUint16(localOffset + 28, true)
    const dataStart = localOffset + 30 + localNameLength + localExtraLength
    if (dataStart + compressedSize > bytes.length) {
      throw new ZipError(`Eintrag ${name} reicht über das Dateiende hinaus — das Archiv ist abgeschnitten.`)
    }
    const raw = bytes.subarray(dataStart, dataStart + compressedSize)

    let data: Uint8Array
    try {
      data = header.method === 8 ? await inflateRaw(raw) : new Uint8Array(raw)
    } catch {
      throw new ZipError(`Eintrag ${name} lässt sich nicht entpacken — das Archiv ist beschädigt.`)
    }
    if (data.length !== header.uncompressedSize || crc32(data) !== header.crc) {
      throw new ZipError(`Prüfsumme von ${name} stimmt nicht — das Archiv ist beschädigt.`)
    }

    return {
      name,
      data,
      method: header.method,
      dosTime: header.dosTime,
      dosDate: header.dosDate,
      externalAttr: header.externalAttr,
      // A view into the input, not a copy: the caller keeps the input alive anyway.
      source: { data, raw, method: header.method, crc: header.crc },
    }
  })
}

/** Formats that deflate cannot shrink; trying only burns time. */
function looksIncompressible(name: string, data: Uint8Array): boolean {
  if (/\.(jpe?g|png|gif|webp|mp3|mp4|m4a|mov|zip|docx|xlsx|pptx|woff2?)$/i.test(name)) return true
  if (data.length < 4) return false
  const b = data
  return (
    (b[0] === 0xff && b[1] === 0xd8) || // JPEG
    (b[0] === 0x89 && b[1] === 0x50) || // PNG
    (b[0] === 0x50 && b[1] === 0x4b) || // ZIP (embedded package)
    (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) // GIF
  )
}

/**
 * Rebuild a ZIP archive. Extra fields are deliberately dropped — they can hold
 * Unix/NTFS timestamps that survive metadata edits. Passing `timestamp`
 * normalises every entry's DOS date to the same value.
 */
export async function writeZip(entries: ZipEntry[], timestamp?: Date): Promise<Blob> {
  const encoder = new TextEncoder()

  const seen = new Set<string>()
  for (const entry of entries) {
    if (seen.has(entry.name)) throw new ZipError(`Doppelter Eintrag im Archiv: ${entry.name}`)
    seen.add(entry.name)
  }

  // Compress what changed, reuse what did not — concurrently.
  const payloads = await mapLimited(entries, 4, async (entry) => {
    const storedAsAsked = entry.method !== 0 || entry.source?.method === 0
    if (entry.source && entry.source.data === entry.data && storedAsAsked) {
      return { payload: entry.source.raw, method: entry.source.method, crc: entry.source.crc }
    }
    const crc = crc32(entry.data)
    if (entry.method === 0 || entry.data.length === 0 || looksIncompressible(entry.name, entry.data)) {
      return { payload: entry.data, method: 0, crc }
    }
    const deflated = await deflateRaw(entry.data)
    return deflated.length < entry.data.length
      ? { payload: deflated, method: 8, crc }
      : { payload: entry.data, method: 0, crc }
  })

  const localChunks: Uint8Array[] = []
  const centralChunks: Uint8Array[] = []
  let offset = 0

  entries.forEach((entry, index) => {
    const { payload, method, crc } = payloads[index]
    const nameBytes = encoder.encode(entry.name)
    const { dosTime, dosDate } = timestamp
      ? toDosDateTime(timestamp)
      : { dosTime: entry.dosTime, dosDate: entry.dosDate }

    const local = new Uint8Array(30 + nameBytes.length)
    const localView = new DataView(local.buffer)
    localView.setUint32(0, SIG_LOCAL, true)
    localView.setUint16(4, 20, true) // version needed
    localView.setUint16(6, 0x0800, true) // UTF-8 filename flag
    localView.setUint16(8, method, true)
    localView.setUint16(10, dosTime, true)
    localView.setUint16(12, dosDate, true)
    localView.setUint32(14, crc, true)
    localView.setUint32(18, payload.length, true)
    localView.setUint32(22, entry.data.length, true)
    localView.setUint16(26, nameBytes.length, true)
    localView.setUint16(28, 0, true) // no extra field
    local.set(nameBytes, 30)

    const central = new Uint8Array(46 + nameBytes.length)
    const centralView = new DataView(central.buffer)
    centralView.setUint32(0, SIG_CENTRAL, true)
    centralView.setUint16(4, 20, true) // version made by
    centralView.setUint16(6, 20, true)
    centralView.setUint16(8, 0x0800, true)
    centralView.setUint16(10, method, true)
    centralView.setUint16(12, dosTime, true)
    centralView.setUint16(14, dosDate, true)
    centralView.setUint32(16, crc, true)
    centralView.setUint32(20, payload.length, true)
    centralView.setUint32(24, entry.data.length, true)
    centralView.setUint16(28, nameBytes.length, true)
    centralView.setUint32(38, entry.externalAttr, true)
    centralView.setUint32(42, offset, true)
    central.set(nameBytes, 46)

    localChunks.push(local, payload)
    centralChunks.push(central)
    offset += local.length + payload.length
  })

  if (offset >= 0xffffffff) throw new ZipError('Das Ergebnis wäre größer als 4 GB — das unterstützt dieses Format nicht.')

  const centralSize = centralChunks.reduce((sum, c) => sum + c.length, 0)
  const eocd = new Uint8Array(22)
  const eocdView = new DataView(eocd.buffer)
  eocdView.setUint32(0, SIG_EOCD, true)
  eocdView.setUint16(8, entries.length, true)
  eocdView.setUint16(10, entries.length, true)
  eocdView.setUint32(12, centralSize, true)
  eocdView.setUint32(16, offset, true)

  return new Blob([...localChunks, ...centralChunks, eocd] as BlobPart[], {
    type: 'application/octet-stream',
  })
}
