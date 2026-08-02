/**
 * The old binary Office formats (.doc/.xls/.ppt).
 *
 * They are OLE2 compound files: a little filesystem inside the file, with the
 * document properties in two streams named \x05SummaryInformation and
 * \x05DocumentSummaryInformation. Those streams hold a "property set" — a
 * header, an offset table and typed values.
 *
 * The streams are rewritten in place and padded back to their original length,
 * so the surrounding filesystem (sector chains, directory sizes) stays exactly
 * as it was. That keeps a risky format safe to touch at the price of one
 * restriction: a value may not grow beyond the space the stream already has.
 */

const SIGNATURE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]

const SUMMARY = 'SummaryInformation'
const DOC_SUMMARY = 'DocumentSummaryInformation'

const FMTID_SUMMARY = 'f29f85e0-4ff9-1068-ab91-08002b27b3d9'
const FMTID_DOC_SUMMARY = 'd5cdd502-2e9c-101b-9397-08002b2cf9ae'

const VT_I4 = 3
const VT_LPSTR = 30
const VT_FILETIME = 64

export interface Ole2Field {
  key: string
  label: string
  stream: 'summary' | 'docSummary'
  id: number
  kind: 'text' | 'datetime' | 'number'
}

export const OLE2_FIELDS: Ole2Field[] = [
  { key: 'title', label: 'Titel', stream: 'summary', id: 2, kind: 'text' },
  { key: 'subject', label: 'Thema', stream: 'summary', id: 3, kind: 'text' },
  { key: 'creator', label: 'Autor', stream: 'summary', id: 4, kind: 'text' },
  { key: 'keywords', label: 'Stichwörter', stream: 'summary', id: 5, kind: 'text' },
  { key: 'description', label: 'Kommentare', stream: 'summary', id: 6, kind: 'text' },
  { key: 'template', label: 'Vorlage', stream: 'summary', id: 7, kind: 'text' },
  { key: 'lastModifiedBy', label: 'Zuletzt geändert von', stream: 'summary', id: 8, kind: 'text' },
  { key: 'revision', label: 'Revisionsnummer', stream: 'summary', id: 9, kind: 'text' },
  { key: 'TotalTime', label: 'Bearbeitungszeit (Min.)', stream: 'summary', id: 10, kind: 'number' },
  { key: 'lastPrinted', label: 'Zuletzt gedruckt', stream: 'summary', id: 11, kind: 'datetime' },
  { key: 'created', label: 'Erstellt am', stream: 'summary', id: 12, kind: 'datetime' },
  { key: 'modified', label: 'Geändert am', stream: 'summary', id: 13, kind: 'datetime' },
  { key: 'Application', label: 'Erstellt mit', stream: 'summary', id: 18, kind: 'text' },
  { key: 'category', label: 'Kategorie', stream: 'docSummary', id: 2, kind: 'text' },
  { key: 'Manager', label: 'Vorgesetzter', stream: 'docSummary', id: 14, kind: 'text' },
  { key: 'Company', label: 'Firma', stream: 'docSummary', id: 15, kind: 'text' },
]

export const isOle2 = (bytes: Uint8Array) => SIGNATURE.every((byte, index) => bytes[index] === byte)

// ---------------------------------------------------------------------------
// Compound file structure
// ---------------------------------------------------------------------------

interface StreamLocation {
  name: string
  /** Absolute byte ranges of the stream, in order. */
  ranges: { start: number; end: number }[]
  size: number
}

interface Compound {
  streams: Map<string, StreamLocation>
}

