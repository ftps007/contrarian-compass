/**
 * Deep cleaning of an OOXML package: everything that hides *inside* the
 * document rather than in its property panel.
 *
 * Each item exists twice — as a finding for the risk report (what is in there)
 * and as a cleaning step behind its own switch (what may be removed). The two
 * are linked by the option name, so the report can say which switch handles a
 * given finding.
 */

import type { ZipEntry } from './zip'
import { inspectImage, stripImageMetadata } from './imageMeta'
import { flattenCrop, type CropRect } from './imageCrop'
import {
  NS,
  decodeText,
  editParts,
  encodeText,
  findEntry,
  parseXml,
  readRelationships,
  relsPathFor,
  removeParts,
  removePartsAndReferences,
  resolveTarget,
  serializeXml,
  setText,
  textOf,
} from './ooxmlPackage'

export interface DeepOptions {
  stripImageMetadata: boolean
  flattenCroppedImages: boolean
  clearPivotCaches: boolean
  removeHiddenSheets: boolean
  clearHiddenRowsCols: boolean
  removeHiddenSlides: boolean
  removeSpeakerNotes: boolean
  removePrinterSettings: boolean
  removeExternalLinks: boolean
  removeDocumentIds: boolean
  removeChartWorkbooks: boolean
  removeMacros: boolean
  anonymizeAuthors: boolean
}

export const DEFAULT_DEEP_OPTIONS: DeepOptions = {
  stripImageMetadata: true,
  flattenCroppedImages: false,
  clearPivotCaches: true,
  removeHiddenSheets: false,
  clearHiddenRowsCols: false,
  removeHiddenSlides: false,
  removeSpeakerNotes: false,
  removePrinterSettings: true,
  removeExternalLinks: true,
  removeDocumentIds: true,
  removeChartWorkbooks: false,
  removeMacros: false,
  anonymizeAuthors: false,
}

export type Severity = 'hoch' | 'mittel' | 'niedrig'

export interface DeepFinding {
  id: string
  label: string
  detail: string
  severity: Severity
  /** Which switch removes it; absent means it cannot be removed automatically. */
  option?: keyof DeepOptions
  /** Where it sits, for the report. */
  parts?: string[]
}

export interface CleanStep {
  option: keyof DeepOptions | 'sonstiges'
  summary: string
  parts?: string[]
}

const MEDIA = /^(word|xl|ppt)\/media\//
const isXml = (name: string) => name.endsWith('.xml')

// ---------------------------------------------------------------------------
// Scanning
// ---------------------------------------------------------------------------

