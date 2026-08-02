/**
 * One entry point for every supported format.
 *
 * The UI (and the command line tool) only ever sees this module: hand it bytes
 * and a file name, get back the editable fields, a risk report and — after
 * cleaning — the new bytes plus a log of what was actually done.
 */

import { readZip, writeZip, type ZipEntry } from './zip'
import {
  DEFAULT_CLEANUP,
  FIELDS,
  applyCustomProps,
  applyFields,
  readCustomProps,
  readOfficeFields,
  scanTraces,
  stripCommentsFromPackage,
  stripRsidsFromPackage,
  toW3CDTF,
  type CleanupOptions,
  type CustomProp,
} from './officeMetadata'
import {
  DEFAULT_DEEP_OPTIONS,
  applyDeepClean,
  macroFreeExtension,
  scanDeep,
  type DeepOptions,
} from './ooxmlDeepClean'
import { removeParts } from './ooxmlPackage'
import { DEFAULT_ODF_CLEAN, ODF_FIELDS, cleanOdf, isOdfPackage, readOdfFields, scanOdf, sortOdfEntries, writeOdfFields, type OdfCleanOptions } from './odf'
import { DEFAULT_PDF_CLEAN, PDF_FIELDS, cleanPdf, readPdf, type PdfCleanOptions } from './pdf'
import { DEFAULT_RTF_CLEAN, RTF_FIELDS, cleanRtf, isRtf, readRtfFields, scanRtf, writeRtfFields, type RtfCleanOptions } from './rtf'
import { OLE2_FIELDS, isOle2, readOle2, writeOle2 } from './ole2'
import { detectFormat, inspectImage, stripImageMetadata } from './imageMeta'
import { detectMedia, inspectMedia, stripMediaMetadata } from './mediaMeta'

export type FileKind = 'ooxml' | 'odf' | 'pdf' | 'ole2' | 'rtf' | 'image' | 'media' | 'unbekannt'

export interface Field {
  key: string
  label: string
  kind: 'text' | 'longtext' | 'datetime' | 'number'
  hint?: string
  /** Layout hint for the UI. */
  group: 'Dokumenteigenschaften' | 'Erweiterte Eigenschaften'
}

export interface Finding {
  id: string
  label: string
  detail: string
  severity: 'hoch' | 'mittel' | 'niedrig'
  /** Name of the switch that removes it; absent means manual work. */
  option?: string
  parts?: string[]
}

export interface LoadedFile {
  name: string
  size: number
  kind: FileKind
  fields: Field[]
  values: Record<string, string>
  customProps: CustomProp[]
  findings: Finding[]
  sha256: string
  /** Present for ZIP-based formats. */
  entries?: ZipEntry[]
  /** Present for text-based formats. */
  text?: string
  bytes: Uint8Array
  /** Set when the file cannot be processed at all. */
  error?: string
}

export interface Options {
  base: CleanupOptions
  deep: DeepOptions
  odf: OdfCleanOptions
  pdf: PdfCleanOptions
  rtf: RtfCleanOptions
}

export const DEFAULT_OPTIONS: Options = {
  base: DEFAULT_CLEANUP,
  deep: DEFAULT_DEEP_OPTIONS,
  odf: DEFAULT_ODF_CLEAN,
  pdf: DEFAULT_PDF_CLEAN,
  rtf: DEFAULT_RTF_CLEAN,
}

const OOXML_EXT = ['.docx', '.docm', '.dotx', '.dotm', '.xlsx', '.xlsm', '.xltx', '.xltm', '.pptx', '.pptm', '.potx', '.ppsx', '.ppsm']
const ODF_EXT = ['.odt', '.ods', '.odp', '.odg', '.otm', '.ott', '.ots', '.otp']
const OLE2_EXT = ['.doc', '.xls', '.ppt', '.dot', '.xlt', '.pot']
const IMAGE_EXT = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.tif', '.tiff']
const MEDIA_EXT = ['.mp3', '.mp4', '.m4a', '.m4v', '.mov']

export const SUPPORTED_EXTENSIONS = [...OOXML_EXT, ...ODF_EXT, ...OLE2_EXT, '.pdf', '.rtf', ...IMAGE_EXT, ...MEDIA_EXT]

