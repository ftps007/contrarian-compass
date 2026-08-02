/**
 * OpenDocument (.odt/.ods/.odp) — LibreOffice's format.
 *
 * Like OOXML it is a ZIP of XML parts, so the ZIP layer is shared; only the
 * metadata lives elsewhere: meta.xml instead of docProps, Pictures/ instead of
 * media/, and a preview image under Thumbnails/.
 */

import type { ZipEntry } from './zip'
import { inspectImage, stripImageMetadata } from './imageMeta'
import { decodeText, editParts, encodeText, findEntry, parseXml, removeParts, serializeXml, setText, textOf } from './ooxmlPackage'

export const ODF_NS = {
  office: 'urn:oasis:names:tc:opendocument:xmlns:office:1.0',
  meta: 'urn:oasis:names:tc:opendocument:xmlns:meta:1.0',
  dc: 'http://purl.org/dc/elements/1.1/',
  text: 'urn:oasis:names:tc:opendocument:xmlns:text:1.0',
}

const META_PART = 'meta.xml'
const PICTURES = /^Pictures\//

export interface OdfField {
  key: string
  label: string
  ns: string
  prefix: string
  tag: string
  kind: 'text' | 'datetime' | 'number'
}

export const ODF_FIELDS: OdfField[] = [
  { key: 'title', label: 'Titel', ns: ODF_NS.dc, prefix: 'dc', tag: 'title', kind: 'text' },
  { key: 'subject', label: 'Thema', ns: ODF_NS.dc, prefix: 'dc', tag: 'subject', kind: 'text' },
  { key: 'description', label: 'Kommentare', ns: ODF_NS.dc, prefix: 'dc', tag: 'description', kind: 'text' },
  { key: 'keyword', label: 'Stichwörter', ns: ODF_NS.meta, prefix: 'meta', tag: 'keyword', kind: 'text' },
  { key: 'initial-creator', label: 'Autor', ns: ODF_NS.meta, prefix: 'meta', tag: 'initial-creator', kind: 'text' },
  { key: 'creator', label: 'Zuletzt geändert von', ns: ODF_NS.dc, prefix: 'dc', tag: 'creator', kind: 'text' },
  { key: 'creation-date', label: 'Erstellt am', ns: ODF_NS.meta, prefix: 'meta', tag: 'creation-date', kind: 'datetime' },
  { key: 'date', label: 'Geändert am', ns: ODF_NS.dc, prefix: 'dc', tag: 'date', kind: 'datetime' },
  { key: 'print-date', label: 'Zuletzt gedruckt', ns: ODF_NS.meta, prefix: 'meta', tag: 'print-date', kind: 'datetime' },
  { key: 'printed-by', label: 'Gedruckt von', ns: ODF_NS.meta, prefix: 'meta', tag: 'printed-by', kind: 'text' },
  { key: 'generator', label: 'Erstellt mit', ns: ODF_NS.meta, prefix: 'meta', tag: 'generator', kind: 'text' },
  { key: 'editing-cycles', label: 'Bearbeitungszyklen', ns: ODF_NS.meta, prefix: 'meta', tag: 'editing-cycles', kind: 'number' },
  { key: 'editing-duration', label: 'Bearbeitungsdauer', ns: ODF_NS.meta, prefix: 'meta', tag: 'editing-duration', kind: 'text' },
]

export function isOdfPackage(entries: ZipEntry[]): boolean {
  const mimetype = textOf(entries, 'mimetype') ?? ''
  return mimetype.startsWith('application/vnd.oasis.opendocument') || Boolean(findEntry(entries, META_PART))
}

export function readOdfFields(entries: ZipEntry[]): Record<string, string> {
  const values: Record<string, string> = {}
  const xml = textOf(entries, META_PART)
  if (!xml) return values
  const doc = parseXml(xml, META_PART)
  for (const field of ODF_FIELDS) {
    const nodes = doc.getElementsByTagNameNS(field.ns, field.tag)
    values[field.key] = nodes.length > 0 ? nodes[0].textContent ?? '' : ''
  }
  return values
}

export function writeOdfFields(entries: ZipEntry[], values: Record<string, string>): void {
  const xml = textOf(entries, META_PART)
  if (!xml) return
  const doc = parseXml(xml, META_PART)
  const meta = doc.getElementsByTagNameNS(ODF_NS.office, 'meta')[0] ?? doc.documentElement

  for (const field of ODF_FIELDS) {
    const value = (values[field.key] ?? '').trim()
    const nodes = Array.from(doc.getElementsByTagNameNS(field.ns, field.tag))
    if (value === '') {
      for (const node of nodes) node.parentNode?.removeChild(node)
      continue
    }
    const node = nodes[0] ?? meta.appendChild(doc.createElementNS(field.ns, `${field.prefix}:${field.tag}`))
    node.textContent = value
  }

  // Word counts and per-user statistics are metadata too.
  for (const stat of Array.from(doc.getElementsByTagNameNS(ODF_NS.meta, 'document-statistic'))) {
    stat.parentNode?.removeChild(stat)
  }

  setText(entries, META_PART, serializeXml(doc))
}