export function scanDeep(entries: ZipEntry[]): DeepFinding[] {
  const findings: DeepFinding[] = []
  const names = entries.map((e) => e.name)
  const add = (f: DeepFinding) => findings.push(f)

  // --- images ---------------------------------------------------------------
  const imageFindings: string[] = []
  const imageParts: string[] = []
  for (const entry of entries) {
    if (!MEDIA.test(entry.name)) continue
    const found = inspectImage(entry.data)
    if (found.length === 0) continue
    imageParts.push(entry.name)
    for (const item of found) {
      const text = item.value ? `${item.label}: ${item.value}` : item.label
      if (!imageFindings.includes(text)) imageFindings.push(text)
    }
  }
  if (imageParts.length > 0) {
    const hasGps = imageFindings.some((f) => f.startsWith('GPS'))
    add({
      id: 'imageMetadata',
      label: `Metadaten in ${imageParts.length} eingebetteten Bild${imageParts.length === 1 ? '' : 'ern'}`,
      detail: `Gefunden: ${imageFindings.join(', ')}.${hasGps ? ' Die GPS-Position verrät den Aufnahmeort.' : ''}`,
      severity: hasGps ? 'hoch' : 'mittel',
      option: 'stripImageMetadata',
      parts: imageParts,
    })
  }

  // --- cropped images -------------------------------------------------------
  const crops = findCrops(entries)
  if (crops.length > 0) {
    add({
      id: 'croppedImages',
      label: `${crops.length} zugeschnittene${crops.length === 1 ? 's' : ''} Bild${crops.length === 1 ? '' : 'er'}`,
      detail:
        'Der weggeschnittene Teil ist weiterhin vollständig in der Datei enthalten und lässt sich durch Aufheben des Zuschnitts sichtbar machen.',
      severity: 'hoch',
      option: 'flattenCroppedImages',
      parts: crops.map((c) => c.mediaPart),
    })
  }

  // --- pivot caches ---------------------------------------------------------
  const pivotRecords = names.filter((n) => /^xl\/pivotCache\/pivotCacheRecords/.test(n))
  if (pivotRecords.length > 0) {
    const rows = pivotRecords.reduce((sum, name) => {
      const xml = textOf(entries, name) ?? ''
      return sum + (xml.match(/<r>/g) ?? []).length
    }, 0)
    add({
      id: 'pivotCache',
      label: `Pivot-Cache mit ${rows} zwischengespeicherten Datensätzen`,
      detail:
        'Der Cache enthält die vollständigen Quelldaten der Pivot-Tabelle — auch dann, wenn das Quellblatt gelöscht wurde.',
      severity: 'hoch',
      option: 'clearPivotCaches',
      parts: pivotRecords,
    })
  }

  // --- hidden sheets --------------------------------------------------------
  const hiddenSheets = listHiddenSheets(entries)
  if (hiddenSheets.length > 0) {
    add({
      id: 'hiddenSheets',
      label: `${hiddenSheets.length} ausgeblendete${hiddenSheets.length === 1 ? 's' : ''} Tabellenblatt${hiddenSheets.length === 1 ? '' : 'blätter'}`,
      detail: `Betroffen: ${hiddenSheets.map((s) => `„${s.name}"${s.state === 'veryHidden' ? ' (nur per VBA sichtbar)' : ''}`).join(', ')}.`,
      severity: 'hoch',
      option: 'removeHiddenSheets',
    })
  }

  // --- hidden rows and columns ---------------------------------------------
  const hiddenCells = countHiddenRowsCols(entries)
  if (hiddenCells.rows > 0 || hiddenCells.cols > 0) {
    add({
      id: 'hiddenRowsCols',
      label: `${hiddenCells.rows} ausgeblendete Zeilen, ${hiddenCells.cols} ausgeblendete Spalten`,
      detail:
        'Ausgeblendete Zellen enthalten weiterhin ihre Werte. Ein Empfänger blendet sie mit zwei Klicks wieder ein.',
      severity: 'hoch',
      option: 'clearHiddenRowsCols',
    })
  }

  // --- hidden slides and notes ---------------------------------------------
  const hiddenSlides = listHiddenSlides(entries)
  if (hiddenSlides.length > 0) {
    add({
      id: 'hiddenSlides',
      label: `${hiddenSlides.length} ausgeblendete Folie${hiddenSlides.length === 1 ? '' : 'n'}`,
      detail: 'Ausgeblendete Folien werden nicht vorgeführt, sind in der Datei aber vollständig vorhanden.',
      severity: 'mittel',
      option: 'removeHiddenSlides',
      parts: hiddenSlides,
    })
  }
  const notes = names.filter((n) => /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(n))
  if (notes.length > 0) {
    add({
      id: 'speakerNotes',
      label: `${notes.length} Notizenseite${notes.length === 1 ? '' : 'n'}`,
      detail: 'Sprechernotizen sind für das Publikum unsichtbar, in der Datei aber im Klartext lesbar.',
      severity: 'mittel',
      option: 'removeSpeakerNotes',
      parts: notes,
    })
  }

  // --- printer settings -----------------------------------------------------
  const printers = names.filter((n) => /printerSettings\/printerSettings\d*\.bin$/.test(n))
  if (printers.length > 0) {
    add({
      id: 'printerSettings',
      label: `Druckereinstellungen (${printers.length} Teil${printers.length === 1 ? '' : 'e'})`,
      detail: 'Enthalten den Namen des zuletzt benutzten Druckers und dessen Treiberkonfiguration.',
      severity: 'mittel',
      option: 'removePrinterSettings',
      parts: printers,
    })
  }

  // --- external references --------------------------------------------------
  const external = findExternalPaths(entries)
  if (external.length > 0) {
    add({
      id: 'externalLinks',
      label: `${external.length} Verweis${external.length === 1 ? '' : 'e'} auf lokale oder Netzwerkpfade`,
      detail: `Gefunden: ${external.slice(0, 6).map((e) => e.target).join(', ')}${external.length > 6 ? ' …' : ''}. Solche Pfade verraten Benutzernamen, Serverfreigaben und Ordnerstrukturen.`,
      severity: 'hoch',
      option: 'removeExternalLinks',
    })
  }
  if ((textOf(entries, 'word/settings.xml') ?? '').includes('<w:mailMerge>')) {
    add({
      id: 'mailMerge',
      label: 'Seriendruck-Datenquelle',
      detail: 'Die Verknüpfung zur Adressliste steht mit vollständigem Pfad in den Dokumenteinstellungen.',
      severity: 'hoch',
      option: 'removeExternalLinks',
      parts: ['word/settings.xml'],
    })
  }

  // --- identifiers ----------------------------------------------------------
  const idParts = entries
    .filter((e) => isXml(e.name))
    .filter((e) => /<w15:docId|w14:paraId=|p14:creationId|p14:modId/.test(decodeText(e.data)))
    .map((e) => e.name)
  if (idParts.length > 0) {
    add({
      id: 'documentIds',
      label: 'Dauerhafte Dokument-Kennungen (GUIDs)',
      detail:
        'Word und PowerPoint vergeben eine Dokument-GUID und Absatz-IDs. Über sie lassen sich Kopien und Ableitungen desselben Ausgangsdokuments einander zuordnen.',
      severity: 'mittel',
      option: 'removeDocumentIds',
      parts: idParts,
    })
  }

  // --- embedded objects -----------------------------------------------------
  const chartWorkbooks = findChartWorkbooks(entries).map((c) => c.target)
  if (chartWorkbooks.length > 0) {
    add({
      id: 'chartWorkbooks',
      label: `${chartWorkbooks.length} eingebettete Diagramm-Arbeitsmappe${chartWorkbooks.length === 1 ? '' : 'n'}`,
      detail:
        'Hinter jedem Diagramm steckt eine vollständige Excel-Mappe. Sie enthält oft mehr Spalten und Zeilen als das Diagramm zeigt.',
      severity: 'hoch',
      option: 'removeChartWorkbooks',
      parts: chartWorkbooks,
    })
  }
  const ole = names.filter((n) => /embeddings\/.*\.(bin|doc|xls|ppt)$/i.test(n)).filter((n) => !chartWorkbooks.includes(n))
  if (ole.length > 0) {
    add({
      id: 'oleObjects',
      label: `${ole.length} eingebettete${ole.length === 1 ? 's' : ''} OLE-Objekt${ole.length === 1 ? '' : 'e'}`,
      detail:
        'Eingebettete Fremddokumente bringen ihre eigenen Metadaten mit. Sie lassen sich nicht entfernen, ohne die Einbettung im Text zu zerstören — in Office öffnen, dort bereinigen und neu einfügen.',
      severity: 'mittel',
      parts: ole,
    })
  }
  const smartArt = names.filter((n) => /diagrams\/data\d*\.xml$/.test(n))
  if (smartArt.length > 0) {
    add({
      id: 'smartArt',
      label: `SmartArt-Datenmodell (${smartArt.length} Teil${smartArt.length === 1 ? '' : 'e'})`,
      detail:
        'Das Modell hinter einer SmartArt-Grafik kann gelöschte Knoten und deren Text weiter enthalten. Automatisches Entfernen würde die Grafik leeren — bitte in Office prüfen.',
      severity: 'niedrig',
      parts: smartArt,
    })
  }

  // --- macros ---------------------------------------------------------------
  const macros = names.filter((n) => /vbaProject\.bin$|vbaData\.xml$/.test(n))
  if (macros.length > 0) {
    add({
      id: 'macros',
      label: 'Makros (VBA-Projekt)',
      detail: 'Ein VBA-Projekt enthält Quellcode samt Autorenspuren und ist zudem ein Sicherheitsrisiko beim Empfänger.',
      severity: 'mittel',
      option: 'removeMacros',
      parts: macros,
    })
  }

  // --- authors --------------------------------------------------------------
  const authors = collectAuthors(entries)
  if (authors.length > 0) {
    add({
      id: 'authors',
      label: `${authors.length} Personenname${authors.length === 1 ? '' : 'n'} im Dokumentinhalt`,
      detail: `Gefunden: ${authors.join(', ')}. Diese Namen stehen in Kommentaren, Änderungsverfolgung oder der Personenliste — nicht in den Dokumenteigenschaften.`,
      severity: 'hoch',
      option: 'anonymizeAuthors',
    })
  }

  // --- white on white -------------------------------------------------------
  const whiteText = entries
    .filter((e) => /^word\/document\.xml$|^ppt\/slides\/|^xl\/worksheets\//.test(e.name))
    .filter((e) => /w:color w:val="(FFFFFF|ffffff)"|srgbClr val="FFFFFF"/.test(decodeText(e.data)))
    .map((e) => e.name)
  if (whiteText.length > 0) {
    add({
      id: 'whiteText',
      label: 'Weiß formatierter Text',
      detail:
        'Text in Weiß auf weißem Grund ist beim Lesen unsichtbar, beim Markieren und Kopieren aber sofort da. Automatisches Entfernen wäre ein Eingriff in den Inhalt — bitte selbst prüfen (Strg+A und Textfarbe ändern).',
      severity: 'mittel',
      parts: whiteText,
    })
  }

  return findings
}

// ---------------------------------------------------------------------------
// Helpers shared by scan and clean
// ---------------------------------------------------------------------------

interface CropUse {
  /** Part containing the drawing, e.g. word/document.xml */
  ownerPart: string
  mediaPart: string
  rect: CropRect
}

function findCrops(entries: ZipEntry[]): CropUse[] {
  const uses: CropUse[] = []

  for (const entry of entries) {
    if (!isXml(entry.name) || entry.name.endsWith('.rels')) continue
    const xml = decodeText(entry.data)
    if (!xml.includes('srcRect')) continue

    const rels = readRelationships(entries, relsPathFor(entry.name))
    const blipFills = xml.match(/<[a-z0-9]+:blipFill[\s\S]*?<\/[a-z0-9]+:blipFill>/g) ?? []
    for (const fill of blipFills) {
      const srcRect = /<a:srcRect([^/>]*)\/>/.exec(fill)
      if (!srcRect) continue
      const rect = parseCropRect(srcRect[1])
      if (!rect) continue
      const embed = /r:embed="([^"]+)"/.exec(fill)
      if (!embed) continue
      const rel = rels.find((r) => r.id === embed[1])
      if (!rel || rel.external) continue
      uses.push({ ownerPart: entry.name, mediaPart: resolveTarget(relsPathFor(entry.name), rel.target), rect })
    }
  }

  return uses
}

