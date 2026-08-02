/**
 * PDF cleaning.
 *
 * Editing a PDF in place would be pointless: PDFs grow by appending, so an old
 * title — or a paragraph someone deleted — is still sitting in an earlier
 * revision further up the file. The only honest fix is to write a fresh file
 * containing just the objects the current document actually reaches.
 *
 * That is what happens here:
 *   1. every `n 0 obj … endobj` in the file is collected, later definitions
 *      winning over earlier ones (that is what "current revision" means),
 *   2. object streams are unpacked so their contents join the same pool,
 *   3. starting from the catalogue, all reachable objects are copied into a
 *      new file with a fresh cross-reference table.
 *
 * Anything not reachable — old revisions, orphaned pages, the discarded
 * signature of a previous version — simply does not get written.
 *
 * Encrypted files are refused rather than mangled.
 */

export interface PdfInfo {
  values: Record<string, string>
  findings: PdfFinding[]
  /** Set when the file cannot be cleaned; cleaning must then not be offered. */
  error?: string
}

export interface PdfFinding {
  id: string
  label: string
  detail: string
  severity: 'hoch' | 'mittel' | 'niedrig'
}

export interface PdfCleanOptions {
  removeXmp: boolean
  removeJavaScript: boolean
  removeEmbeddedFiles: boolean
  removeAnnotations: boolean
  dropOldRevisions: boolean
}

export const DEFAULT_PDF_CLEAN: PdfCleanOptions = {
  removeXmp: true,
  removeJavaScript: true,
  removeEmbeddedFiles: true,
  removeAnnotations: false,
  dropOldRevisions: true,
}

export const PDF_FIELDS = [
  { key: 'Title', label: 'Titel' },
  { key: 'Subject', label: 'Thema' },
  { key: 'Author', label: 'Autor' },
  { key: 'Keywords', label: 'Stichwörter' },
  { key: 'Creator', label: 'Erstellt mit' },
  { key: 'Producer', label: 'PDF-Erzeuger' },
  { key: 'CreationDate', label: 'Erstellt am' },
  { key: 'ModDate', label: 'Geändert am' },
]

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

type PdfValue =
  | { t: 'num'; v: number }
  | { t: 'name'; v: string }
  | { t: 'str'; v: string; hex: boolean }
  | { t: 'arr'; v: PdfValue[] }
  | { t: 'dict'; v: Map<string, PdfValue> }
  | { t: 'ref'; num: number; gen: number }
  | { t: 'bool'; v: boolean }
  | { t: 'null' }
  | { t: 'stream'; dict: Map<string, PdfValue>; data: Uint8Array }

const isWhite = (c: number) => c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09 || c === 0x0c || c === 0x00
const isDelim = (c: number) => [0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x2f, 0x25].includes(c)
const latin1 = new TextDecoder('latin1')

class Lexer {
  constructor(
    readonly bytes: Uint8Array,
    public pos = 0
  ) {}

  skip(): void {
    while (this.pos < this.bytes.length) {
      const c = this.bytes[this.pos]
      if (isWhite(c)) this.pos++
      else if (c === 0x25) {
        while (this.pos < this.bytes.length && this.bytes[this.pos] !== 0x0a) this.pos++
      } else break
    }
  }

  peekKeyword(word: string): boolean {
    this.skip()
    return latin1.decode(this.bytes.subarray(this.pos, this.pos + word.length)) === word
  }

  readToken(): string {
    this.skip()
    const start = this.pos
    while (this.pos < this.bytes.length && !isWhite(this.bytes[this.pos]) && !isDelim(this.bytes[this.pos])) this.pos++
    if (this.pos === start) this.pos++
    return latin1.decode(this.bytes.subarray(start, this.pos))
  }

