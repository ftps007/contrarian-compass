import { DEFAULT_PDF_CLEAN, cleanPdf, pdfStructure, readPdf } from '../lib/pdf'
import {
  encryptedPdf,
  incrementalPdf,
  objectStreamPdf,
  pdfWithExtras,
  simplePdf,
  verifyXref,
} from './pdfFixtures'
import { assert, equal, excludes, includes, test } from './helpers'

const asText = (bytes: Uint8Array) => new TextDecoder('latin1').decode(bytes)

await test('PDF: Info-Felder werden gelesen', async () => {
  const info = await readPdf(simplePdf())
  equal(info.error, undefined, 'Fehler beim Lesen')
  equal(info.values.Title, 'Interner Entwurf', 'Titel falsch')
  equal(info.values.Author, 'Max Mustermann', 'Autor falsch')
  equal(info.values.Producer, 'Testprogramm 1.0', 'Erzeuger falsch')
  equal(info.values.CreationDate, '2024-02-01T10:00:00Z', 'Datum nicht umgewandelt')
})

await test('PDF: Bereinigung schreibt gültige Struktur und behält den Inhalt', async () => {
  const original = simplePdf()
  const result = await cleanPdf(original, { Title: 'Freigabe' }, DEFAULT_PDF_CLEAN)
  equal(result.error, undefined, `Fehler: ${result.error}`)

  equal(verifyXref(result.bytes), 'ok', 'Querverweistabelle fehlerhaft')
  const before = await pdfStructure(original)
  const after = await pdfStructure(result.bytes)
  equal(after.pages, before.pages, 'Seitenzahl verändert')
  equal(after.pages, 1, 'Seite verloren')

  const text = asText(result.bytes)
  includes(text, 'Sichtbarer Seitentext', 'Seiteninhalt verloren')
  excludes(text, 'Max Mustermann', 'Autor noch enthalten')
  excludes(text, 'Testprogramm 1.0', 'Erzeuger noch enthalten')
  excludes(text, 'Interner Entwurf', 'Alter Titel noch enthalten')
  includes(text, 'Freigabe', 'Neuer Titel fehlt')
})

await test('PDF: alte Fassungen verschwinden vollständig', async () => {
  const original = incrementalPdf()
  const before = asText(original)
  includes(before, 'Geheimer Erstentwurf', 'Testdatei enthält die alte Fassung nicht')
  includes(before, 'Dieser Absatz wurde geloescht', 'Testdatei enthält den gelöschten Absatz nicht')

  const info = await readPdf(original)
  const revisions = info.findings.find((f) => f.id === 'revisions')
  assert(revisions, `Mehrfache Fassungen nicht gemeldet: ${info.findings.map((f) => f.id).join(', ')}`)
  equal(info.values.Title, 'Freigegebene Fassung', 'Es muss die neueste Fassung gelesen werden')

  const result = await cleanPdf(original, info.values, DEFAULT_PDF_CLEAN)
  equal(result.error, undefined, `Fehler: ${result.error}`)
  const text = asText(result.bytes)

  excludes(text, 'Geheimer Erstentwurf', 'Alter Titel überlebt')
  excludes(text, 'Max Mustermann', 'Alter Autor überlebt')
  excludes(text, 'Dieser Absatz wurde geloescht', 'Gelöschter Absatz überlebt')
  includes(text, 'Sichtbarer Seitentext', 'Aktueller Inhalt verloren')
  includes(text, 'Freigegebene Fassung', 'Aktueller Titel verloren')
  equal(verifyXref(result.bytes), 'ok', 'Querverweistabelle fehlerhaft')
  equal((text.match(/%%EOF/g) ?? []).length, 1, 'Mehr als eine Fassung geschrieben')
})

await test('PDF: Objektströme werden ausgepackt', async () => {
  const original = objectStreamPdf()
  const structure = await pdfStructure(original)
  equal(structure.pages, 1, 'Seite im Objektstrom nicht gefunden')

  const result = await cleanPdf(original, { Title: 'Ohne Objektstrom' }, DEFAULT_PDF_CLEAN)
  equal(result.error, undefined, `Fehler: ${result.error}`)
  const text = asText(result.bytes)
  excludes(text, '/ObjStm', 'Objektstrom wurde erneut geschrieben')
  includes(text, '/Type /Catalog', 'Katalog fehlt nach dem Auspacken')
  includes(text, 'Sichtbarer Seitentext', 'Seiteninhalt verloren')
  equal((await pdfStructure(result.bytes)).pages, 1, 'Seitenzahl verändert')
  equal(verifyXref(result.bytes), 'ok', 'Querverweistabelle fehlerhaft')
})

await test('PDF: Anhänge und Skripte werden gemeldet und entfernt', async () => {
  const original = pdfWithExtras()
  const info = await readPdf(original)
  const found = info.findings.map((f) => f.id)
  assert(found.includes('embeddedFiles'), `Anhang nicht gemeldet: ${found.join(', ')}`)
  assert(found.includes('javascript'), `Skript nicht gemeldet: ${found.join(', ')}`)
  assert(found.includes('annotations'), `Anmerkung nicht gemeldet: ${found.join(', ')}`)

  const result = await cleanPdf(original, {}, DEFAULT_PDF_CLEAN)
  equal(result.error, undefined, `Fehler: ${result.error}`)
  const text = asText(result.bytes)
  excludes(text, 'Geheime Anhangsdaten', 'Anhangsinhalt überlebt')
  excludes(text, 'app.alert', 'Skript überlebt')
  excludes(text, 'Max Mustermann', 'Name in der Anmerkung überlebt')
  includes(text, 'Sichtbarer Seitentext', 'Seiteninhalt verloren')
  equal((await pdfStructure(result.bytes)).pages, 1, 'Seitenzahl verändert')
})

await test('PDF: verschlüsselte Dateien werden abgelehnt statt beschädigt', async () => {
  const original = encryptedPdf()
  const info = await readPdf(original)
  assert(info.error, 'Verschlüsselung nicht erkannt')
  includes(info.findings[0]?.detail ?? '', 'Verschlüsselte PDFs', 'Hinweis fehlt')

  const result = await cleanPdf(original, {}, DEFAULT_PDF_CLEAN)
  assert(result.error, 'Verschlüsselte Datei wurde trotzdem geschrieben')
  equal(result.bytes, original, 'Datei wurde trotz Ablehnung verändert')
})

await test('PDF: Nicht-PDF wird sauber abgelehnt', async () => {
  const info = await readPdf(new TextEncoder().encode('Das ist kein PDF'))
  assert(info.error, 'Fremdformat nicht erkannt')
})