function parseCropRect(attributes: string): CropRect | null {
  const value = (name: string) => {
    const match = new RegExp(`${name}="(-?\\d+)"`).exec(attributes)
    return match ? Number(match[1]) / 100000 : 0
  }
  const rect = { left: value('l'), top: value('t'), right: value('r'), bottom: value('b') }
  const cropped = rect.left > 0 || rect.top > 0 || rect.right > 0 || rect.bottom > 0
  return cropped ? rect : null
}

function listHiddenSheets(entries: ZipEntry[]): { name: string; state: string; relId: string }[] {
  const xml = textOf(entries, 'xl/workbook.xml')
  if (!xml) return []
  const doc = parseXml(xml, 'xl/workbook.xml')
  return Array.from(doc.getElementsByTagNameNS(NS.sheet, 'sheet'))
    .filter((sheet) => {
      const state = sheet.getAttribute('state')
      return state === 'hidden' || state === 'veryHidden'
    })
    .map((sheet) => ({
      name: sheet.getAttribute('name') ?? '',
      state: sheet.getAttribute('state') ?? '',
      relId: sheet.getAttributeNS(NS.r, 'id') ?? sheet.getAttribute('r:id') ?? '',
    }))
}

function countHiddenRowsCols(entries: ZipEntry[]): { rows: number; cols: number } {
  let rows = 0
  let cols = 0
  for (const entry of entries) {
    if (!/^xl\/worksheets\/sheet\d+\.xml$/.test(entry.name)) continue
    const xml = decodeText(entry.data)
    rows += (xml.match(/<row[^>]*\shidden="(1|true)"/g) ?? []).length
    for (const col of xml.match(/<col[^>]*\shidden="(1|true)"[^>]*\/>/g) ?? []) {
      const min = Number(/min="(\d+)"/.exec(col)?.[1] ?? 0)
      const max = Number(/max="(\d+)"/.exec(col)?.[1] ?? 0)
      cols += Math.max(0, max - min + 1)
    }
  }
  return { rows, cols }
}

