import { DEFAULT_DEEP_OPTIONS, applyDeepClean, macroFreeExtension, scanDeep, type DeepOptions } from '../lib/ooxmlDeepClean'
import { decodeText, findEntry, textOf } from '../lib/ooxmlPackage'
import type { ZipEntry } from '../lib/zip'
import { docxEntries, fromZip, pptxEntries, toZip, xlsxEntries } from './fixtures'
import { assert, equal, excludes, includes, test } from './helpers'

const allOn: DeepOptions = Object.fromEntries(
  Object.keys(DEFAULT_DEEP_OPTIONS).map((key) => [key, true])
) as DeepOptions

const ids = (entries: ZipEntry[]) => scanDeep(entries).map((f) => f.id)
const packageText = (entries: ZipEntry[]) => entries.map((e) => decodeText(e.data)).join('\n')

// ---------------------------------------------------------------------------
// Scanning
// ---------------------------------------------------------------------------

await test('Word: alle Fundstellen werden erkannt', () => {
  const found = ids(docxEntries())
  for (const expected of [
    'imageMetadata',
    'croppedImages',
    'printerSettings',
    'externalLinks',
    'mailMerge',
    'documentIds',
    'chartWorkbooks',
    'macros',
    'authors',
    'whiteText',
  ]) {
    assert(found.includes(expected), `"${expected}" fehlt, gefunden: ${found.join(', ')}`)
  }

  const images = scanDeep(docxEntries()).find((f) => f.id === 'imageMetadata')
  includes(images?.detail ?? '', 'GPS', 'GPS-Fund nicht im Bericht')
  equal(images?.severity, 'hoch', 'GPS muss hohe Einstufung haben')

  const authors = scanDeep(docxEntries()).find((f) => f.id === 'authors')
  includes(authors?.detail ?? '', 'Erika Musterfrau', 'Kommentarautorin nicht gefunden')
  includes(authors?.detail ?? '', 'Dr. Beispiel', 'Autor der Änderungsverfolgung nicht gefunden')
})

await test('Excel: versteckte Blätter, Zeilen und Pivot-Cache werden erkannt', () => {
  const findings = scanDeep(xlsxEntries())
  const found = findings.map((f) => f.id)
  for (const expected of ['hiddenSheets', 'hiddenRowsCols', 'pivotCache', 'externalLinks', 'printerSettings']) {
    assert(found.includes(expected), `"${expected}" fehlt, gefunden: ${found.join(', ')}`)
  }
  includes(findings.find((f) => f.id === 'hiddenSheets')?.detail ?? '', 'Kalkulation intern', 'Blattname fehlt')
  includes(findings.find((f) => f.id === 'pivotCache')?.label ?? '', '3', 'Datensatzzahl fehlt')
  includes(findings.find((f) => f.id === 'hiddenRowsCols')?.label ?? '', '1 ausgeblendete Zeilen', 'Zeilenzahl falsch')
})

await test('PowerPoint: ausgeblendete Folien und Notizen werden erkannt', () => {
  const found = ids(pptxEntries())
  for (const expected of ['hiddenSlides', 'speakerNotes', 'documentIds', 'authors']) {
    assert(found.includes(expected), `"${expected}" fehlt, gefunden: ${found.join(', ')}`)
  }
})

await test('Eine saubere Datei meldet nichts', () => {
  const clean = [
    { name: '[Content_Types].xml', data: new TextEncoder().encode('<Types/>'), method: 8, dosTime: 0, dosDate: 33, externalAttr: 0 },
  ]
  equal(scanDeep(clean).length, 0, 'Falscher Alarm bei sauberer Datei')
})

// ---------------------------------------------------------------------------
// Cleaning — Word
// ---------------------------------------------------------------------------

await test('Word: Bereinigung entfernt jede gefundene Spur', async () => {
  const entries = docxEntries()
  const { steps } = await applyDeepClean(entries, allOn)
  const text = packageText(entries)

  excludes(text, 'ACME Cameras', 'Kamera-Metadaten im Bild geblieben')
  excludes(text, 'SN-12345678', 'Seriennummer im Bild geblieben')
  excludes(text, 'HP LaserJet', 'Druckereinstellungen geblieben')
  excludes(text, 'fileserver', 'Netzwerkpfad geblieben')
  excludes(text, 'Adressen.xlsx', 'Seriendruckquelle geblieben')
  excludes(text, '8A1B2C3D', 'Dokument-GUID geblieben')
  excludes(text, 'w14:paraId', 'Absatz-IDs geblieben')
  excludes(text, 'Umsatzzahlen 2024', 'Diagramm-Arbeitsmappe geblieben')
  excludes(text, 'VBA-Modul', 'Makro geblieben')
  excludes(text, 'Erika Musterfrau', 'Autorenname geblieben')
  excludes(text, 'Dr. Beispiel', 'Autorenname geblieben')
  excludes(text, 'erika.musterfrau@firma.de', 'Präsenzinfo mit E-Mail geblieben')

  includes(text, 'Sichtbarer Text', 'Inhalt wurde zerstört')
  includes(text, 'Autor 1', 'Ersatzname nicht gesetzt')

  assert(steps.length >= 8, `Zu wenige Schritte protokolliert: ${steps.length}`)
  const macroStep = steps.find((s) => s.option === 'removeMacros')
  includes(macroStep?.summary ?? '', 'makrofrei', 'Formatwechsel nicht protokolliert')
})