export async function sha256(bytes: Uint8Array): Promise<string> {
  if (typeof crypto === 'undefined' || !crypto.subtle) return ''
  const digest = await crypto.subtle.digest('SHA-256', bytes as unknown as ArrayBuffer)
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

function detectKind(name: string, bytes: Uint8Array): FileKind {
  const lower = name.toLowerCase()
  const isZip = bytes[0] === 0x50 && bytes[1] === 0x4b

  if (isZip) {
    if (ODF_EXT.some((ext) => lower.endsWith(ext))) return 'odf'
    if (OOXML_EXT.some((ext) => lower.endsWith(ext))) return 'ooxml'
    return 'ooxml' // decided properly once unpacked
  }
  if (new TextDecoder('latin1').decode(bytes.subarray(0, 5)) === '%PDF-') return 'pdf'
  if (isOle2(bytes)) return 'ole2'
  if (detectFormat(bytes) !== 'unknown') return 'image'
  if (detectMedia(bytes) !== 'unknown') return 'media'
  if (isRtf(new TextDecoder('latin1').decode(bytes.subarray(0, 64)))) return 'rtf'
  return 'unbekannt'
}

const officeFields = (): Field[] =>
  FIELDS.map((field) => ({
    key: field.key,
    label: field.label,
    kind: field.kind,
    hint: field.hint,
    group: field.part === 'core' ? 'Dokumenteigenschaften' : 'Erweiterte Eigenschaften',
  }))

export async function loadFile(name: string, bytes: Uint8Array): Promise<LoadedFile> {
  const base: LoadedFile = {
    name,
    size: bytes.length,
    kind: detectKind(name, bytes),
    fields: [],
    values: {},
    customProps: [],
    findings: [],
    sha256: await sha256(bytes),
    bytes,
  }

  try {
    switch (base.kind) {
      case 'ooxml':
      case 'odf': {
        const entries = await readZip(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer)
        base.entries = entries
        if (isOdfPackage(entries)) {
          base.kind = 'odf'
          base.fields = ODF_FIELDS.map((f) => ({
            key: f.key,
            label: f.label,
            kind: f.kind === 'datetime' ? 'datetime' : f.kind === 'number' ? 'number' : 'text',
            group: 'Dokumenteigenschaften' as const,
          }))
          base.values = readOdfFields(entries)
          base.findings = scanOdf(entries).map((f) => ({ ...f, option: f.id }))
        } else {
          base.kind = 'ooxml'
          base.fields = officeFields()
          base.values = readOfficeFields(entries)
          base.customProps = readCustomProps(entries)
          base.findings = [
            ...scanTraces(entries).map((trace) => ({
              id: trace.id,
              label: trace.label,
              detail: trace.detail,
              severity: (trace.removable ? 'mittel' : 'hoch') as Finding['severity'],
              option: trace.removable ? trace.id : undefined,
            })),
            ...scanDeep(entries).map((finding) => ({
              id: finding.id,
              label: finding.label,
              detail: finding.detail,
              severity: finding.severity,
              option: finding.option,
              parts: finding.parts,
            })),
          ]
        }
        break
      }

      case 'pdf': {
        const info = await readPdf(bytes)
        base.fields = PDF_FIELDS.map((f) => ({
          key: f.key,
          label: f.label,
          kind: f.key.endsWith('Date') ? ('datetime' as const) : ('text' as const),
          group: 'Dokumenteigenschaften' as const,
        }))
        base.values = info.values
        base.findings = info.findings.map((f) => ({ ...f, option: f.id }))
        base.error = info.error
        break
      }

      case 'ole2': {
        const document = readOle2(bytes)
        if (!document) {
          base.error = 'Die Datei ließ sich nicht als OLE2-Dokument lesen.'
          break
        }
        base.fields = OLE2_FIELDS.map((f) => ({
          key: f.key,
          label: f.label,
          kind: f.kind === 'datetime' ? ('datetime' as const) : f.kind === 'number' ? ('number' as const) : ('text' as const),
          group: f.stream === 'summary' ? ('Dokumenteigenschaften' as const) : ('Erweiterte Eigenschaften' as const),
        }))
        base.values = document.values
        base.findings = document.findings.map((f) => ({ ...f, option: undefined }))
        break
      }

      case 'rtf': {
        const text = new TextDecoder('latin1').decode(bytes)
        base.text = text
        base.fields = RTF_FIELDS.map((f) => ({
          key: f.key,
          label: f.label,
          kind: f.kind === 'number' ? ('number' as const) : ('text' as const),
          group: 'Dokumenteigenschaften' as const,
        }))
        base.values = readRtfFields(text)
        base.findings = scanRtf(text).map((f) => ({ ...f, option: f.id }))
        break
      }

      case 'image': {
        const found = inspectImage(bytes)
        base.findings = found.map((item) => ({
          id: 'imageMetadata',
          label: item.value ? `${item.label}: ${item.value}` : item.label,
          detail: 'Steht im Metadatenblock des Bildes und wird beim Versenden mitgeschickt.',
          severity: item.label.startsWith('GPS') ? ('hoch' as const) : ('mittel' as const),
          option: 'stripImageMetadata',
        }))
        break
      }

      case 'media': {
        base.findings = inspectMedia(bytes).map((item) => ({
          id: 'mediaMetadata',
          label: item.value ? `${item.label}: ${item.value}` : item.label,
          detail: 'Steht im Tag-Bereich der Mediendatei.',
          severity: item.label.startsWith('GPS') ? ('hoch' as const) : ('mittel' as const),
          option: 'stripMediaMetadata',
        }))
        break
      }

      default:
        base.error = 'Dieses Format wird nicht unterstützt.'
    }
  } catch (err) {
    base.error = err instanceof Error ? err.message : 'Die Datei konnte nicht gelesen werden.'
  }

  return base
}

export interface CleanResult {
  bytes: Uint8Array
  fileName: string
  steps: string[]
  sha256Before: string
  sha256After: string
  /** Findings that are still there afterwards — the verification pass. */
  remaining: Finding[]
  error?: string
}

export async function cleanFile(
  file: LoadedFile,
  values: Record<string, string>,
  customProps: CustomProp[],
  options: Options
): Promise<CleanResult> {
  const steps: string[] = []
  let fileName = file.name
  let bytes = file.bytes

  try {
    if (file.kind === 'ooxml' && file.entries) {
      const entries = file.entries.map((e) => ({ ...e, data: new Uint8Array(e.data) }))
      applyFields(entries, values, 'core')
      applyFields(entries, values, 'app')
      steps.push('Dokumenteigenschaften geschrieben')

      if (options.base.stripCustomProps) {
        if (removeParts(entries, (name) => name === 'docProps/custom.xml').length > 0) {
          steps.push('Benutzerdefinierte Eigenschaften gelöscht')
        }
      } else {
        applyCustomProps(entries, customProps)
      }
      if (options.base.stripThumbnail) {
        if (removeParts(entries, (name) => name.startsWith('docProps/thumbnail')).length > 0) {
          steps.push('Vorschaubild entfernt')
        }
      }
      if (options.base.stripComments) {
        stripCommentsFromPackage(entries)
        steps.push('Kommentare und Personenliste entfernt')
      }
      if (options.base.stripRsids) {
        stripRsidsFromPackage(entries)
        steps.push('Word-RSIDs entfernt')
      }

      const deep = await applyDeepClean(entries, options.deep)
      steps.push(...deep.steps.map((step) => step.summary))
      if (deep.newExtension) {
        const extension = macroFreeExtension(file.name)
        if (extension) fileName = file.name.replace(/\.[^.]+$/, `.${extension}`)
      }

      const timestamp = options.base.normalizeZipTimestamps ? parseDate(values.modified ?? values.created) : undefined
      if (timestamp) steps.push('ZIP-Zeitstempel angeglichen')
      bytes = new Uint8Array(await (await writeZip(entries, timestamp)).arrayBuffer())
    } else if (file.kind === 'odf' && file.entries) {
      const entries = file.entries.map((e) => ({ ...e, data: new Uint8Array(e.data) }))
      writeOdfFields(entries, values)
      steps.push('Dokumenteigenschaften geschrieben')
      steps.push(...cleanOdf(entries, options.odf))
      const timestamp = options.base.normalizeZipTimestamps ? parseDate(values.date ?? values['creation-date']) : undefined
      if (timestamp) steps.push('ZIP-Zeitstempel angeglichen')
      bytes = new Uint8Array(await (await writeZip(sortOdfEntries(entries), timestamp)).arrayBuffer())
    } else if (file.kind === 'pdf') {
      const result = await cleanPdf(file.bytes, values, options.pdf)
      if (result.error) return failure(file, result.error)
      bytes = result.bytes
      steps.push(...result.steps)
    } else if (file.kind === 'ole2') {
      const result = writeOle2(file.bytes, values)
      if (result.error) return failure(file, result.error)
      bytes = result.bytes
      steps.push(...result.steps)
    } else if (file.kind === 'rtf' && file.text !== undefined) {
      let text = writeRtfFields(file.text, values)
      const result = cleanRtf(text, options.rtf)
      text = result.text
      steps.push('Dokumenteigenschaften geschrieben', ...result.steps)
      bytes = new Uint8Array(text.length)
      for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i) & 0xff
    } else if (file.kind === 'image') {
      bytes = stripImageMetadata(file.bytes)
      steps.push(bytes.length === file.bytes.length ? 'Keine Bildmetadaten gefunden' : 'Bildmetadaten entfernt')
    } else if (file.kind === 'media') {
      bytes = stripMediaMetadata(file.bytes)
      steps.push(bytes.length === file.bytes.length ? 'Keine Medien-Tags gefunden' : 'Medien-Tags entfernt')
    } else {
      return failure(file, file.error ?? 'Dieses Format wird nicht unterstützt.')
    }
  } catch (err) {
    return failure(file, err instanceof Error ? err.message : 'Die Datei konnte nicht geschrieben werden.')
  }

  // Verification pass: read the result back and see what a scan still finds.
  const verified = await loadFile(fileName, bytes)

  return {
    bytes,
    fileName,
    steps,
    sha256Before: file.sha256,
    sha256After: await sha256(bytes),
    remaining: verified.findings,
  }
}