function listHiddenSlides(entries: ZipEntry[]): string[] {
  return entries
    .filter((e) => /^ppt\/slides\/slide\d+\.xml$/.test(e.name))
    .filter((e) => /<p:sld[^>]*\sshow="(0|false)"/.test(decodeText(e.data)))
    .map((e) => e.name)
}

const LOCAL_PATH = /^(file:|\\\\|[A-Za-z]:[\\/])/

function findExternalPaths(entries: ZipEntry[]): { part: string; id: string; target: string }[] {
  const found: { part: string; id: string; target: string }[] = []
  for (const entry of entries) {
    if (!entry.name.endsWith('.rels')) continue
    for (const rel of readRelationships(entries, entry.name)) {
      if (rel.external && LOCAL_PATH.test(rel.target)) found.push({ part: entry.name, id: rel.id, target: rel.target })
    }
  }
  for (const entry of entries) {
    if (!/^xl\/externalLinks\/externalLink\d+\.xml$/.test(entry.name)) continue
    found.push({ part: entry.name, id: '', target: entry.name })
  }
  return found
}

function findChartWorkbooks(entries: ZipEntry[]): { chartPart: string; relId: string; target: string }[] {
  const found: { chartPart: string; relId: string; target: string }[] = []
  for (const entry of entries) {
    if (!/charts\/chart\d*\.xml$/.test(entry.name)) continue
    const xml = decodeText(entry.data)
    const external = /<c:externalData[^>]*r:id="([^"]+)"/.exec(xml)
    if (!external) continue
    const rel = readRelationships(entries, relsPathFor(entry.name)).find((r) => r.id === external[1])
    if (!rel || rel.external) continue
    found.push({ chartPart: entry.name, relId: rel.id, target: resolveTarget(relsPathFor(entry.name), rel.target) })
  }
  return found
}

const AUTHOR_PATTERNS = [
  /\sw:author="([^"]+)"/g,
  /\sw15:author="([^"]+)"/g,
  /<p:cmAuthor[^>]*\sname="([^"]+)"/g,
  /<author>([^<]+)<\/author>/g,
]

function collectAuthors(entries: ZipEntry[]): string[] {
  const authors = new Set<string>()
  for (const entry of entries) {
    if (!isXml(entry.name)) continue
    const xml = decodeText(entry.data)
    for (const pattern of AUTHOR_PATTERNS) {
      pattern.lastIndex = 0
      let match: RegExpExecArray | null
      while ((match = pattern.exec(xml))) {
        const name = match[1].trim()
        if (name && name.toLowerCase() !== 'author' && !/^Autor \d+$/.test(name)) authors.add(name)
      }
    }
  }
  return Array.from(authors)
}

// ---------------------------------------------------------------------------
// Cleaning
// ---------------------------------------------------------------------------

export interface DeepCleanResult {
  steps: CleanStep[]
  /** Set when the file extension has to change, e.g. docm -> docx. */
  newExtension?: string
}

export async function applyDeepClean(entries: ZipEntry[], options: DeepOptions): Promise<DeepCleanResult> {
  const steps: CleanStep[] = []
  const result: DeepCleanResult = { steps }
  const log = (option: CleanStep['option'], summary: string, parts?: string[]) => steps.push({ option, summary, parts })

  if (options.flattenCroppedImages) await flattenCrops(entries, log)
  if (options.stripImageMetadata) cleanImages(entries, log)
  if (options.clearPivotCaches) clearPivotCaches(entries, log)
  if (options.removeHiddenSheets) removeHiddenSheets(entries, log)
  if (options.clearHiddenRowsCols) clearHiddenRowsCols(entries, log)
  if (options.removeHiddenSlides) removeHiddenSlides(entries, log)
  if (options.removeSpeakerNotes) removeSpeakerNotes(entries, log)
  if (options.removePrinterSettings) removePrinterSettings(entries, log)
  if (options.removeExternalLinks) removeExternalLinks(entries, log)
  if (options.removeDocumentIds) removeDocumentIds(entries, log)
  if (options.removeChartWorkbooks) removeChartWorkbooks(entries, log)
  if (options.removeMacros) result.newExtension = removeMacros(entries, log)
  if (options.anonymizeAuthors) anonymizeAuthors(entries, log)

  return result
}