export interface OdfCleanOptions {
  removeThumbnail: boolean
  stripImageMetadata: boolean
  anonymizeAuthors: boolean
  removeUserFields: boolean
}

export const DEFAULT_ODF_CLEAN: OdfCleanOptions = {
  removeThumbnail: true,
  stripImageMetadata: true,
  anonymizeAuthors: false,
  removeUserFields: true,
}

export function scanOdf(entries: ZipEntry[]): { id: string; label: string; detail: string; severity: 'hoch' | 'mittel' | 'niedrig' }[] {
  const findings = []
  const names = entries.map((e) => e.name)

  const images = entries.filter((e) => PICTURES.test(e.name) && inspectImage(e.data).length > 0)
  if (images.length > 0) {
    findings.push({
      id: 'imageMetadata',
      label: `Metadaten in ${images.length} eingebetteten Bild(ern)`,
      detail: 'Auch LibreOffice übernimmt EXIF-Daten samt GPS-Position unverändert in das Dokument.',
      severity: 'hoch' as const,
    })
  }
  if (names.some((n) => n.startsWith('Thumbnails/'))) {
    findings.push({
      id: 'thumbnail',
      label: 'Vorschaubild',
      detail: 'Zeigt die erste Seite in einem möglicherweise älteren Stand.',
      severity: 'mittel' as const,
    })
  }

  const content = textOf(entries, 'content.xml') ?? ''
  const authors = Array.from(content.matchAll(/<dc:creator>([^<]+)<\/dc:creator>/g)).map((m) => m[1])
  if (authors.length > 0) {
    findings.push({
      id: 'authors',
      label: `${new Set(authors).size} Personenname(n) in Kommentaren und Änderungen`,
      detail: `Gefunden: ${Array.from(new Set(authors)).join(', ')}.`,
      severity: 'hoch' as const,
    })
  }
  if (content.includes('<text:tracked-changes')) {
    findings.push({
      id: 'trackedChanges',
      label: 'Nachverfolgte Änderungen',
      detail: 'Enthalten Autorennamen und Zeitpunkte. In LibreOffice über „Bearbeiten → Änderungen → Alle akzeptieren" bereinigen.',
      severity: 'hoch' as const,
    })
  }
  const meta = textOf(entries, META_PART) ?? ''
  if (meta.includes('<meta:user-defined')) {
    findings.push({
      id: 'userFields',
      label: 'Benutzerdefinierte Felder',
      detail: 'Freie Felder in meta.xml, oft von Vorlagen mit Aktenzeichen oder Kürzeln gefüllt.',
      severity: 'mittel' as const,
    })
  }
  return findings
}

export function cleanOdf(entries: ZipEntry[], options: OdfCleanOptions): string[] {
  const steps: string[] = []

  if (options.removeThumbnail) {
    const removed = removeParts(entries, (name) => name.startsWith('Thumbnails/'))
    if (removed.length > 0) steps.push('Vorschaubild entfernt')
  }

  if (options.stripImageMetadata) {
    let cleaned = 0
    for (const entry of entries) {
      if (!PICTURES.test(entry.name)) continue
      const stripped = stripImageMetadata(entry.data)
      if (stripped.length !== entry.data.length) {
        entry.data = stripped
        cleaned++
      }
    }
    if (cleaned > 0) steps.push(`EXIF/XMP aus ${cleaned} Bild(ern) entfernt`)
  }

  if (options.removeUserFields) {
    const touched = editParts(
      entries,
      (name) => name === META_PART,
      (xml) => xml.replace(/<meta:user-defined[\s\S]*?<\/meta:user-defined>/g, '').replace(/<meta:user-defined[^/>]*\/>/g, '')
    )
    if (touched.length > 0) steps.push('Benutzerdefinierte Felder entfernt')
  }

  if (options.anonymizeAuthors) {
    const content = textOf(entries, 'content.xml') ?? ''
    const authors = Array.from(new Set(Array.from(content.matchAll(/<dc:creator>([^<]+)<\/dc:creator>/g)).map((m) => m[1])))
      .filter((name) => !/^Autor \d+$/.test(name))
    if (authors.length > 0) {
      const mapping = new Map(authors.map((name, index) => [name, `Autor ${index + 1}`] as [string, string]))
      editParts(
        entries,
        (name) => name.endsWith('.xml'),
        (xml) => {
          let next = xml
          for (const [from, to] of Array.from(mapping.entries())) {
            const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
            next = next.replace(new RegExp(`(<dc:creator>)${escaped}(</dc:creator>)`, 'g'), `$1${to}$2`)
          }
          return next
        }
      )
      steps.push(`${mapping.size} Name(n) ersetzt: ${Array.from(mapping.entries()).map(([f, t]) => `${f} → ${t}`).join(', ')}`)
    }
  }

  return steps
}

/** ODF requires the mimetype entry first and uncompressed. */
export function sortOdfEntries(entries: ZipEntry[]): ZipEntry[] {
  const mimetype = findEntry(entries, 'mimetype')
  if (!mimetype) return entries
  mimetype.method = 0
  return [mimetype, ...entries.filter((e) => e !== mimetype)]
}

export const odfDebug = { decodeText, encodeText }
