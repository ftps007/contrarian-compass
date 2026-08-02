/**
 * Minimal ZIP reader/writer for OOXML packages (.docx/.xlsx/.pptx).
 *
 * Runs entirely in the browser: deflate is handled by the native
 * CompressionStream/DecompressionStream APIs, so there is no dependency and
 * no file ever leaves the machine.
 */

export interface ZipEntry {
  name: string
  /** Uncompressed bytes. */
  data: Uint8Array
  /** Original compression method (0 = stored, 8 = deflate). */
  method: number
  /** Original DOS date/time word pair, kept so we can preserve it if asked. */
  dosTime: number
  dosDate: number
  externalAttr: number
}

const SIG_LOCAL = 0x04034b50
const SIG_CENTRAL = 0x02014b50
const SIG_EOCD = 0x06054b50

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

export async function readZip(buffer: ArrayBuffer): Promise<ZipEntry[]> {
  const view = new DataView(buffer)
  const bytes = new Uint8Array(buffer)

  // Locate the end-of-central-directory record by scanning backwards.
  let eocd = -1
  const scanStart = Math.max(0, bytes.length - 0xffff - 22)
  for (let i = bytes.length - 22; i >= scanStart; i--) {
    if (view.getUint32(i, true) === SIG_EOCD) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('Keine gültige ZIP-Struktur gefunden — ist das wirklich eine Office-Datei?')

  const entryCount = view.getUint16(eocd + 10, true)
  let offset = view.getUint32(eocd + 16, true)
  if (offset === 0xffffffff) throw new Error('ZIP64-Archive werden nicht unterstützt.')

  const entries: ZipEntry[] = []
  for (let i = 0; i < entryCount; i++) {
    if (view.getUint32(offset, true) !== SIG_CENTRAL) throw new Error('Beschädigtes Central Directory.')

    const method = view.getUint16(offset + 10, true)
    const dosTime = view.getUint16(offset + 12, true)
    const dosDate = view.getUint16(offset + 14, true)
    const compressedSize = view.getUint32(offset + 20, true)
    const nameLength = view.getUint16(offset + 28, true)
    const extraLength = view.getUint16(offset + 30, true)
    const commentLength = view.getUint16(offset + 32, true)
    const externalAttr = view.getUint32(offset + 38, true)
    const localOffset = view.getUint32(offset + 42, true)
    const name = new TextDecoder().decode(bytes.subarray(offset + 46, offset + 46 + nameLength))

    if (view.getUint32(localOffset, true) !== SIG_LOCAL) throw new Error(`Beschädigter Local Header: ${name}`)
    const localNameLength = view.getUint16(localOffset + 26, true)
    const localExtraLength = view.getUint16(localOffset + 28, true)
    const dataStart = localOffset + 30 + localNameLength + localExtraLength
    const raw = bytes.subarray(dataStart, dataStart + compressedSize)

    // Directory markers carry no payload.
    if (!name.endsWith('/')) {
      entries.push({
        name,
        data: method === 8 ? await inflateRaw(raw) : new Uint8Array(raw),
        method,
        dosTime,
        dosDate,
        externalAttr,
      })
    }

    offset += 46 + nameLength + extraLength + commentLength
  }

  return entries
}

/**
 * Rebuild a ZIP archive. Extra fields are deliberately dropped — they can hold
 * Unix/NTFS timestamps that survive metadata edits. Passing `timestamp`
 * normalises every entry's DOS date to the same value.
 */
export async function writeZip(entries: ZipEntry[], timestamp?: Date): Promise<Blob> {
  const encoder = new TextEncoder()
  const localChunks: Uint8Array[] = []
  const centralChunks: Uint8Array[] = []
  let offset = 0

  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.name)
    const crc = crc32(entry.data)
    const deflated = entry.data.length > 0 ? await deflateRaw(entry.data) : new Uint8Array(0)
    // method 0 is honoured: OpenDocument requires an uncompressed mimetype entry.
    const useDeflate = entry.method !== 0 && deflated.length < entry.data.length
    const payload = useDeflate ? deflated : entry.data
    const method = useDeflate ? 8 : 0
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
  }

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