type Log = (option: CleanStep['option'], summary: string, parts?: string[]) => void

function cleanImages(entries: ZipEntry[], log: Log): void {
  const cleaned: string[] = []
  let saved = 0
  for (const entry of entries) {
    if (!MEDIA.test(entry.name)) continue
    const stripped = stripImageMetadata(entry.data)
    if (stripped.length !== entry.data.length) {
      saved += entry.data.length - stripped.length
      entry.data = stripped
      cleaned.push(entry.name)
    }
  }
  if (cleaned.length > 0) {
    log('stripImageMetadata', `EXIF/XMP/IPTC aus ${cleaned.length} Bild(ern) entfernt (${Math.round(saved / 102.4) / 10} KB)`, cleaned)
  }
}

async function flattenCrops(entries: ZipEntry[], log: Log): Promise<void> {
  const crops = findCrops(entries)
  if (crops.length === 0) return

  // Only images used by exactly one cropped picture can be cut destructively.
  const usage = new Map<string, number>()
  for (const entry of entries) {
    if (!isXml(entry.name) || entry.name.endsWith('.rels')) continue
    const xml = decodeText(entry.data)
    const rels = readRelationships(entries, relsPathFor(entry.name))
    for (const match of xml.match(/r:embed="([^"]+)"/g) ?? []) {
      const id = /r:embed="([^"]+)"/.exec(match)?.[1]
      const rel = rels.find((r) => r.id === id)
      if (!rel || rel.external) continue
      const part = resolveTarget(relsPathFor(entry.name), rel.target)
      usage.set(part, (usage.get(part) ?? 0) + 1)
    }
  }

  const done: string[] = []
  const skipped: string[] = []
  for (const crop of crops) {
    if ((usage.get(crop.mediaPart) ?? 0) > 1) {
      skipped.push(crop.mediaPart)
      continue
    }
    const entry = findEntry(entries, crop.mediaPart)
    if (!entry) continue
    const cut = await flattenCrop(entry.data, crop.rect)
    if (!cut) {
      skipped.push(crop.mediaPart)
      continue
    }
    entry.data = cut
    done.push(crop.mediaPart)

    // The picture must no longer crop what is already cut away.
    const owner = findEntry(entries, crop.ownerPart)
    if (owner) {
      const xml = decodeText(owner.data).replace(/<a:srcRect[^/>]*\/>/g, '')
      owner.data = encodeText(xml)
    }
  }

  if (done.length > 0) log('flattenCroppedImages', `${done.length} Bild(er) auf den sichtbaren Ausschnitt reduziert`, done)
  if (skipped.length > 0) {
    log(
      'flattenCroppedImages',
      `${skipped.length} Zuschnitt(e) übersprungen — Bild mehrfach verwendet oder Format nicht dekodierbar`,
      skipped
    )
  }
}