  parse(depth = 0): PdfValue {
    this.skip()
    if (this.pos >= this.bytes.length || depth > 64) return { t: 'null' }
    const c = this.bytes[this.pos]

    if (c === 0x2f) {
      this.pos++
      const start = this.pos
      while (this.pos < this.bytes.length && !isWhite(this.bytes[this.pos]) && !isDelim(this.bytes[this.pos])) this.pos++
      return { t: 'name', v: decodeName(latin1.decode(this.bytes.subarray(start, this.pos))) }
    }

    if (c === 0x28) return this.parseLiteralString()

    if (c === 0x3c) {
      if (this.bytes[this.pos + 1] === 0x3c) return this.parseDict(depth)
      return this.parseHexString()
    }

    if (c === 0x5b) {
      this.pos++
      const items: PdfValue[] = []
      while (this.pos < this.bytes.length) {
        this.skip()
        if (this.bytes[this.pos] === 0x5d) {
          this.pos++
          break
        }
        const before = this.pos
        items.push(this.parse(depth + 1))
        if (this.pos === before) {
          this.pos++
          break
        }
      }
      return { t: 'arr', v: items }
    }

    if (c === 0x5d || c === 0x3e || c === 0x29 || c === 0x7d) {
      this.pos++
      return { t: 'null' }
    }

    const token = this.readToken()
    if (token === 'true') return { t: 'bool', v: true }
    if (token === 'false') return { t: 'bool', v: false }
    if (token === 'null' || token === '') return { t: 'null' }

    if (/^[+-]?[\d.]+$/.test(token)) {
      // Could be "12 0 R" — look ahead without consuming on failure.
      const save = this.pos
      if (/^\d+$/.test(token)) {
        const gen = this.readToken()
        if (/^\d+$/.test(gen)) {
          const keyword = this.readToken()
          if (keyword === 'R') return { t: 'ref', num: Number(token), gen: Number(gen) }
        }
        this.pos = save
      }
      return { t: 'num', v: Number(token) }
    }

    return { t: 'null' }
  }

  private parseDict(depth: number): PdfValue {
    this.pos += 2
    const map = new Map<string, PdfValue>()
    while (this.pos < this.bytes.length) {
      this.skip()
      if (this.bytes[this.pos] === 0x3e && this.bytes[this.pos + 1] === 0x3e) {
        this.pos += 2
        break
      }
      const key = this.parse(depth + 1)
      if (key.t !== 'name') {
        if (this.pos >= this.bytes.length) break
        continue
      }
      map.set(key.v, this.parse(depth + 1))
    }

    // A stream follows its dictionary.
    const save = this.pos
    this.skip()
    if (latin1.decode(this.bytes.subarray(this.pos, this.pos + 6)) === 'stream') {
      this.pos += 6
      if (this.bytes[this.pos] === 0x0d) this.pos++
      if (this.bytes[this.pos] === 0x0a) this.pos++
      const start = this.pos
      const declared = map.get('Length')
      let end = declared?.t === 'num' ? start + declared.v : -1
      if (end < 0 || end > this.bytes.length || !endsWithEndstream(this.bytes, end)) {
        end = indexOfSequence(this.bytes, 'endstream', start)
        if (end < 0) end = this.bytes.length
        while (end > start && isWhite(this.bytes[end - 1])) end--
      }
      const data = this.bytes.subarray(start, end)
      this.pos = Math.min(this.bytes.length, indexOfSequence(this.bytes, 'endstream', end) + 9)
      return { t: 'stream', dict: map, data }
    }
    this.pos = save

    return { t: 'dict', v: map }
  }

  private parseLiteralString(): PdfValue {
    this.pos++
    let depth = 1
    let out = ''
    while (this.pos < this.bytes.length) {
      const c = this.bytes[this.pos++]
      if (c === 0x5c) {
        out += String.fromCharCode(this.bytes[this.pos++])
        continue
      }
      if (c === 0x28) depth++
      if (c === 0x29) {
        depth--
        if (depth === 0) break
      }
      out += String.fromCharCode(c)
    }
    return { t: 'str', v: out, hex: false }
  }

  private parseHexString(): PdfValue {
    this.pos++
    let hex = ''
    while (this.pos < this.bytes.length && this.bytes[this.pos] !== 0x3e) {
      const c = String.fromCharCode(this.bytes[this.pos++])
      if (/[0-9a-fA-F]/.test(c)) hex += c
    }
    this.pos++
    let out = ''
    for (let i = 0; i < hex.length; i += 2) out += String.fromCharCode(parseInt(hex.substr(i, 2).padEnd(2, '0'), 16))
    return { t: 'str', v: out, hex: true }
  }
}

