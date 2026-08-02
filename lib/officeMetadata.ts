/**
 * Read and rewrite the metadata of OOXML documents (.docx/.xlsx/.pptx and their
 * macro/template variants), plus optional removal of the secondary traces that
 * survive a plain property edit.
 *
 * Everything here operates on an in-memory package; nothing is uploaded.
 */

import { readZip, writeZip, type ZipEntry } from './zip'
import {
  CONTENT_TYPES,
  NS,
  ROOT_RELS,
  decodeText,
  encodeText,
  findEntry,
  firstByTag,
  parseXml,
  removeParts,
  serializeXml,
  setContentTypeOverride,
  setText,
  textOf,
} from './ooxmlPackage'

export { NS }

const CORE_PART = 'docProps/core.xml'
const APP_PART = 'docProps/app.xml'
const CUSTOM_PART = 'docProps/custom.xml'

export type FieldKind = 'text' | 'longtext' | 'datetime' | 'number'

export interface FieldDef {
  key: string
  label: string
  hint?: string
  kind: FieldKind
  part: 'core' | 'app'
  ns: string
  prefix: string
  tag: string
  /** dcterms fields need an xsi:type attribute to stay schema-valid. */
  w3cdtf?: boolean
}

export const FIELDS: FieldDef[] = [
  { key: 'title', label: 'Titel', kind: 'text', part: 'core', ns: NS.dc, prefix: 'dc', tag: 'title' },
  { key: 'subject', label: 'Thema', kind: 'text', part: 'core', ns: NS.dc, prefix: 'dc', tag: 'subject' },
  { key: 'creator', label: 'Autor', hint: 'dc:creator — der ursprüngliche Verfasser', kind: 'text', part: 'core', ns: NS.dc, prefix: 'dc', tag: 'creator' },
  { key: 'lastModifiedBy', label: 'Zuletzt geändert von', kind: 'text', part: 'core', ns: NS.cp, prefix: 'cp', tag: 'lastModifiedBy' },
  { key: 'keywords', label: 'Stichwörter', kind: 'text', part: 'core', ns: NS.cp, prefix: 'cp', tag: 'keywords' },
  { key: 'description', label: 'Kommentare', kind: 'longtext', part: 'core', ns: NS.dc, prefix: 'dc', tag: 'description' },
  { key: 'category', label: 'Kategorie', kind: 'text', part: 'core', ns: NS.cp, prefix: 'cp', tag: 'category' },
  { key: 'contentStatus', label: 'Status', kind: 'text', part: 'core', ns: NS.cp, prefix: 'cp', tag: 'contentStatus' },
  { key: 'revision', label: 'Revisionsnummer', hint: 'Wie oft das Dokument gespeichert wurde', kind: 'number', part: 'core', ns: NS.cp, prefix: 'cp', tag: 'revision' },
  { key: 'version', label: 'Version', kind: 'text', part: 'core', ns: NS.cp, prefix: 'cp', tag: 'version' },
  { key: 'language', label: 'Sprache', kind: 'text', part: 'core', ns: NS.dc, prefix: 'dc', tag: 'language' },
  { key: 'created', label: 'Erstellt am', kind: 'datetime', part: 'core', ns: NS.dcterms, prefix: 'dcterms', tag: 'created', w3cdtf: true },
  { key: 'modified', label: 'Geändert am', kind: 'datetime', part: 'core', ns: NS.dcterms, prefix: 'dcterms', tag: 'modified', w3cdtf: true },
  { key: 'lastPrinted', label: 'Zuletzt gedruckt', kind: 'datetime', part: 'core', ns: NS.cp, prefix: 'cp', tag: 'lastPrinted' },
  { key: 'Company', label: 'Firma', kind: 'text', part: 'app', ns: NS.ep, prefix: '', tag: 'Company' },
  { key: 'Manager', label: 'Vorgesetzter', kind: 'text', part: 'app', ns: NS.ep, prefix: '', tag: 'Manager' },
  { key: 'Application', label: 'Erstellt mit', hint: 'z. B. "Microsoft Office Word"', kind: 'text', part: 'app', ns: NS.ep, prefix: '', tag: 'Application' },
  { key: 'AppVersion', label: 'Programmversion', hint: 'Format: 16.0000', kind: 'text', part: 'app', ns: NS.ep, prefix: '', tag: 'AppVersion' },
  { key: 'Template', label: 'Vorlage', kind: 'text', part: 'app', ns: NS.ep, prefix: '', tag: 'Template' },
  { key: 'TotalTime', label: 'Bearbeitungszeit (Min.)', kind: 'number', part: 'app', ns: NS.ep, prefix: '', tag: 'TotalTime' },
  { key: 'HyperlinkBase', label: 'Hyperlink-Basis', hint: 'Enthält oft lokale Pfade', kind: 'text', part: 'app', ns: NS.ep, prefix: '', tag: 'HyperlinkBase' },
]