function clearPivotCaches(entries: ZipEntry[], log: Log): void {
  const touched: string[] = []

  for (const entry of entries) {
    if (/^xl\/pivotCache\/pivotCacheRecords\d*\.xml$/.test(entry.name)) {
      entry.data = encodeText(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n<pivotCacheRecords xmlns="${NS.sheet}" xmlns:r="${NS.r}" count="0"/>`
      )
      touched.push(entry.name)
    }
  }

  const definitions = editParts(
    entries,
    (name) => /^xl\/pivotCache\/pivotCacheDefinition\d*\.xml$/.test(name),
    (xml) =>
      xml
        // Excel rebuilds the cache from the source when the file is opened.
        .replace(/(<pivotCacheDefinition\b[^>]*?)\srefreshOnLoad="[^"]*"/g, '$1')
        .replace(/(<pivotCacheDefinition\b)/, '$1 refreshOnLoad="1"')
        .replace(/(<pivotCacheDefinition\b[^>]*?)\srecordCount="\d+"/g, '$1 recordCount="0"')
        // sharedItems list every distinct value of a source column.
        .replace(/<sharedItems[^>]*>[\s\S]*?<\/sharedItems>/g, '<sharedItems/>')
        .replace(/<sharedItems[^/>]*\/>/g, '<sharedItems/>')
  )

  if (touched.length + definitions.length > 0) {
    log('clearPivotCaches', `Pivot-Cache geleert, Aktualisierung beim Öffnen erzwungen`, [...touched, ...definitions])
  }
}

function removeHiddenSheets(entries: ZipEntry[], log: Log): void {
  const hidden = listHiddenSheets(entries)
  if (hidden.length === 0) return

  const workbookXml = textOf(entries, 'xl/workbook.xml')
  if (!workbookXml) return
  const doc = parseXml(workbookXml, 'xl/workbook.xml')
  const rels = readRelationships(entries, 'xl/_rels/workbook.xml.rels')
  const targets: string[] = []

  for (const sheet of Array.from(doc.getElementsByTagNameNS(NS.sheet, 'sheet'))) {
    const state = sheet.getAttribute('state')
    if (state !== 'hidden' && state !== 'veryHidden') continue
    const relId = sheet.getAttributeNS(NS.r, 'id') ?? sheet.getAttribute('r:id') ?? ''
    const rel = rels.find((r) => r.id === relId)
    if (rel) targets.push(resolveTarget('xl/_rels/workbook.xml.rels', rel.target))
    sheet.parentNode?.removeChild(sheet)
  }

  // Defined names pointing at a removed sheet would trigger a repair prompt.
  const names = hidden.map((s) => s.name)
  for (const defined of Array.from(doc.getElementsByTagNameNS(NS.sheet, 'definedName'))) {
    const text = defined.textContent ?? ''
    if (names.some((name) => text.includes(name))) defined.parentNode?.removeChild(defined)
  }

  setText(entries, 'xl/workbook.xml', serializeXml(doc))
  const removed = removeParts(entries, (name) => targets.includes(name))
  log('removeHiddenSheets', `${hidden.length} ausgeblendete(s) Tabellenblatt/Blätter gelöscht: ${names.join(', ')}`, removed)
}

function clearHiddenRowsCols(entries: ZipEntry[], log: Log): void {
  let clearedRows = 0
  let clearedCells = 0
  const touched: string[] = []

  for (const entry of entries) {
    if (!/^xl\/worksheets\/sheet\d+\.xml$/.test(entry.name)) continue
    const doc = parseXml(decodeText(entry.data), entry.name)

    const hiddenCols = new Set<number>()
    for (const col of Array.from(doc.getElementsByTagNameNS(NS.sheet, 'col'))) {
      const hidden = col.getAttribute('hidden')
      if (hidden !== '1' && hidden !== 'true') continue
      const min = Number(col.getAttribute('min') ?? '0')
      const max = Number(col.getAttribute('max') ?? '0')
      for (let i = min; i <= max && i - min < 16384; i++) hiddenCols.add(i)
    }

    let changed = false
    for (const row of Array.from(doc.getElementsByTagNameNS(NS.sheet, 'row'))) {
      const hidden = row.getAttribute('hidden')
      const rowHidden = hidden === '1' || hidden === 'true'
      for (const cell of Array.from(row.getElementsByTagNameNS(NS.sheet, 'c'))) {
        const column = columnIndex(cell.getAttribute('r') ?? '')
        if (!rowHidden && !hiddenCols.has(column)) continue
        cell.parentNode?.removeChild(cell)
        clearedCells++
        changed = true
      }
      if (rowHidden) clearedRows++
    }

    if (changed) {
      setText(entries, entry.name, serializeXml(doc))
      touched.push(entry.name)
    }
  }

  if (clearedCells === 0) return
  const pruned = pruneSharedStrings(entries)
  log(
    'clearHiddenRowsCols',
    `${clearedCells} Zellen in ausgeblendeten Zeilen/Spalten geleert (${clearedRows} Zeilen)${pruned > 0 ? `, ${pruned} verwaiste Texte aus der Zeichenkettentabelle entfernt` : ''}`,
    touched
  )
}

/** "BC12" -> 55 */
function columnIndex(reference: string): number {
  let index = 0
  for (const char of reference) {
    const code = char.charCodeAt(0)
    if (code < 65 || code > 90) break
    index = index * 26 + (code - 64)
  }
  return index
}

/**
 * Cleared cells leave their text behind in the shared string table, where it
 * stays readable. This rebuilds the table from the strings still in use and
 * rewrites every reference.
 */
function pruneSharedStrings(entries: ZipEntry[]): number {
  const sharedXml = textOf(entries, 'xl/sharedStrings.xml')
  if (!sharedXml) return 0

  const doc = parseXml(sharedXml, 'xl/sharedStrings.xml')
  const items = Array.from(doc.getElementsByTagNameNS(NS.sheet, 'si'))
  if (items.length === 0) return 0

  const used = new Set<number>()
  const sheets = entries.filter((e) => /^xl\/worksheets\/sheet\d+\.xml$/.test(e.name))
  const sheetDocs = sheets.map((entry) => ({ entry, doc: parseXml(decodeText(entry.data), entry.name) }))

  for (const { doc: sheetDoc } of sheetDocs) {
    for (const cell of Array.from(sheetDoc.getElementsByTagNameNS(NS.sheet, 'c'))) {
      if (cell.getAttribute('t') !== 's') continue
      const value = cell.getElementsByTagNameNS(NS.sheet, 'v')[0]
      if (value) used.add(Number(value.textContent))
    }
  }
  if (used.size === items.length) return 0

  const remap = new Map<number, number>()
  let next = 0
  items.forEach((item, index) => {
    if (used.has(index)) remap.set(index, next++)
    else item.parentNode?.removeChild(item)
  })

  const root = doc.documentElement
  root.setAttribute('count', String(next))
  root.setAttribute('uniqueCount', String(next))
  setText(entries, 'xl/sharedStrings.xml', serializeXml(doc))

  for (const { entry, doc: sheetDoc } of sheetDocs) {
    let changed = false
    for (const cell of Array.from(sheetDoc.getElementsByTagNameNS(NS.sheet, 'c'))) {
      if (cell.getAttribute('t') !== 's') continue
      const value = cell.getElementsByTagNameNS(NS.sheet, 'v')[0]
      if (!value) continue
      const mapped = remap.get(Number(value.textContent))
      if (mapped === undefined) continue
      if (String(mapped) !== value.textContent) {
        value.textContent = String(mapped)
        changed = true
      }
    }
    if (changed) setText(entries, entry.name, serializeXml(sheetDoc))
  }

  return items.length - next
}

function removeHiddenSlides(entries: ZipEntry[], log: Log): void {
  const hidden = listHiddenSlides(entries)
  if (hidden.length === 0) return

  const presentationXml = textOf(entries, 'ppt/presentation.xml')
  if (presentationXml) {
    const doc = parseXml(presentationXml, 'ppt/presentation.xml')
    const rels = readRelationships(entries, 'ppt/_rels/presentation.xml.rels')
    for (const slideId of Array.from(doc.getElementsByTagNameNS(NS.p, 'sldId'))) {
      const relId = slideId.getAttributeNS(NS.r, 'id') ?? slideId.getAttribute('r:id') ?? ''
      const rel = rels.find((r) => r.id === relId)
      if (!rel) continue
      if (hidden.includes(resolveTarget('ppt/_rels/presentation.xml.rels', rel.target))) {
        slideId.parentNode?.removeChild(slideId)
      }
    }
    setText(entries, 'ppt/presentation.xml', serializeXml(doc))
  }

  const removed = removeParts(entries, (name) => hidden.includes(name))
  log('removeHiddenSlides', `${hidden.length} ausgeblendete Folie(n) gelöscht`, removed)
}

function removeSpeakerNotes(entries: ZipEntry[], log: Log): void {
  const removed = removeParts(entries, (name) => /^ppt\/notesSlides\//.test(name))
  if (removed.length > 0) log('removeSpeakerNotes', `${removed.length} Notizenseite(n) gelöscht`, removed)
}

function removePrinterSettings(entries: ZipEntry[], log: Log): void {
  const removed = removePartsAndReferences(entries, (name) => /printerSettings\/printerSettings\d*\.bin$/.test(name))
  if (removed.length === 0) return
  log('removePrinterSettings', `Druckereinstellungen entfernt (${removed.length} Teil(e))`, removed)
}

function removeExternalLinks(entries: ZipEntry[], log: Log): void {
  const external = findExternalPaths(entries)
  const removedIds = new Map<string, string[]>()

  for (const entry of entries.filter((e) => e.name.endsWith('.rels'))) {
    const doc = parseXml(decodeText(entry.data), entry.name)
    const ids: string[] = []
    for (const rel of Array.from(doc.getElementsByTagNameNS(NS.rel, 'Relationship'))) {
      if (rel.getAttribute('TargetMode') !== 'External') continue
      if (!LOCAL_PATH.test(rel.getAttribute('Target') ?? '')) continue
      ids.push(rel.getAttribute('Id') ?? '')
      rel.parentNode?.removeChild(rel)
    }
    if (ids.length === 0) continue
    entry.data = encodeText(serializeXml(doc))
    // The part that owns these rels must drop the dangling references.
    const owner = entry.name.replace(/_rels\/([^/]+)\.rels$/, '$1')
    removedIds.set(owner, ids)
  }

  for (const [owner, ids] of Array.from(removedIds.entries())) {
    const entry = findEntry(entries, owner)
    if (!entry) continue
    let xml = decodeText(entry.data)
    for (const id of ids) {
      xml = xml
        .replace(new RegExp(`\\sr:id="${id}"`, 'g'), '')
        .replace(new RegExp(`\\sr:embed="${id}"`, 'g'), '')
    }
    entry.data = encodeText(xml)
  }

  const mailMerge = editParts(
    entries,
    (name) => name === 'word/settings.xml',
    (xml) => xml.replace(/<w:mailMerge>[\s\S]*?<\/w:mailMerge>/g, '')
  )

  const links = removePartsAndReferences(entries, (name) => /^xl\/externalLinks\//.test(name) || name === 'xl/connections.xml')
  if (links.length > 0) {
    editParts(
      entries,
      (name) => name === 'xl/workbook.xml',
      (xml) => xml.replace(/<externalReferences>[\s\S]*?<\/externalReferences>/g, '')
    )
  }

  const total = external.length + mailMerge.length + links.length
  if (total > 0) {
    log(
      'removeExternalLinks',
      `${external.length} Pfadverweis(e), ${links.length} externe Verknüpfung(en)${mailMerge.length > 0 ? ' und die Seriendruckquelle' : ''} entfernt`,
      links
    )
  }
}

function removeDocumentIds(entries: ZipEntry[], log: Log): void {
  const touched = editParts(entries, isXml, (xml) =>
    xml
      .replace(/<w15:docId[^/>]*\/>/g, '')
      .replace(/\sw14:paraId="[^"]*"/g, '')
      .replace(/\sw14:textId="[^"]*"/g, '')
      .replace(/<p14:creationId[^/>]*\/>/g, '')
      .replace(/<p14:modId[^/>]*\/>/g, '')
      .replace(/\sw14:anchorId="[^"]*"/g, '')
  )
  if (touched.length > 0) log('removeDocumentIds', `Dokument-GUIDs und Absatz-IDs aus ${touched.length} Teil(en) entfernt`, touched)
}

function removeChartWorkbooks(entries: ZipEntry[], log: Log): void {
  const charts = findChartWorkbooks(entries)
  if (charts.length === 0) return

  for (const chart of charts) {
    const entry = findEntry(entries, chart.chartPart)
    if (!entry) continue
    entry.data = encodeText(
      decodeText(entry.data)
        .replace(/<c:externalData[\s\S]*?<\/c:externalData>/g, '')
        .replace(/<c:externalData[^/>]*\/>/g, '')
    )
  }

  const removed = removePartsAndReferences(entries, (name) => charts.some((c) => c.target === name))
  log('removeChartWorkbooks', `${removed.length} eingebettete Diagramm-Arbeitsmappe(n) entfernt`, removed)
}

const MACRO_CONTENT_TYPES: Record<string, string> = {
  'application/vnd.ms-word.document.macroEnabled.main+xml':
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml',
  'application/vnd.ms-word.template.macroEnabledTemplate.main+xml':
    'application/vnd.openxmlformats-officedocument.wordprocessingml.template.main+xml',
  'application/vnd.ms-excel.sheet.macroEnabled.main+xml':
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml',
  'application/vnd.ms-excel.template.macroEnabled.main+xml':
    'application/vnd.openxmlformats-officedocument.spreadsheetml.template.main+xml',
  'application/vnd.ms-powerpoint.presentation.macroEnabled.main+xml':
    'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml',
  'application/vnd.ms-powerpoint.slideshow.macroEnabled.main+xml':
    'application/vnd.openxmlformats-officedocument.presentationml.slideshow.main+xml',
  'application/vnd.ms-powerpoint.template.macroEnabled.main+xml':
    'application/vnd.openxmlformats-officedocument.presentationml.template.main+xml',
}

const NEW_EXTENSION: Record<string, string> = { docm: 'docx', dotm: 'dotx', xlsm: 'xlsx', xltm: 'xltx', pptm: 'pptx', potm: 'potx', ppsm: 'ppsx' }

function removeMacros(entries: ZipEntry[], log: Log): string | undefined {
  const removed = removeParts(entries, (name) => /vbaProject\.bin$|vbaData\.xml$/.test(name))
  if (removed.length === 0) return undefined

  let converted = false
  editParts(
    entries,
    (name) => name === '[Content_Types].xml',
    (xml) => {
      let next = xml
      for (const [macro, plain] of Object.entries(MACRO_CONTENT_TYPES)) {
        if (next.includes(macro)) {
          next = next.split(macro).join(plain)
          converted = true
        }
      }
      return next
    }
  )

  log('removeMacros', `VBA-Projekt entfernt${converted ? ', Datei in ein makrofreies Format überführt' : ''}`, removed)
  return converted ? 'auto' : undefined
}

/** Extension a macro-free file should get, given the original name. */
export function macroFreeExtension(fileName: string): string | undefined {
  const extension = fileName.split('.').pop()?.toLowerCase() ?? ''
  return NEW_EXTENSION[extension]
}

function anonymizeAuthors(entries: ZipEntry[], log: Log): void {
  // The same person usually appears both in the properties and in the content;
  // one mapping for both keeps the replacement consistent.
  const authors = collectAuthors(entries)
  const core = textOf(entries, 'docProps/core.xml') ?? ''
  for (const pattern of [/<dc:creator>([^<]+)<\/dc:creator>/, /<cp:lastModifiedBy>([^<]+)<\/cp:lastModifiedBy>/]) {
    const name = pattern.exec(core)?.[1]?.trim()
    if (name && !/^Autor \d+$/.test(name) && !authors.includes(name)) authors.push(name)
  }
  if (authors.length === 0) return

  const mapping = new Map<string, string>()
  authors.forEach((name, index) => mapping.set(name, `Autor ${index + 1}`))

  const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const xmlEscape = (text: string) =>
    text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

  const touched = editParts(entries, isXml, (xml) => {
    let next = xml
    for (const [name, replacement] of Array.from(mapping.entries())) {
      const escaped = escape(xmlEscape(name))
      next = next
        .replace(new RegExp(`(\\sw:author=")${escaped}(")`, 'g'), `$1${replacement}$2`)
        .replace(new RegExp(`(\\sw15:author=")${escaped}(")`, 'g'), `$1${replacement}$2`)
        .replace(new RegExp(`(<p:cmAuthor[^>]*\\sname=")${escaped}(")`, 'g'), `$1${replacement}$2`)
        .replace(new RegExp(`(<author>)${escaped}(</author>)`, 'g'), `$1${replacement}$2`)
        .replace(new RegExp(`(<dc:creator>)${escaped}(</dc:creator>)`, 'g'), `$1${replacement}$2`)
        .replace(new RegExp(`(<cp:lastModifiedBy>)${escaped}(</cp:lastModifiedBy>)`, 'g'), `$1${replacement}$2`)
    }
    // Initials and presence info identify people just as well.
    next = next
      .replace(/(\sw:initials=")[^"]*(")/g, '$1A$2')
      .replace(/(<p:cmAuthor[^>]*\sinitials=")[^"]*(")/g, '$1A$2')
      .replace(/<w15:presenceInfo[^/>]*\/>/g, '')
    return next
  })

  log(
    'anonymizeAuthors',
    `${mapping.size} Name(n) ersetzt: ${Array.from(mapping.entries()).map(([from, to]) => `${from} → ${to}`).join(', ')}`,
    touched
  )
}