function readCompound(bytes: Uint8Array): Compound | null {
  if (!isOle2(bytes) || bytes.length < 512) return null
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

  const sectorSize = 1 << view.getUint16(0x1e, true)
  const miniSectorSize = 1 << view.getUint16(0x20, true)
  const directoryStart = view.getUint32(0x30, true)
  const miniCutoff = view.getUint32(0x38, true)
  const miniFatStart = view.getUint32(0x3c, true)
  const difatStart = view.getUint32(0x44, true)

  const sectorOffset = (sector: number) => (sector + 1) * sectorSize
  const sectorEnd = (sector: number) => sectorOffset(sector) + sectorSize
  if (sectorSize < 128) return null

  // DIFAT -> FAT sector numbers
  const fatSectors: number[] = []
  for (let i = 0; i < 109; i++) {
    const sector = view.getUint32(0x4c + i * 4, true)
    if (sector === 0xffffffff) break
    fatSectors.push(sector)
  }
  let difat = difatStart
  let guard = 0
  while (difat !== 0xffffffff && difat !== 0xfffffffe && guard++ < 1024) {
    const base = sectorOffset(difat)
    if (base + sectorSize > bytes.length) break
    const perSector = sectorSize / 4 - 1
    for (let i = 0; i < perSector; i++) {
      const sector = view.getUint32(base + i * 4, true)
      if (sector === 0xffffffff) break
      fatSectors.push(sector)
    }
    difat = view.getUint32(base + sectorSize - 4, true)
  }

  const fat: number[] = []
  for (const sector of fatSectors) {
    const base = sectorOffset(sector)
    if (base + sectorSize > bytes.length) break
    for (let i = 0; i < sectorSize / 4; i++) fat.push(view.getUint32(base + i * 4, true))
  }
  if (fat.length === 0) return null

  const chain = (start: number, limit = 1 << 20): number[] => {
    const out: number[] = []
    let sector = start
    while (sector !== 0xfffffffe && sector !== 0xffffffff && out.length < limit) {
      if (sector < 0 || sector >= fat.length) break
      out.push(sector)
      sector = fat[sector]
    }
    return out
  }

  const miniFat: number[] = []
  for (const sector of chain(miniFatStart)) {
    const base = sectorOffset(sector)
    if (base + sectorSize > bytes.length) break
    for (let i = 0; i < sectorSize / 4; i++) miniFat.push(view.getUint32(base + i * 4, true))
  }

  // Directory
  const directorySectors = chain(directoryStart)
  const entries: { name: string; type: number; start: number; size: number }[] = []
  for (const sector of directorySectors) {
    const base = sectorOffset(sector)
    for (let offset = base; offset + 128 <= base + sectorSize && offset + 128 <= bytes.length; offset += 128) {
      const nameLength = view.getUint16(offset + 0x40, true)
      if (nameLength < 2) continue
      let name = ''
      for (let i = 0; i < nameLength - 2; i += 2) name += String.fromCharCode(view.getUint16(offset + i, true))
      entries.push({
        name,
        type: bytes[offset + 0x42],
        start: view.getUint32(offset + 0x74, true),
        size: view.getUint32(offset + 0x78, true),
      })
    }
  }

  const root = entries.find((e) => e.type === 5)
  const miniStreamSectors = root ? chain(root.start) : []

  const streams = new Map<string, StreamLocation>()
  for (const item of entries) {
    if (item.type !== 2) continue
    const ranges: { start: number; end: number }[] = []

    if (item.size < miniCutoff) {
      // Mini sectors sit inside the root entry's stream.
      let mini = item.start
      let count = 0
      while (mini !== 0xfffffffe && mini !== 0xffffffff && count++ < 1 << 16) {
        const byteOffset = mini * miniSectorSize
        const hostIndex = Math.floor(byteOffset / sectorSize)
        const hostSector = miniStreamSectors[hostIndex]
        if (hostSector === undefined) break
        const start = sectorOffset(hostSector) + (byteOffset % sectorSize)
        ranges.push({ start, end: start + miniSectorSize })
        if (mini >= miniFat.length) break
        mini = miniFat[mini]
      }
    } else {
      for (const sector of chain(item.start)) ranges.push({ start: sectorOffset(sector), end: sectorEnd(sector) })
    }

    if (ranges.length > 0) streams.set(item.name, { name: item.name, ranges, size: item.size })
  }

  return { streams }
}

function readStream(bytes: Uint8Array, location: StreamLocation): Uint8Array {
  const out = new Uint8Array(location.ranges.reduce((sum, r) => sum + (r.end - r.start), 0))
  let offset = 0
  for (const range of location.ranges) {
    const slice = bytes.subarray(range.start, Math.min(range.end, bytes.length))
    out.set(slice, offset)
    offset += range.end - range.start
  }
  return out.subarray(0, Math.max(location.size, 0) || out.length)
}

/** Writes data back into the stream's sectors, zero-padding the remainder. */
function writeStream(bytes: Uint8Array, location: StreamLocation, data: Uint8Array): boolean {
  const capacity = location.ranges.reduce((sum, r) => sum + (r.end - r.start), 0)
  if (data.length > capacity) return false

  let offset = 0
  for (const range of location.ranges) {
    const length = range.end - range.start
    for (let i = 0; i < length; i++) {
      const target = range.start + i
      if (target >= bytes.length) break
      bytes[target] = offset + i < data.length ? data[offset + i] : 0
    }
    offset += length
  }
  return true
}

// ---------------------------------------------------------------------------
// Property sets
// ---------------------------------------------------------------------------

const FILETIME_EPOCH = -11644473600000 // 1601-01-01 in JS milliseconds