export interface CustomProp {
  name: string
  value: string
  /** Local name of the typed value element, e.g. "lpwstr" or "filetime". */
  type: string
}

export interface Trace {
  id: string
  label: string
  detail: string
  /** Whether the cleanup options can actually remove it. */
  removable: boolean
}

export interface OfficeDoc {
  fileName: string
  entries: ZipEntry[]
  values: Record<string, string>
  customProps: CustomProp[]
  traces: Trace[]
}

export interface CleanupOptions {
  stripRsids: boolean
  stripCustomProps: boolean
  stripThumbnail: boolean
  stripComments: boolean
  normalizeZipTimestamps: boolean
}

export const DEFAULT_CLEANUP: CleanupOptions = {
  stripRsids: true,
  stripCustomProps: false,
  stripThumbnail: true,
  stripComments: false,
  normalizeZipTimestamps: true,
}

export const SUPPORTED_EXTENSIONS = [
  '.docx', '.docm', '.dotx', '.dotm',
  '.xlsx', '.xlsm', '.xltx', '.xltm',
  '.pptx', '.pptm', '.potx', '.ppsx', '.ppsm',
]

/** W3CDTF ("2024-03-01T09:15:00Z") as used by dcterms fields. */
export function toW3CDTF(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z')
}

/** Value for an <input type="datetime-local">, in local time. */
export function toLocalInput(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

const CORE_TEMPLATE = `<cp:coreProperties xmlns:cp="${NS.cp}" xmlns:dc="${NS.dc}" xmlns:dcterms="${NS.dcterms}" xmlns:dcmitype="${NS.dcmitype}" xmlns:xsi="${NS.xsi}"/>`
const APP_TEMPLATE = `<Properties xmlns="${NS.ep}" xmlns:vt="${NS.vt}"/>`

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/** Property values of an already-unpacked package. */
export function readOfficeFields(entries: ZipEntry[]): Record<string, string> {
  const values: Record<string, string> = {}
  const coreXml = textOf(entries, CORE_PART)
  const appXml = textOf(entries, APP_PART)
  const coreDoc = coreXml ? parseXml(coreXml, CORE_PART) : null
  const appDoc = appXml ? parseXml(appXml, APP_PART) : null

  for (const field of FIELDS) {
    const doc = field.part === 'core' ? coreDoc : appDoc
    const el = doc ? firstByTag(doc, field.ns, field.tag) : null
    values[field.key] = el?.textContent ?? ''
  }
  return values
}

export async function loadDocument(file: { name: string; arrayBuffer(): Promise<ArrayBuffer> }): Promise<OfficeDoc> {
  const lower = file.name.toLowerCase()
  if (/\.(doc|xls|ppt)$/.test(lower)) {
    throw new Error(
      'Das alte Binärformat (.doc/.xls/.ppt) wird nicht unterstützt. In Word/Excel als .docx/.xlsx speichern und erneut versuchen.'
    )
  }

  const entries = await readZip(await file.arrayBuffer())
  if (!findEntry(entries, CONTENT_TYPES)) {
    throw new Error('Kein OOXML-Paket — die Datei enthält keine [Content_Types].xml.')
  }

  const values: Record<string, string> = {}
  const coreXml = textOf(entries, CORE_PART)
  const appXml = textOf(entries, APP_PART)
  const coreDoc = coreXml ? parseXml(coreXml, CORE_PART) : null
  const appDoc = appXml ? parseXml(appXml, APP_PART) : null

  for (const field of FIELDS) {
    const doc = field.part === 'core' ? coreDoc : appDoc
    if (!doc) continue
    const el = firstByTag(doc, field.ns, field.tag)
    values[field.key] = el?.textContent ?? ''
  }

  return {
    fileName: file.name,
    entries,
    values,
    customProps: readCustomProps(entries),
    traces: scanTraces(entries),
  }
}

export function readCustomProps(entries: ZipEntry[]): CustomProp[] {
  const xml = textOf(entries, CUSTOM_PART)
  if (!xml) return []
  const doc = parseXml(xml, CUSTOM_PART)
  const props: CustomProp[] = []
  const nodes = doc.getElementsByTagNameNS(NS.custom, 'property')
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i]
    const valueEl = Array.from(node.children).find((c) => c.namespaceURI === NS.vt)
    props.push({
      name: node.getAttribute('name') ?? `Eigenschaft ${i + 1}`,
      value: valueEl?.textContent ?? '',
      type: valueEl?.localName ?? 'lpwstr',
    })
  }
  return props
}