const decodeName = (name: string) => name.replace(/#([0-9a-fA-F]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))

function endsWithEndstream(bytes: Uint8Array, at: number): boolean {
  let i = at
  while (i < bytes.length && isWhite(bytes[i])) i++
  return latin1.decode(bytes.subarray(i, i + 9)) === 'endstream'
}

function indexOfSequence(bytes: Uint8Array, text: string, from: number): number {
  const needle = new TextEncoder().encode(text)
  outer: for (let i = Math.max(0, from); i <= bytes.length - needle.length; i++) {
    for (let k = 0; k < needle.length; k++) if (bytes[i + k] !== needle[k]) continue outer
    return i
  }
  return -1
}

// ---------------------------------------------------------------------------
// Document
// ---------------------------------------------------------------------------

interface PdfDocument {
  objects: Map<number, PdfValue>
  trailer: Map<string, PdfValue>
  encrypted: boolean
  revisions: number
  /** Object numbers that came out of an object stream. */
  fromObjectStreams: Set<number>
}

async function inflate(data: Uint8Array): Promise<Uint8Array | null> {
  for (const format of ['deflate', 'deflate-raw'] as const) {
    try {
      const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream(format))
      return new Uint8Array(await new Response(stream).arrayBuffer())
    } catch {
      // try the next framing
    }
  }
  return null
}

async function parsePdf(bytes: Uint8Array): Promise<PdfDocument> {
  const objects = new Map<number, PdfValue>()
  const trailer = new Map<string, PdfValue>()
  const fromObjectStreams = new Set<number>()

  // Every "n g obj" in file order; later definitions replace earlier ones.
  const text = latin1.decode(bytes)
  const objectPattern = /(\d+)\s+(\d+)\s+obj\b/g
  let match: RegExpExecArray | null
  while ((match = objectPattern.exec(text))) {
    const lexer = new Lexer(bytes, match.index + match[0].length)
    const value = lexer.parse()
    objects.set(Number(match[1]), value)
  }

  // Trailer dictionaries, again later-wins.
  const trailerPattern = /trailer\b/g
  while ((match = trailerPattern.exec(text))) {
    const lexer = new Lexer(bytes, match.index + 7)
    const value = lexer.parse()
    if (value.t === 'dict') for (const [key, entry] of Array.from(value.v.entries())) trailer.set(key, entry)
  }

  // Cross-reference streams carry the same information in newer files.
  for (const [, value] of Array.from(objects.entries())) {
    const dict = value.t === 'stream' ? value.dict : value.t === 'dict' ? value.v : null
    if (!dict) continue
    const type = dict.get('Type')
    if (type?.t === 'name' && type.v === 'XRef') {
      for (const key of ['Root', 'Info', 'Encrypt']) {
        const entry = dict.get(key)
        if (entry && !trailer.has(key)) trailer.set(key, entry)
      }
    }
  }

  // Unpack object streams so their objects join the pool.
  for (const [, value] of Array.from(objects.entries())) {
    if (value.t !== 'stream') continue
    const type = value.dict.get('Type')
    if (type?.t !== 'name' || type.v !== 'ObjStm') continue
    const filter = value.dict.get('Filter')
    const filterName = filter?.t === 'name' ? filter.v : filter?.t === 'arr' && filter.v[0]?.t === 'name' ? filter.v[0].v : ''
    const data = filterName === 'FlateDecode' ? await inflate(value.data) : value.data
    if (!data) continue

    const count = value.dict.get('N')
    const first = value.dict.get('First')
    if (count?.t !== 'num' || first?.t !== 'num') continue

    const header = new Lexer(data, 0)
    const pairs: { num: number; offset: number }[] = []
    for (let i = 0; i < count.v; i++) {
      const num = Number(header.readToken())
      const offset = Number(header.readToken())
      if (Number.isNaN(num) || Number.isNaN(offset)) break
      pairs.push({ num, offset })
    }
    for (const pair of pairs) {
      const lexer = new Lexer(data, first.v + pair.offset)
      objects.set(pair.num, lexer.parse())
      fromObjectStreams.add(pair.num)
    }
  }

  const revisions = (text.match(/%%EOF/g) ?? []).length

  return { objects, trailer, encrypted: trailer.has('Encrypt'), revisions, fromObjectStreams }
}

const resolve = (doc: PdfDocument, value: PdfValue | undefined): PdfValue | undefined =>
  value?.t === 'ref' ? doc.objects.get(value.num) : value

function dictOf(value: PdfValue | undefined): Map<string, PdfValue> | null {
  if (!value) return null
  if (value.t === 'dict') return value.v
  if (value.t === 'stream') return value.dict
  return null
}