function parsePropertySet(stream: Uint8Array): Map<number, string | number | Date> {
  const values = new Map<number, string | number | Date>()
  if (stream.length < 48) return values
  const view = new DataView(stream.buffer, stream.byteOffset, stream.byteLength)
  if (view.getUint16(0, true) !== 0xfffe) return values

  const sectionOffset = view.getUint32(44, true)
  if (sectionOffset + 8 > stream.length) return values
  const count = view.getUint32(sectionOffset + 4, true)

  for (let i = 0; i < count && i < 256; i++) {
    const entry = sectionOffset + 8 + i * 8
    if (entry + 8 > stream.length) break
    const id = view.getUint32(entry, true)
    const offset = sectionOffset + view.getUint32(entry + 4, true)
    if (offset + 4 > stream.length) continue
    const type = view.getUint32(offset, true)

    if (type === VT_LPSTR || type === 31) {
      const length = view.getUint32(offset + 4, true)
      if (offset + 8 + length > stream.length) continue
      const raw = stream.subarray(offset + 8, offset + 8 + length)
      const text =
        type === 31
          ? Array.from({ length: Math.floor(length / 2) }, (_, k) => String.fromCharCode(view.getUint16(offset + 8 + k * 2, true))).join('')
          : new TextDecoder('windows-1252').decode(raw)
      values.set(id, text.replace(/\0.*$/, ''))
    } else if (type === VT_I4) {
      values.set(id, view.getInt32(offset + 4, true))
    } else if (type === VT_FILETIME) {
      const low = view.getUint32(offset + 4, true)
      const high = view.getUint32(offset + 8, true)
      const ticks = high * 4294967296 + low
      if (ticks > 0) values.set(id, new Date(ticks / 10000 + FILETIME_EPOCH))
    }
  }

  return values
}

function buildPropertySet(fmtid: string, values: Map<number, string | number | Date>): Uint8Array {
  const encoder = new TextEncoder()
  const properties: { id: number; body: Uint8Array }[] = []

  // Code page first — without it readers guess the encoding of the strings.
  const codePage = new Uint8Array(8)
  new DataView(codePage.buffer).setUint32(0, 2, true) // VT_I2
  new DataView(codePage.buffer).setUint16(4, 65001, true) // UTF-8
  properties.push({ id: 1, body: codePage })

  for (const [id, value] of Array.from(values.entries())) {
    if (id === 1) continue
    if (typeof value === 'string') {
      if (value === '') continue
      const text = encoder.encode(value + '\0')
      const padded = Math.ceil(text.length / 4) * 4
      const body = new Uint8Array(8 + padded)
      const view = new DataView(body.buffer)
      view.setUint32(0, VT_LPSTR, true)
      view.setUint32(4, text.length, true)
      body.set(text, 8)
      properties.push({ id, body })
    } else if (typeof value === 'number') {
      const body = new Uint8Array(8)
      const view = new DataView(body.buffer)
      view.setUint32(0, VT_I4, true)
      view.setInt32(4, value, true)
      properties.push({ id, body })
    } else if (value instanceof Date) {
      const body = new Uint8Array(12)
      const view = new DataView(body.buffer)
      view.setUint32(0, VT_FILETIME, true)
      const ticks = (value.getTime() - FILETIME_EPOCH) * 10000
      view.setUint32(4, ticks % 4294967296, true)
      view.setUint32(8, Math.floor(ticks / 4294967296), true)
      properties.push({ id, body })
    }
  }

  const tableSize = 8 + properties.length * 8
  const sectionSize = tableSize + properties.reduce((sum, p) => sum + p.body.length, 0)
  const out = new Uint8Array(48 + sectionSize)
  const view = new DataView(out.buffer)

  view.setUint16(0, 0xfffe, true) // byte order
  view.setUint16(2, 0, true) // format
  view.setUint32(4, 0x00020006, true) // OS version
  out.set(uuidToBytes('00000000-0000-0000-0000-000000000000'), 8) // class id
  view.setUint32(24, 1, true) // one section
  out.set(uuidToBytes(fmtid), 28)
  view.setUint32(44, 48, true) // section offset

  view.setUint32(48, sectionSize, true)
  view.setUint32(52, properties.length, true)
  let valueOffset = tableSize
  properties.forEach((property, index) => {
    view.setUint32(56 + index * 8, property.id, true)
    view.setUint32(56 + index * 8 + 4, valueOffset, true)
    out.set(property.body, 48 + valueOffset)
    valueOffset += property.body.length
  })

  return out
}