function failure(file: LoadedFile, error: string): CleanResult {
  return {
    bytes: file.bytes,
    fileName: file.name,
    steps: [],
    sha256Before: file.sha256,
    sha256After: file.sha256,
    remaining: file.findings,
    error,
  }
}

function parseDate(value: string | undefined): Date | undefined {
  if (!value) return new Date()
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? new Date() : date
}

export { toW3CDTF }

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

export interface ReportEntry {
  file: string
  kind: FileKind
  sizeBefore: number
  sizeAfter: number
  sha256Before: string
  sha256After: string
  findingsBefore: Finding[]
  steps: string[]
  remaining: Finding[]
  error?: string
}

export function buildReportText(entries: ReportEntry[], generatedAt: string): string {
  const lines: string[] = []
  lines.push('Metadaten-Bereinigung — Protokoll')
  lines.push(`Erstellt: ${generatedAt}`)
  lines.push(`Dateien: ${entries.length}`)
  lines.push('')

  for (const entry of entries) {
    lines.push('='.repeat(72))
    lines.push(`Datei:    ${entry.file}`)
    lines.push(`Format:   ${entry.kind}`)
    lines.push(`Größe:    ${entry.sizeBefore} → ${entry.sizeAfter} Bytes`)
    lines.push(`SHA-256:  ${entry.sha256Before}`)
    lines.push(`          ${entry.sha256After}`)
    if (entry.error) {
      lines.push(`FEHLER:   ${entry.error}`)
      lines.push('')
      continue
    }

    lines.push('')
    lines.push(`Gefunden (${entry.findingsBefore.length}):`)
    for (const finding of entry.findingsBefore) lines.push(`  [${finding.severity}] ${finding.label}`)
    lines.push('')
    lines.push(`Durchgeführt (${entry.steps.length}):`)
    for (const step of entry.steps) lines.push(`  - ${step}`)
    lines.push('')
    if (entry.remaining.length === 0) {
      lines.push('Nachkontrolle: keine Funde mehr.')
    } else {
      lines.push(`Nachkontrolle — weiterhin vorhanden (${entry.remaining.length}):`)
      for (const finding of entry.remaining) lines.push(`  [${finding.severity}] ${finding.label}`)
    }
    lines.push('')
  }

  return lines.join('\n')
}