await test('Word: Makroentfernung korrigiert Inhaltstyp und Dateiendung', async () => {
  const entries = docxEntries()
  await applyDeepClean(entries, { ...DEFAULT_DEEP_OPTIONS, removeMacros: true })
  const types = textOf(entries, '[Content_Types].xml') ?? ''
  excludes(types, 'macroEnabled', 'Makro-Inhaltstyp geblieben')
  includes(types, 'wordprocessingml.document.main+xml', 'Ersatz-Inhaltstyp fehlt')
  equal(findEntry(entries, 'word/vbaProject.bin'), undefined, 'VBA-Teil noch vorhanden')
  equal(macroFreeExtension('Bericht.docm'), 'docx', 'Endung nicht umgesetzt')
  equal(macroFreeExtension('Bericht.docx'), undefined, 'Endung fälschlich geändert')
})

await test('Word: entfernte Verweise hinterlassen keine toten Relationship-IDs', async () => {
  const entries = docxEntries()
  await applyDeepClean(entries, allOn)

  const documentRels = textOf(entries, 'word/_rels/document.xml.rels') ?? ''
  const document = textOf(entries, 'word/document.xml') ?? ''
  const declared = Array.from(documentRels.matchAll(/Id="([^"]+)"/g)).map((m) => m[1])
  const referenced = Array.from(document.matchAll(/r:(?:id|embed)="([^"]+)"/g)).map((m) => m[1])

  for (const id of referenced) {
    assert(declared.includes(id), `Verweis ${id} zeigt ins Leere`)
  }
  excludes(document, 'rId6', 'Hyperlink-Verweis nicht entfernt')
  excludes(document, 'rId7', 'Druckerverweis nicht entfernt')
})

await test('Word: Bildbereinigung lässt das Bild selbst intakt', async () => {
  const entries = docxEntries()
  await applyDeepClean(entries, { ...DEFAULT_DEEP_OPTIONS, stripImageMetadata: true })
  const image = findEntry(entries, 'word/media/image1.jpeg')
  assert(image, 'Bild wurde entfernt')
  equal(image!.data[0], 0xd8 === 0xd8 ? 0xff : 0, 'JPEG-Signatur zerstört')
  equal(image!.data[1], 0xd8, 'JPEG-Signatur zerstört')
})

await test('Zuschnitt kann in Node nicht entfernt werden und wird als übersprungen gemeldet', async () => {
  const entries = docxEntries()
  const { steps } = await applyDeepClean(entries, { ...DEFAULT_DEEP_OPTIONS, flattenCroppedImages: true })
  const step = steps.find((s) => s.option === 'flattenCroppedImages')
  assert(step, 'Kein Protokolleintrag zum Zuschnitt')
  includes(step!.summary, 'übersprungen', 'Übersprungener Zuschnitt nicht als solcher gemeldet')
})

// ---------------------------------------------------------------------------
// Cleaning — Excel
// ---------------------------------------------------------------------------

await test('Excel: Pivot-Cache wird geleert und Aktualisierung erzwungen', async () => {
  const entries = xlsxEntries()
  await applyDeepClean(entries, { ...DEFAULT_DEEP_OPTIONS, clearPivotCaches: true })

  const records = textOf(entries, 'xl/pivotCache/pivotCacheRecords1.xml') ?? ''
  excludes(records, 'Kunde Alpha', 'Cache-Datensätze geblieben')
  includes(records, 'count="0"', 'Datensatzzahl nicht zurückgesetzt')

  const definition = textOf(entries, 'xl/pivotCache/pivotCacheDefinition1.xml') ?? ''
  excludes(definition, 'Kunde Beta', 'sharedItems geblieben')
  includes(definition, 'refreshOnLoad="1"', 'Aktualisierung nicht erzwungen')
  includes(definition, 'recordCount="0"', 'recordCount nicht zurückgesetzt')
})

await test('Excel: ausgeblendetes Blatt wird samt Namensverweis gelöscht', async () => {
  const entries = xlsxEntries()
  await applyDeepClean(entries, { ...DEFAULT_DEEP_OPTIONS, removeHiddenSheets: true })

  equal(findEntry(entries, 'xl/worksheets/sheet2.xml'), undefined, 'Blattdatei noch vorhanden')
  const workbook = textOf(entries, 'xl/workbook.xml') ?? ''
  excludes(workbook, 'Kalkulation intern', 'Blattname noch in der Mappe')
  const workbookRels = textOf(entries, 'xl/_rels/workbook.xml.rels') ?? ''
  excludes(workbookRels, 'worksheets/sheet2.xml', 'Beziehung zum Blatt geblieben')
  includes(workbook, 'Bericht', 'Sichtbares Blatt wurde mitgelöscht')
})