/** PDF date strings look like D:20240201100000+01'00'. */
function pdfDateToIso(value: string): string {
  const match = /^D?:?(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?/.exec(value)
  if (!match) return value
  const [, y, mo = '01', d = '01', h = '00', mi = '00', s = '00'] = match
  return `${y}-${mo}-${d}T${h}:${mi}:${s}Z`
}

function isoToPdfDate(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  const pad = (n: number) => String(n).padStart(2, '0')
  return `D:${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`
}

// ---------------------------------------------------------------------------
// Inspection
// ---------------------------------------------------------------------------

export async function readPdf(bytes: Uint8Array): Promise<PdfInfo> {
  const values: Record<string, string> = {}
  const findings: PdfFinding[] = []

  if (latin1.decode(bytes.subarray(0, 5)) !== '%PDF-') {
    return { values, findings, error: 'Das ist keine PDF-Datei.' }
  }

  const doc = await parsePdf(bytes)

  if (doc.encrypted) {
    return {
      values,
      findings: [
        {
          id: 'encrypted',
          label: 'Verschlüsselte PDF-Datei',
          detail:
            'Verschlüsselte PDFs werden nicht bearbeitet — ein Rettungsversuch würde die Datei zerstören. Bitte in einem PDF-Programm ohne Schutz neu speichern.',
          severity: 'hoch',
        },
      ],
      error: 'PDF ist verschlüsselt.',
    }
  }

  const info = dictOf(resolve(doc, doc.trailer.get('Info')))
  for (const field of PDF_FIELDS) {
    const value = info?.get(field.key)
    if (value?.t === 'str') {
      values[field.key] = field.key.endsWith('Date') ? pdfDateToIso(value.v) : decodePdfText(value.v)
    } else {
      values[field.key] = ''
    }
  }

  if (info && Array.from(info.keys()).length > 0) {
    const extra = Array.from(info.keys()).filter((key) => !PDF_FIELDS.some((f) => f.key === key))
    if (extra.length > 0) {
      findings.push({
        id: 'infoExtra',
        label: `Zusätzliche Info-Einträge: ${extra.join(', ')}`,
        detail: 'Programme legen im Info-Wörterbuch eigene Felder ab, etwa Bearbeiter oder interne Kennungen.',
        severity: 'mittel',
      })
    }
  }

  const root = dictOf(resolve(doc, doc.trailer.get('Root')))
  if (root?.has('Metadata')) {
    findings.push({
      id: 'xmp',
      label: 'XMP-Metadaten',
      detail: 'Der XMP-Block enthält oft einen Bearbeitungsverlauf mit Programmen, Zeitstempeln und Dokument-IDs.',
      severity: 'mittel',
    })
  }

  if (doc.revisions > 1) {
    findings.push({
      id: 'revisions',
      label: `${doc.revisions} gespeicherte Fassungen in einer Datei`,
      detail:
        'PDFs wachsen beim Speichern an: ältere Fassungen bleiben vollständig erhalten und lassen sich wiederherstellen — samt Text, den jemand später entfernt hat.',
      severity: 'hoch',
    })
  }

  const names = dictOf(resolve(doc, root?.get('Names')))
  if (names?.has('JavaScript') || hasKeyAnywhere(doc, 'JS')) {
    findings.push({
      id: 'javascript',
      label: 'Eingebettetes JavaScript',
      detail: 'Skripte im Dokument können beim Öffnen ausgeführt werden und sind ein Sicherheitsrisiko.',
      severity: 'hoch',
    })
  }
  if (names?.has('EmbeddedFiles') || countEmbeddedFiles(doc) > 0) {
    findings.push({
      id: 'embeddedFiles',
      label: 'Eingebettete Dateien',
      detail: 'Angehängte Dateien bringen ihre eigenen Metadaten mit und werden beim Lesen leicht übersehen.',
      severity: 'hoch',
    })
  }

  const annotations = countAnnotations(doc)
  if (annotations > 0) {
    findings.push({
      id: 'annotations',
      label: `${annotations} Anmerkung(en)`,
      detail: 'Kommentare, Notizen und Formularfelder enthalten Autorennamen und Zeitstempel.',
      severity: 'mittel',
    })
  }

  const orphans = countUnreachable(doc)
  if (orphans > 0) {
    findings.push({
      id: 'orphans',
      label: `${orphans} nicht mehr erreichbare Objekte`,
      detail:
        'Diese Objekte gehören zu keiner Seite mehr — typischerweise Reste gelöschter Inhalte. Beim Neuschreiben fallen sie weg.',
      severity: 'mittel',
    })
  }

  return { values, findings }
}

function decodePdfText(value: string): string {
  // UTF-16BE strings start with a byte order mark.
  if (value.charCodeAt(0) === 0xfe && value.charCodeAt(1) === 0xff) {
    let out = ''
    for (let i = 2; i + 1 < value.length; i += 2) out += String.fromCharCode((value.charCodeAt(i) << 8) | value.charCodeAt(i + 1))
    return out
  }
  return value
}

/** Attachments arrive either through the name tree or as an annotation. */
function countEmbeddedFiles(doc: PdfDocument): number {
  let count = 0
  for (const [, value] of Array.from(doc.objects.entries())) {
    const dict = dictOf(value)
    if (!dict) continue
    const type = dict.get('Type')
    const subtype = dict.get('Subtype')
    if (type?.t === 'name' && type.v === 'EmbeddedFile') count++
    else if (subtype?.t === 'name' && subtype.v === 'FileAttachment') count++
  }
  return count
}

/** Searches every dictionary in the file, including nested ones. */
function hasKeyAnywhere(doc: PdfDocument, key: string): boolean {
  const seen = new Set<PdfValue>()
  const visit = (value: PdfValue | undefined, depth: number): boolean => {
    if (!value || depth > 32 || seen.has(value)) return false
    seen.add(value)
    if (value.t === 'arr') return value.v.some((item) => visit(item, depth + 1))
    const dict = dictOf(value)
    if (!dict) return false
    if (dict.has(key)) return true
    const subtype = dict.get('Subtype')
    if (subtype?.t === 'name' && subtype.v === key) return true
    return Array.from(dict.values()).some((entry) => visit(entry, depth + 1))
  }
  return Array.from(doc.objects.values()).some((value) => visit(value, 0))
}

function countAnnotations(doc: PdfDocument): number {
  let count = 0
  for (const [, value] of Array.from(doc.objects.entries())) {
    const dict = dictOf(value)
    const type = dict?.get('Type')
    if (type?.t === 'name' && type.v === 'Annot') count++
  }
  return count
}

function reachable(doc: PdfDocument, roots: PdfValue[]): Set<number> {
  const seen = new Set<number>()
  const queue: PdfValue[] = [...roots]

  while (queue.length > 0) {
    const value = queue.pop()!
    if (value.t === 'ref') {
      if (seen.has(value.num)) continue
      seen.add(value.num)
      const target = doc.objects.get(value.num)
      if (target) queue.push(target)
    } else if (value.t === 'arr') {
      queue.push(...value.v)
    } else if (value.t === 'dict') {
      queue.push(...Array.from(value.v.values()))
    } else if (value.t === 'stream') {
      queue.push(...Array.from(value.dict.values()))
    }
  }
  return seen
}

function countUnreachable(doc: PdfDocument): number {
  const root = doc.trailer.get('Root')
  if (!root) return 0
  // The Info dictionary hangs off the trailer, not off the catalogue.
  const roots = [root, doc.trailer.get('Info')].filter(Boolean) as PdfValue[]
  const live = reachable(doc, roots)
  let count = 0
  for (const [num] of Array.from(doc.objects.entries())) {
    if (!live.has(num)) count++
  }
  return count
}

/** Structural summary, used by the report and by the safety check. */
export async function pdfStructure(bytes: Uint8Array): Promise<{
  pages: number
  objects: number
  revisions: number
  encrypted: boolean
}> {
  const doc = await parsePdf(bytes)
  return { pages: countPages(doc), objects: doc.objects.size, revisions: doc.revisions, encrypted: doc.encrypted }
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

export interface PdfCleanResult {
  bytes: Uint8Array
  steps: string[]
  error?: string
}

export async function cleanPdf(
  bytes: Uint8Array,
  values: Record<string, string>,
  options: PdfCleanOptions
): Promise<PdfCleanResult> {
  const doc = await parsePdf(bytes)
  const steps: string[] = []

  if (doc.encrypted) return { bytes, steps, error: 'Verschlüsselte PDFs werden nicht verändert.' }
  const rootRef = doc.trailer.get('Root')
  if (!rootRef) return { bytes, steps, error: 'Im PDF wurde kein Dokumentkatalog gefunden — Bereinigung abgelehnt.' }

  const root = dictOf(resolve(doc, rootRef))
  if (!root) return { bytes, steps, error: 'Der Dokumentkatalog ist unlesbar — Bereinigung abgelehnt.' }

  if (options.removeXmp && root.delete('Metadata')) steps.push('XMP-Metadaten entfernt')

  if (options.removeJavaScript) {
    const names = dictOf(resolve(doc, root.get('Names')))
    let removed = names?.delete('JavaScript') ?? false
    // An OpenAction is usually just "jump to page 1" — only a script goes.
    const openAction = dictOf(resolve(doc, root.get('OpenAction')))
    const actionType = openAction?.get('S')
    if (openAction?.has('JS') || (actionType?.t === 'name' && actionType.v === 'JavaScript')) {
      root.delete('OpenAction')
      removed = true
    }
    for (const [, value] of Array.from(doc.objects.entries())) {
      const dict = dictOf(value)
      if (dict?.delete('JS')) removed = true
    }
    if (removed) steps.push('JavaScript entfernt')
  }

  if (options.removeEmbeddedFiles) {
    const names = dictOf(resolve(doc, root.get('Names')))
    let removed = names?.delete('EmbeddedFiles') ?? false
    // Attachments also ride along as annotations on a page.
    for (const [, value] of Array.from(doc.objects.entries())) {
      const dict = dictOf(value)
      const annots = resolve(doc, dict?.get('Annots'))
      if (!dict || annots?.t !== 'arr') continue
      const kept = annots.v.filter((item) => {
        const annot = dictOf(resolve(doc, item))
        const subtype = annot?.get('Subtype')
        return !(subtype?.t === 'name' && subtype.v === 'FileAttachment')
      })
      if (kept.length === annots.v.length) continue
      annots.v = kept
      removed = true
    }
    // The file streams themselves become unreachable and are dropped below.
    if (removed) steps.push('Eingebettete Dateien entfernt')
  }

  if (options.removeAnnotations) {
    let count = 0
    for (const [, value] of Array.from(doc.objects.entries())) {
      const dict = dictOf(value)
      const type = dict?.get('Type')
      if (type?.t === 'name' && type.v === 'Page' && dict?.has('Annots')) {
        dict.delete('Annots')
        count++
      }
    }
    if (count > 0) steps.push(`Anmerkungen von ${count} Seite(n) entfernt`)
  }

  // Build the new Info dictionary from the edited values.
  const infoEntries = new Map<string, PdfValue>()
  for (const field of PDF_FIELDS) {
    const value = (values[field.key] ?? '').trim()
    if (value === '') continue
    infoEntries.set(field.key, { t: 'str', v: field.key.endsWith('Date') ? isoToPdfDate(value) : value, hex: false })
  }

  const pagesBefore = countPages(doc)
  const live = reachable(doc, [rootRef])
  const dropped = doc.objects.size - live.size
  if (dropped > 0 && options.dropOldRevisions) steps.push(`${dropped} nicht erreichbare Objekte weggelassen`)
  if (doc.revisions > 1) steps.push(`${doc.revisions - 1} ältere Fassung(en) verworfen`)

  const keep = options.dropOldRevisions ? live : new Set(Array.from(doc.objects.keys()))
  const out = serialize(doc, keep, rootRef, infoEntries)

  // Never hand back a file we broke: re-read it and compare the page count.
  const check = await parsePdf(out)
  const pagesAfter = countPages(check)
  if (pagesBefore > 0 && pagesAfter !== pagesBefore) {
    return {
      bytes,
      steps,
      error: `Sicherheitsprüfung fehlgeschlagen: vorher ${pagesBefore} Seiten, nachher ${pagesAfter}. Die Datei wurde nicht verändert.`,
    }
  }

  if (infoEntries.size > 0) steps.push(`Info-Wörterbuch neu geschrieben (${infoEntries.size} Feld(er))`)
  else steps.push('Info-Wörterbuch entfernt')

  return { bytes: out, steps }
}

function countPages(doc: PdfDocument): number {
  let count = 0
  for (const [, value] of Array.from(doc.objects.entries())) {
    const dict = dictOf(value)
    const type = dict?.get('Type')
    if (type?.t === 'name' && type.v === 'Page') count++
  }
  return count
}

function serialize(
  doc: PdfDocument,
  keep: Set<number>,
  rootRef: PdfValue,
  infoEntries: Map<string, PdfValue>
): Uint8Array {
  const chunks: Uint8Array[] = []
  const encoder = new TextEncoder()
  const push = (text: string) => chunks.push(encoder.encode(text))
  let offset = 0
  const offsets = new Map<number, number>()
  const track = (chunk: Uint8Array) => {
    chunks.push(chunk)
    offset += chunk.length
  }
  const write = (text: string) => track(encoder.encode(text))

  write('%PDF-1.7\n%\xE2\xE3\xCF\xD3\n')

  const numbers = Array.from(keep).sort((a, b) => a - b)
  const maxNumber = numbers.length > 0 ? numbers[numbers.length - 1] : 0
  const infoNumber = maxNumber + 1

  for (const num of numbers) {
    const value = doc.objects.get(num)
    if (!value) continue
    // Object streams were unpacked; writing them again would duplicate content.
    const dict = dictOf(value)
    const type = dict?.get('Type')
    if (type?.t === 'name' && (type.v === 'ObjStm' || type.v === 'XRef')) continue

    offsets.set(num, offset)
    write(`${num} 0 obj\n`)
    if (value.t === 'stream') {
      write(serializeValue({ t: 'dict', v: withLength(value) }))
      write('\nstream\n')
      track(value.data)
      write('\nendstream')
    } else {
      write(serializeValue(value))
    }
    write('\nendobj\n')
  }

  if (infoEntries.size > 0) {
    offsets.set(infoNumber, offset)
    write(`${infoNumber} 0 obj\n`)
    write(serializeValue({ t: 'dict', v: infoEntries }))
    write('\nendobj\n')
  }

  const size = (infoEntries.size > 0 ? infoNumber : maxNumber) + 1
  const xrefOffset = offset
  write('xref\n')
  write(`0 ${size}\n`)
  write('0000000000 65535 f \n')
  for (let num = 1; num < size; num++) {
    const at = offsets.get(num)
    write(at === undefined ? '0000000000 65535 f \n' : `${String(at).padStart(10, '0')} 00000 n \n`)
  }

  const rootNumber = rootRef.t === 'ref' ? rootRef.num : 0
  write('trailer\n')
  write(`<< /Size ${size} /Root ${rootNumber} 0 R`)
  if (infoEntries.size > 0) write(` /Info ${infoNumber} 0 R`)
  write(' >>\n')
  write(`startxref\n${xrefOffset}\n%%EOF\n`)

  void push
  const total = chunks.reduce((sum, c) => sum + c.length, 0)
  const out = new Uint8Array(total)
  let at = 0
  for (const chunk of chunks) {
    out.set(chunk, at)
    at += chunk.length
  }
  return out
}

function withLength(stream: { dict: Map<string, PdfValue>; data: Uint8Array }): Map<string, PdfValue> {
  const dict = new Map(stream.dict)
  dict.set('Length', { t: 'num', v: stream.data.length })
  return dict
}

function serializeValue(value: PdfValue): string {
  switch (value.t) {
    case 'num':
      return Number.isInteger(value.v) ? String(value.v) : String(Number(value.v.toFixed(6)))
    case 'name':
      return '/' + value.v.replace(/[^\x21-\x7e]|[#()<>[\]{}/%]/g, (c) => '#' + c.charCodeAt(0).toString(16).padStart(2, '0'))
    case 'bool':
      return value.v ? 'true' : 'false'
    case 'null':
      return 'null'
    case 'ref':
      return `${value.num} ${value.gen} R`
    case 'str':
      return serializeString(value.v)
    case 'arr':
      return `[ ${value.v.map(serializeValue).join(' ')} ]`
    case 'dict':
      return `<< ${Array.from(value.v.entries()).map(([key, entry]) => `${serializeValue({ t: 'name', v: key })} ${serializeValue(entry)}`).join(' ')} >>`
    case 'stream':
      return serializeValue({ t: 'dict', v: value.dict })
  }
}

function serializeString(value: string): string {
  const needsUtf16 = /[^\x20-\x7e]/.test(value)
  if (needsUtf16) {
    let hex = 'FEFF'
    for (const char of value) {
      const code = char.codePointAt(0) ?? 0
      hex += code.toString(16).padStart(4, '0').toUpperCase()
    }
    return `<${hex}>`
  }
  return `(${value.replace(/[\\()]/g, (c) => '\\' + c)})`
}