function uuidToBytes(uuid: string): Uint8Array {
  const hex = uuid.replace(/-/g, '')
  const bytes = new Uint8Array(16)
  for (let i = 0; i < 16; i++) bytes[i] = parseInt(hex.substr(i * 2, 2), 16)
  // The first three groups are little-endian in a GUID.
  const swap = (a: number, b: number) => {
    const tmp = bytes[a]
    bytes[a] = bytes[b]
    bytes[b] = tmp
  }
  swap(0, 3)
  swap(1, 2)
  swap(4, 5)
  swap(6, 7)
  return bytes
}

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface Ole2Document {
  values: Record<string, string>
  findings: { id: string; label: string; detail: string; severity: 'hoch' | 'mittel' | 'niedrig' }[]
}

export function readOle2(bytes: Uint8Array): Ole2Document | null {
  const compound = readCompound(bytes)
  if (!compound) return null

  const summary = compound.streams.get(SUMMARY)
  const docSummary = compound.streams.get(DOC_SUMMARY)
  const summaryValues = summary ? parsePropertySet(readStream(bytes, summary)) : new Map()
  const docValues = docSummary ? parsePropertySet(readStream(bytes, docSummary)) : new Map()

  const values: Record<string, string> = {}
  for (const field of OLE2_FIELDS) {
    const source = field.stream === 'summary' ? summaryValues : docValues
    const value = source.get(field.id)
    if (value === undefined) values[field.key] = ''
    else if (value instanceof Date) values[field.key] = value.toISOString().replace(/\.\d{3}Z$/, 'Z')
    else values[field.key] = String(value)
  }

  const findings: Ole2Document['findings'] = []
  const streamNames = Array.from(compound.streams.keys())
  findings.push({
    id: 'legacyFormat',
    label: 'Altes Binärformat',
    detail:
      'Diese Formate speichern beim „schnellen Speichern" gelöschten Text weiter in der Datei. Das lässt sich nicht zuverlässig entfernen — für heikle Dokumente in Word öffnen und als .docx neu speichern.',
    severity: 'hoch',
  })
  if (streamNames.some((n) => /Macros|VBA|_VBA_PROJECT/i.test(n))) {
    findings.push({
      id: 'macros',
      label: 'Makros (VBA-Projekt)',
      detail: 'Das VBA-Projekt enthält Quellcode samt Autorenspuren. Entfernen geht in dieser Datei nur über Office.',
      severity: 'mittel',
    })
  }
  if (streamNames.some((n) => /ObjectPool|Ole/i.test(n))) {
    findings.push({
      id: 'oleObjects',
      label: 'Eingebettete Objekte',
      detail: 'Eingebettete Fremddokumente bringen eigene Metadaten mit.',
      severity: 'mittel',
    })
  }

  return { values, findings }
}

export interface Ole2WriteResult {
  bytes: Uint8Array
  steps: string[]
  /** Set when a value did not fit into the space the old format provides. */
  error?: string
}

export function writeOle2(bytes: Uint8Array, values: Record<string, string>): Ole2WriteResult {
  const compound = readCompound(bytes)
  if (!compound) return { bytes, steps: [], error: 'Datei ist kein gültiges OLE2-Dokument.' }

  const out = bytes.slice()
  const steps: string[] = []

  for (const [streamName, fmtid, group] of [
    [SUMMARY, FMTID_SUMMARY, 'summary'],
    [DOC_SUMMARY, FMTID_DOC_SUMMARY, 'docSummary'],
  ] as const) {
    const location = compound.streams.get(streamName)
    if (!location) continue

    const properties = new Map<number, string | number | Date>()
    for (const field of OLE2_FIELDS.filter((f) => f.stream === group)) {
      const value = (values[field.key] ?? '').trim()
      if (value === '') continue
      if (field.kind === 'number') {
        if (/^-?\d+$/.test(value)) properties.set(field.id, Number(value))
      } else if (field.kind === 'datetime') {
        const date = new Date(value)
        if (!Number.isNaN(date.getTime())) properties.set(field.id, date)
      } else {
        properties.set(field.id, value)
      }
    }

    const built = buildPropertySet(fmtid, properties)
    if (!writeStream(out, location, built)) {
      return {
        bytes,
        steps,
        error:
          'Die neuen Werte brauchen mehr Platz, als das alte Format in dieser Datei vorsieht. Kürzere Texte verwenden oder die Datei als .docx/.xlsx speichern.',
      }
    }
    steps.push(`${streamName.slice(1)} neu geschrieben (${properties.size} Eigenschaft(en))`)
  }

  return { bytes: out, steps }
}