/** Everything that identifies the document beyond the property panel. */
export function scanTraces(entries: ZipEntry[]): Trace[] {
  const traces: Trace[] = []
  const names = entries.map((e) => e.name)

  const settings = textOf(entries, 'word/settings.xml') ?? ''
  const documentXml = textOf(entries, 'word/document.xml') ?? ''
  const rsidCount = (settings.match(/<w:rsid\b/g) ?? []).length
  if (rsidCount > 0 || /\sw:rsid[A-Za-z]*="/.test(documentXml)) {
    traces.push({
      id: 'rsids',
      label: `${rsidCount} RSIDs (Revision Save IDs)`,
      detail:
        'Word vergibt pro Bearbeitungssitzung eine ID. Damit lassen sich Dokumente derselben Herkunft einander zuordnen und Bearbeitungsrunden zählen.',
      removable: true,
    })
  }

  if (/<w:(ins|del|moveFrom|moveTo)\b/.test(documentXml)) {
    traces.push({
      id: 'trackedChanges',
      label: 'Nachverfolgte Änderungen im Text',
      detail:
        'Enthält Autornamen und Zeitstempel direkt im Inhalt. Muss in Word über „Überprüfen → Alle Änderungen annehmen" bereinigt werden — das ist Inhalt, keine Metadaten.',
      removable: false,
    })
  }

  const commentParts = names.filter((n) => /^word\/comments.*\.xml$/.test(n) || n === 'word/people.xml')
  if (commentParts.length > 0) {
    traces.push({
      id: 'comments',
      label: 'Kommentare / Personenliste',
      detail: `Enthaltene Teile: ${commentParts.join(', ')}. Speichern Autornamen und Initialen.`,
      removable: true,
    })
  }

  if (findEntry(entries, CUSTOM_PART)) {
    traces.push({
      id: 'customProps',
      label: 'Benutzerdefinierte Eigenschaften',
      detail: 'Werden oft von DMS-, Kanzlei- oder Vorlagensystemen gesetzt und enthalten Aktenzeichen oder Benutzer-IDs.',
      removable: true,
    })
  }

  if (names.some((n) => n.startsWith('docProps/thumbnail'))) {
    traces.push({
      id: 'thumbnail',
      label: 'Vorschaubild',
      detail: 'Zeigt die erste Seite im ursprünglichen Zustand — überlebt spätere Textänderungen.',
      removable: true,
    })
  }

  if (names.some((n) => n.startsWith('_xmlsignatures/'))) {
    traces.push({
      id: 'signature',
      label: 'Digitale Signatur',
      detail: 'Jede Änderung an der Datei macht die Signatur ungültig — das ist unmittelbar sichtbar.',
      removable: false,
    })
  }

  const dosDates = entries.map((e) => e.dosDate)
  if (new Set(dosDates).size > 1) {
    traces.push({
      id: 'zipTimestamps',
      label: 'Unterschiedliche ZIP-Zeitstempel',
      detail:
        'Jeder Teil im Paket trägt ein eigenes Datum. Passen die nicht zu den Dokumenteigenschaften, ist das ein deutliches Indiz für nachträgliche Bearbeitung.',
      removable: true,
    })
  }

  return traces
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

function ensureCoreElement(doc: Document, field: FieldDef): Element {
  const existing = firstByTag(doc, field.ns, field.tag)
  if (existing) return existing
  const qualified = field.prefix ? `${field.prefix}:${field.tag}` : field.tag
  const el = doc.createElementNS(field.ns, qualified)
  if (field.w3cdtf) el.setAttributeNS(NS.xsi, 'xsi:type', 'dcterms:W3CDTF')
  doc.documentElement.appendChild(el)
  return el
}

export function applyFields(entries: ZipEntry[], values: Record<string, string>, part: 'core' | 'app'): void {
  const partName = part === 'core' ? CORE_PART : APP_PART
  const fields = FIELDS.filter((f) => f.part === part)
  const wanted = fields.filter((f) => (values[f.key] ?? '').trim() !== '')

  const existing = textOf(entries, partName)
  if (!existing && wanted.length === 0) return

  const doc = parseXml(existing ?? (part === 'core' ? CORE_TEMPLATE : APP_TEMPLATE), partName)

  for (const field of fields) {
    const value = (values[field.key] ?? '').trim()
    const el = firstByTag(doc, field.ns, field.tag)
    if (value === '') {
      el?.parentNode?.removeChild(el)
      continue
    }
    ensureCoreElement(doc, field).textContent = value
  }

  setText(entries, partName, serializeXml(doc))
  ensureContentType(entries, partName)
  ensureRootRelationship(entries, partName)
}

function ensureContentType(entries: ZipEntry[], partName: string): void {
  const types: Record<string, string> = {
    [CORE_PART]: 'application/vnd.openxmlformats-package.core-properties+xml',
    [APP_PART]: 'application/vnd.openxmlformats-officedocument.extended-properties+xml',
  }
  const contentType = types[partName]
  if (contentType) setContentTypeOverride(entries, partName, contentType)
}

function ensureRootRelationship(entries: ZipEntry[], partName: string): void {
  const relTypes: Record<string, string> = {
    [CORE_PART]: 'http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties',
    [APP_PART]: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties',
  }
  const type = relTypes[partName]
  if (!type) return

  const xml = textOf(entries, ROOT_RELS)
  if (!xml) return
  const doc = parseXml(xml, ROOT_RELS)
  const rels = doc.getElementsByTagNameNS(NS.rel, 'Relationship')
  const used = new Set<string>()
  for (let i = 0; i < rels.length; i++) {
    const rel = rels[i]
    if (rel.getAttribute('Type') === type) return
    used.add(rel.getAttribute('Id') ?? '')
  }
  let n = 1
  while (used.has(`rId${n}`)) n++
  const rel = doc.createElementNS(NS.rel, 'Relationship')
  rel.setAttribute('Id', `rId${n}`)
  rel.setAttribute('Type', type)
  rel.setAttribute('Target', partName)
  doc.documentElement.appendChild(rel)
  setText(entries, ROOT_RELS, serializeXml(doc))
}

export function stripRsidsFromPackage(entries: ZipEntry[]): void {
  for (const entry of entries) {
    if (!/^word\/.*\.xml$/.test(entry.name)) continue
    const xml = decodeText(entry.data)
    const cleaned = xml
      .replace(/<w:rsids>[\s\S]*?<\/w:rsids>/g, '')
      .replace(/<w:rsid\b[^>]*\/>/g, '')
      .replace(/\s+w:rsid[A-Za-z]*="[^"]*"/g, '')
      .replace(/<w:proofState\b[^>]*\/>/g, '')
    if (cleaned !== xml) entry.data = encodeText(cleaned)
  }
}

export function stripCommentsFromPackage(entries: ZipEntry[]): void {
  removeParts(entries, (name) => /^word\/comments.*\.xml$/.test(name) || name === 'word/people.xml')

  const documentEntry = findEntry(entries, 'word/document.xml')
  if (!documentEntry) return
  const xml = decodeText(documentEntry.data)
  const cleaned = xml
    .replace(/<w:commentRange(?:Start|End)\b[^>]*\/>/g, '')
    .replace(/<w:commentReference\b[^>]*\/>/g, '')
    // The run wrapping a comment reference is left behind empty; drop it too.
    .replace(/<w:r>(?:\s*<w:rPr>[\s\S]*?<\/w:rPr>)?\s*<\/w:r>/g, '')
  if (cleaned !== xml) documentEntry.data = encodeText(cleaned)
}

export interface BuildResult {
  blob: Blob
  removedParts: string[]
}

export async function buildDocument(
  doc: OfficeDoc,
  values: Record<string, string>,
  customProps: CustomProp[],
  options: CleanupOptions
): Promise<BuildResult> {
  // Work on a copy so the loaded document stays reusable after a download.
  const entries: ZipEntry[] = doc.entries.map((e) => ({ ...e, data: new Uint8Array(e.data) }))
  const removedParts: string[] = []

  applyFields(entries, values, 'core')
  applyFields(entries, values, 'app')

  if (options.stripCustomProps) {
    removedParts.push(...removeParts(entries, (name) => name === CUSTOM_PART))
  } else {
    applyCustomProps(entries, customProps)
  }

  if (options.stripThumbnail) {
    removedParts.push(...removeParts(entries, (name) => name.startsWith('docProps/thumbnail')))
  }
  if (options.stripComments) {
    stripCommentsFromPackage(entries)
    removedParts.push('word/comments*.xml', 'word/people.xml')
  }
  if (options.stripRsids) stripRsidsFromPackage(entries)

  let timestamp: Date | undefined
  if (options.normalizeZipTimestamps) {
    const modified = new Date(values.modified || values.created || Date.now())
    timestamp = Number.isNaN(modified.getTime()) ? new Date() : modified
  }

  return { blob: await writeZip(entries, timestamp), removedParts }
}

export function applyCustomProps(entries: ZipEntry[], edited: CustomProp[]): void {
  const xml = textOf(entries, CUSTOM_PART)
  if (!xml) return

  const keptNames = new Set(edited.map((p) => p.name))
  const byName = new Map(edited.map((p) => [p.name, p] as [string, CustomProp]))
  const doc = parseXml(xml, CUSTOM_PART)
  const nodes = Array.from(doc.getElementsByTagNameNS(NS.custom, 'property'))

  for (const node of nodes) {
    const name = node.getAttribute('name') ?? ''
    if (!keptNames.has(name)) {
      node.parentNode?.removeChild(node)
      continue
    }
    const valueEl = Array.from(node.children).find((c) => c.namespaceURI === NS.vt)
    if (valueEl) valueEl.textContent = byName.get(name)?.value ?? ''
  }

  // An empty custom-properties part is itself a hint; drop it entirely.
  if (doc.getElementsByTagNameNS(NS.custom, 'property').length === 0) {
    removeParts(entries, (name) => name === CUSTOM_PART)
    return
  }

  // Renumber pids — they must be unique and start at 2.
  const remaining = Array.from(doc.getElementsByTagNameNS(NS.custom, 'property'))
  remaining.forEach((node, index) => node.setAttribute('pid', String(index + 2)))
  setText(entries, CUSTOM_PART, serializeXml(doc))
}