await test('Excel: ausgeblendete Zeilen und Spalten werden geleert, Texttabelle bereinigt', async () => {
  const entries = xlsxEntries()
  const { steps } = await applyDeepClean(entries, { ...DEFAULT_DEEP_OPTIONS, clearHiddenRowsCols: true })

  const sheet = textOf(entries, 'xl/worksheets/sheet1.xml') ?? ''
  excludes(sheet, 'r="A2"', 'Zelle der ausgeblendeten Zeile geblieben')
  excludes(sheet, 'r="B2"', 'Zelle der ausgeblendeten Zeile geblieben')
  excludes(sheet, 'r="C1"', 'Zelle der ausgeblendeten Spalte geblieben')
  includes(sheet, 'r="A1"', 'Sichtbare Zelle wurde gelöscht')
  includes(sheet, 'r="A3"', 'Sichtbare Zelle wurde gelöscht')

  const shared = textOf(entries, 'xl/sharedStrings.xml') ?? ''
  excludes(shared, 'Gehalt 120000', 'Text der ausgeblendeten Zeile noch in der Texttabelle')
  excludes(shared, 'Interne Marge', 'Text der ausgeblendeten Spalte noch in der Texttabelle')
  includes(shared, 'Sichtbar', 'Sichtbarer Text verloren')
  includes(shared, 'Auch sichtbar', 'Sichtbarer Text verloren')

  // Remaining references must point at the right entries after renumbering.
  const remaining = Array.from(shared.matchAll(/<t>([^<]*)<\/t>/g)).map((m) => m[1])
  const a1 = /<c r="A1" t="s"><v>(\d+)<\/v>/.exec(sheet)?.[1]
  const a3 = /<c r="A3" t="s"><v>(\d+)<\/v>/.exec(sheet)?.[1]
  equal(remaining[Number(a1)], 'Sichtbar', 'A1 zeigt auf den falschen Text')
  equal(remaining[Number(a3)], 'Auch sichtbar', 'A3 zeigt auf den falschen Text')

  const step = steps.find((s) => s.option === 'clearHiddenRowsCols')
  includes(step?.summary ?? '', 'Zeichenkettentabelle', 'Bereinigung der Texttabelle nicht protokolliert')
})

await test('Excel: externe Verknüpfungen und Druckereinstellungen verschwinden', async () => {
  const entries = xlsxEntries()
  await applyDeepClean(entries, { ...DEFAULT_DEEP_OPTIONS, removeExternalLinks: true, removePrinterSettings: true })
  const text = packageText(entries)

  excludes(text, 'max.mustermann', 'Benutzerpfad geblieben')
  excludes(text, 'Drucker Buchhaltung', 'Druckereinstellungen geblieben')
  excludes(textOf(entries, 'xl/workbook.xml') ?? '', 'externalReferences', 'Verweisblock geblieben')
  excludes(textOf(entries, 'xl/worksheets/sheet1.xml') ?? '', 'r:id', 'pageSetup-Verweis zeigt ins Leere')
})

// ---------------------------------------------------------------------------
// Cleaning — PowerPoint
// ---------------------------------------------------------------------------

await test('PowerPoint: ausgeblendete Folie und Notizen werden entfernt', async () => {
  const entries = pptxEntries()
  await applyDeepClean(entries, allOn)
  const text = packageText(entries)

  excludes(text, 'Nicht gezeigte Zahlen', 'Ausgeblendete Folie geblieben')
  excludes(text, 'noch nicht unterschrieben', 'Notizen geblieben')
  excludes(text, 'Dr. Beispiel', 'Kommentarautor geblieben')
  excludes(text, 'p14:creationId', 'Folien-GUID geblieben')

  const presentation = textOf(entries, 'ppt/presentation.xml') ?? ''
  excludes(presentation, 'rId2', 'Verweis auf die gelöschte Folie geblieben')
  includes(presentation, 'rId1', 'Verweis auf die sichtbare Folie verloren')
})

// ---------------------------------------------------------------------------
// Round trip
// ---------------------------------------------------------------------------

await test('Bereinigtes Paket überlebt einen ZIP-Umlauf', async () => {
  const entries = docxEntries()
  await applyDeepClean(entries, allOn)
  const roundTripped = await fromZip(await toZip(entries))

  equal(roundTripped.length, entries.length, 'Teilanzahl nach ZIP-Umlauf verschieden')
  const text = packageText(roundTripped)
  excludes(text, 'Erika Musterfrau', 'Name nach ZIP-Umlauf wieder da')
  includes(text, 'Sichtbarer Text', 'Inhalt nach ZIP-Umlauf verloren')
})

await test('Zweiter Durchlauf findet nichts mehr', async () => {
  const entries = docxEntries()
  await applyDeepClean(entries, allOn)
  // Der Zuschnitt bleibt in Node bestehen — dafür fehlt hier die Canvas-API.
  const remaining = scanDeep(entries)
    .filter((f) => f.option)
    .filter((f) => f.id !== 'croppedImages')
  equal(remaining.length, 0, `Nach der Bereinigung bleiben Funde: ${remaining.map((f) => f.id).join(', ')}`)
})
