import { DEFAULT_ODF_CLEAN, cleanOdf, isOdfPackage, readOdfFields, scanOdf, writeOdfFields } from '../lib/odf'
import { DEFAULT_RTF_CLEAN, cleanRtf, isRtf, readRtfFields, scanRtf, writeRtfFields } from '../lib/rtf'
import { detectMedia, inspectMedia, stripMediaMetadata } from '../lib/mediaMeta'
import { isOle2, readOle2, writeOle2 } from '../lib/ole2'
import { textOf } from '../lib/ooxmlPackage'
import { makeEntries } from './fixtures'
import { assert, bytes, concatBytes, equal, excludes, includes, jpegWithMetadata, pngWithMetadata, test } from './helpers'

// ---------------------------------------------------------------------------
// OpenDocument
// ---------------------------------------------------------------------------

const odfEntries = () =>
  makeEntries({
    mimetype: 'application/vnd.oasis.opendocument.text',
    'META-INF/manifest.xml': '<?xml version="1.0"?><manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0"/>',
    'meta.xml':
      `<?xml version="1.0" encoding="UTF-8"?>` +
      `<office:document-meta xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" ` +
      `xmlns:meta="urn:oasis:names:tc:opendocument:xmlns:meta:1.0" xmlns:dc="http://purl.org/dc/elements/1.1/">` +
      `<office:meta><dc:title>Interner Entwurf</dc:title><meta:initial-creator>Max Mustermann</meta:initial-creator>` +
      `<dc:creator>Erika Musterfrau</dc:creator><meta:creation-date>2024-01-15T08:30:00</meta:creation-date>` +
      `<meta:generator>LibreOffice/7.4</meta:generator><meta:editing-cycles>17</meta:editing-cycles>` +
      `<meta:printed-by>Max Mustermann</meta:printed-by>` +
      `<meta:document-statistic meta:word-count="820"/>` +
      `<meta:user-defined meta:name="Aktenzeichen">AZ-2024-0815</meta:user-defined>` +
      `</office:meta></office:document-meta>`,
    'content.xml':
      `<?xml version="1.0" encoding="UTF-8"?><office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" ` +
      `xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:dc="http://purl.org/dc/elements/1.1/">` +
      `<office:body><office:text><text:p>Sichtbarer Text</text:p>` +
      `<office:annotation><dc:creator>Dr. Beispiel</dc:creator><text:p>Bitte prüfen</text:p></office:annotation>` +
      `<text:tracked-changes/></office:text></office:body></office:document-content>`,
    'Pictures/bild.jpg': jpegWithMetadata(),
    'Thumbnails/thumbnail.png': pngWithMetadata(),
  })

await test('ODF: Paket wird erkannt und Felder gelesen', () => {
  const entries = odfEntries()
  assert(isOdfPackage(entries), 'ODF-Paket nicht erkannt')
  const values = readOdfFields(entries)
  equal(values.title, 'Interner Entwurf', 'Titel falsch')
  equal(values['initial-creator'], 'Max Mustermann', 'Autor falsch')
  equal(values.creator, 'Erika Musterfrau', 'Letzter Bearbeiter falsch')
  equal(values['editing-cycles'], '17', 'Bearbeitungszyklen falsch')
})

await test('ODF: Funde werden gemeldet', () => {
  const found = scanOdf(odfEntries()).map((f) => f.id)
  for (const expected of ['imageMetadata', 'thumbnail', 'authors', 'trackedChanges', 'userFields']) {
    assert(found.includes(expected), `"${expected}" fehlt, gefunden: ${found.join(', ')}`)
  }
})

await test('ODF: Schreiben und Bereinigen', () => {
  const entries = odfEntries()
  writeOdfFields(entries, { title: 'Freigabe', 'initial-creator': 'Anon', creator: '', generator: '' })
  const meta = textOf(entries, 'meta.xml') ?? ''
  includes(meta, '<dc:title>Freigabe</dc:title>', 'Titel nicht geschrieben')
  includes(meta, 'Anon', 'Autor nicht geschrieben')
  excludes(meta, 'Erika Musterfrau', 'Geleertes Feld noch vorhanden')
  excludes(meta, 'LibreOffice/7.4', 'Erzeuger nicht entfernt')
  excludes(meta, 'document-statistic', 'Statistik nicht entfernt')

  const steps = cleanOdf(entries, { ...DEFAULT_ODF_CLEAN, anonymizeAuthors: true })
  const all = entries.map((e) => new TextDecoder('latin1').decode(e.data)).join('\n')
  excludes(all, 'AZ-2024-0815', 'Benutzerfeld nicht entfernt')
  excludes(all, 'Dr. Beispiel', 'Kommentarautor nicht ersetzt')
  excludes(all, 'ACME Cameras', 'Bildmetadaten nicht entfernt')
  includes(all, 'Sichtbarer Text', 'Inhalt zerstört')
  assert(!entries.some((e) => e.name.startsWith('Thumbnails/')), 'Vorschaubild nicht entfernt')
  assert(steps.length >= 3, `Zu wenige Schritte: ${steps.join(', ')}`)
})

// ---------------------------------------------------------------------------
// RTF
// ---------------------------------------------------------------------------

const RTF_SAMPLE =
  '{\\rtf1\\ansi\\deff0{\\fonttbl{\\f0 Times;}}' +
  '{\\info{\\title Interner Entwurf}{\\author Max Mustermann}{\\operator Erika Musterfrau}' +
  '{\\company Beispiel GmbH}{\\doccomm Erster Entwurf}\\vern1\\edmins412\\nofrev17}' +
  '{\\*\\generator Riched20 10.0.19041;}' +
  '{\\*\\revtbl{Unknown;}{Max Mustermann;}{Erika Musterfrau;}}' +
  '\\pard Sichtbarer Text\\par {\\*\\atnauthor Dr. Beispiel}{\\annotation Bitte pruefen}' +
  '\\revised Nachverfolgt\\par}'

await test('RTF: Felder werden gelesen', () => {
  assert(isRtf(RTF_SAMPLE), 'RTF nicht erkannt')
  const values = readRtfFields(RTF_SAMPLE)
  equal(values.title, 'Interner Entwurf', 'Titel falsch')
  equal(values.author, 'Max Mustermann', 'Autor falsch')
  equal(values.operator, 'Erika Musterfrau', 'Bearbeiter falsch')
  equal(values.company, 'Beispiel GmbH', 'Firma falsch')
  equal(values.editingTime, '412', 'Bearbeitungszeit falsch')
  equal(values.revisions, '17', 'Revisionen falsch')
})

await test('RTF: Funde werden gemeldet', () => {
  const found = scanRtf(RTF_SAMPLE).map((f) => f.id)
  for (const expected of ['authors', 'generator', 'annotations', 'trackedChanges']) {
    assert(found.includes(expected), `"${expected}" fehlt, gefunden: ${found.join(', ')}`)
  }
  includes(scanRtf(RTF_SAMPLE).find((f) => f.id === 'authors')?.detail ?? '', 'Max Mustermann', 'Name fehlt im Bericht')
})

await test('RTF: Schreiben ersetzt den Info-Block vollständig', () => {
  const written = writeRtfFields(RTF_SAMPLE, { title: 'Freigabe', author: '', company: 'Andere GmbH' })
  excludes(written, 'Max Mustermann}', 'Autor nicht entfernt')
  excludes(written, 'Interner Entwurf', 'Alter Titel geblieben')
  includes(written, '{\\title Freigabe}', 'Neuer Titel fehlt')
  includes(written, '{\\company Andere GmbH}', 'Firma fehlt')
  includes(written, 'Sichtbarer Text', 'Inhalt zerstört')

  const read = readRtfFields(written)
  equal(read.title, 'Freigabe', 'Rücklesen fehlgeschlagen')
  equal(read.author, '', 'Autor ist zurück')
})

await test('RTF: Bereinigung entfernt Erzeuger und Revisionstabelle', () => {
  const { text, steps } = cleanRtf(RTF_SAMPLE, { ...DEFAULT_RTF_CLEAN, anonymizeAuthors: true })
  excludes(text, 'Riched20', 'Erzeuger geblieben')
  excludes(text, 'revtbl', 'Revisionstabelle geblieben')
  excludes(text, 'Dr. Beispiel', 'Kommentarautor geblieben')
  includes(text, 'Sichtbarer Text', 'Inhalt zerstört')
  assert(steps.length >= 2, `Zu wenige Schritte: ${steps.join(', ')}`)
})

await test('RTF: geschweifte Klammern in Werten werden maskiert', () => {
  const written = writeRtfFields(RTF_SAMPLE, { title: 'Titel {mit} \\Klammern' })
  const read = readRtfFields(written)
  equal(read.title, 'Titel {mit} \\Klammern', 'Maskierung kaputt')
})

// ---------------------------------------------------------------------------
// Media
// ---------------------------------------------------------------------------

function mp3WithTags(): Uint8Array {
  const frames = concatBytes([
    bytes('TPE1'),
    new Uint8Array([0, 0, 0, 16, 0, 0]),
    bytes('\0Max Mustermann\0'),
    bytes('COMM'),
    new Uint8Array([0, 0, 0, 20, 0, 0]),
    bytes('\0deuInternes Material'),
  ])
  const size = frames.length
  const header = concatBytes([
    bytes('ID3'),
    new Uint8Array([3, 0, 0, (size >> 21) & 0x7f, (size >> 14) & 0x7f, (size >> 7) & 0x7f, size & 0x7f]),
  ])
  const audio = new Uint8Array([0xff, 0xfb, 0x90, 0x00, 1, 2, 3, 4, 5, 6, 7, 8])
  const id3v1 = concatBytes([bytes('TAG'), bytes('Titel'.padEnd(30, '\0')), bytes('Max Mustermann'.padEnd(95, '\0'))])
  return concatBytes([header, frames, audio, id3v1])
}

function mp4WithTags(): Uint8Array {
  // Box names are single bytes — "©nam" starts with 0xA9, not with UTF-8.
  const box = (type: string, payload: Uint8Array) => {
    const out = new Uint8Array(8 + payload.length)
    new DataView(out.buffer).setUint32(0, out.length)
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i) & 0xff
    out.set(payload, 8)
    return out
  }
  const udta = box('udta', concatBytes([box('©nam', bytes('Internes Video')), box('©xyz', bytes('+52.5200+13.4050/'))]))
  const moov = box('moov', concatBytes([box('mvhd', new Uint8Array(24)), udta]))
  return concatBytes([box('ftyp', bytes('isom')), moov, box('mdat', bytes('AUDIOVIDEODATEN'))])
}

await test('MP3: Tags werden erkannt und entfernt, Audio bleibt', () => {
  const mp3 = mp3WithTags()
  equal(detectMedia(mp3), 'mp3', 'Format nicht erkannt')
  const found = inspectMedia(mp3).map((f) => f.label)
  assert(found.some((f) => f.startsWith('ID3v2')), `ID3v2 nicht erkannt: ${found.join(', ')}`)
  assert(found.includes('ID3v1-Tag'), 'ID3v1 nicht erkannt')

  const cleaned = stripMediaMetadata(mp3)
  const text = new TextDecoder('latin1').decode(cleaned)
  excludes(text, 'Max Mustermann', 'Name geblieben')
  excludes(text, 'Internes Material', 'Kommentar geblieben')
  equal(cleaned[0], 0xff, 'Audio beginnt nicht mit einem Frame-Header')
  equal(inspectMedia(cleaned).length, 0, 'Nach der Bereinigung wird noch etwas gefunden')
})

await test('MP4: Tags werden überschrieben, Dateigröße bleibt gleich', () => {
  const mp4 = mp4WithTags()
  equal(detectMedia(mp4), 'mp4', 'Format nicht erkannt')
  const found = inspectMedia(mp4).map((f) => f.label)
  assert(found.includes('Benutzerdaten (udta)'), `udta nicht erkannt: ${found.join(', ')}`)
  assert(found.includes('GPS-Position'), 'GPS nicht erkannt')

  const cleaned = stripMediaMetadata(mp4)
  const text = new TextDecoder('latin1').decode(cleaned)
  excludes(text, 'Internes Video', 'Titel geblieben')
  excludes(text, '+52.5200', 'GPS geblieben')
  includes(text, 'AUDIOVIDEODATEN', 'Mediendaten verloren')
  // Byte offsets must not move, otherwise the sample tables break.
  equal(cleaned.length, mp4.length, 'Dateigröße verändert')
  includes(text, 'free', 'Platzhalter-Box fehlt')
})

// ---------------------------------------------------------------------------
// OLE2 (.doc/.xls/.ppt)
// ---------------------------------------------------------------------------

/** A compound file with two empty property-set streams in full sectors. */
function ole2Fixture(): Uint8Array {
  const SECTOR = 512
  const sectors = 18
  const out = new Uint8Array(SECTOR * (sectors + 1))
  const view = new DataView(out.buffer)

  out.set(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), 0)
  view.setUint16(0x1e, 9, true) // 512-byte sectors
  view.setUint16(0x20, 6, true) // 64-byte mini sectors
  view.setUint32(0x2c, 1, true) // one FAT sector
  view.setUint32(0x30, 1, true) // directory starts at sector 1
  view.setUint32(0x38, 4096, true) // mini stream cutoff
  view.setUint32(0x3c, 0xfffffffe, true) // no mini FAT
  view.setUint32(0x44, 0xfffffffe, true) // no DIFAT extension
  view.setUint32(0x4c, 0, true) // FAT lives in sector 0
  for (let i = 1; i < 109; i++) view.setUint32(0x4c + i * 4, 0xffffffff, true)

  const fat = SECTOR // sector 0 starts right after the header
  const setFat = (index: number, value: number) => view.setUint32(fat + index * 4, value, true)
  for (let i = 0; i < SECTOR / 4; i++) setFat(i, 0xffffffff)
  setFat(0, 0xfffffffd) // FAT itself
  setFat(1, 0xfffffffe) // directory
  for (let i = 2; i < 9; i++) setFat(i, i + 1)
  setFat(9, 0xfffffffe)
  for (let i = 10; i < 17; i++) setFat(i, i + 1)
  setFat(17, 0xfffffffe)

  const directory = SECTOR * 2
  const writeEntry = (index: number, name: string, type: number, start: number, size: number) => {
    const at = directory + index * 128
    for (let i = 0; i < name.length; i++) view.setUint16(at + i * 2, name.charCodeAt(i), true)
    view.setUint16(at + 0x40, name.length * 2 + 2, true)
    out[at + 0x42] = type
    view.setUint32(at + 0x74, start, true)
    view.setUint32(at + 0x78, size, true)
  }
  writeEntry(0, 'Root Entry', 5, 0xfffffffe, 0)
  writeEntry(1, 'SummaryInformation', 2, 2, 4096)
  writeEntry(2, 'DocumentSummaryInformation', 2, 10, 4096)

  // Two valid but empty property sets.
  for (const [start, fmtid] of [
    [2, 'e0859ff2f94f6810ab9108002b27b3d9'],
    [10, '02d5cdd59c2e1b1093970800 2b2cf9ae'.replace(/ /g, '')],
  ] as const) {
    const at = SECTOR * (start + 1)
    view.setUint16(at, 0xfffe, true)
    view.setUint32(at + 4, 0x00020006, true)
    view.setUint32(at + 24, 1, true)
    for (let i = 0; i < 16; i++) out[at + 28 + i] = parseInt(fmtid.substr(i * 2, 2), 16)
    view.setUint32(at + 44, 48, true)
    view.setUint32(at + 48, 8, true) // section size
    view.setUint32(at + 52, 0, true) // no properties
  }

  return out
}

await test('OLE2: Datei wird erkannt und gelesen', () => {
  const file = ole2Fixture()
  assert(isOle2(file), 'OLE2 nicht erkannt')
  const document = readOle2(file)
  assert(document, 'Datei nicht lesbar')
  equal(document!.values.title, '', 'Leeres Feld liefert nicht leer')
  assert(
    document!.findings.some((f) => f.id === 'legacyFormat'),
    'Hinweis auf das alte Format fehlt'
  )
})

await test('OLE2: Schreiben und Rücklesen der Eigenschaften', () => {
  const file = ole2Fixture()
  const written = writeOle2(file, {
    title: 'Freigegebener Bericht',
    creator: 'Anon',
    Company: 'Beispiel GmbH',
    TotalTime: '42',
    created: '2020-03-05T09:15:00Z',
  })
  equal(written.error, undefined, `Fehler: ${written.error}`)
  equal(written.bytes.length, file.length, 'Dateigröße verändert — die Struktur muss erhalten bleiben')

  const document = readOle2(written.bytes)
  assert(document, 'Ergebnis nicht mehr lesbar')
  equal(document!.values.title, 'Freigegebener Bericht', 'Titel falsch zurückgelesen')
  equal(document!.values.creator, 'Anon', 'Autor falsch zurückgelesen')
  equal(document!.values.Company, 'Beispiel GmbH', 'Firma falsch zurückgelesen')
  equal(document!.values.TotalTime, '42', 'Zahl falsch zurückgelesen')
  includes(document!.values.created, '2020-03-05', 'Datum falsch zurückgelesen')
})

await test('OLE2: zu lange Werte werden abgelehnt statt die Datei zu zerstören', () => {
  const file = ole2Fixture()
  const result = writeOle2(file, { title: 'x'.repeat(5000) })
  assert(result.error, 'Überlanger Wert wurde nicht abgelehnt')
  equal(result.bytes, file, 'Datei wurde trotz Ablehnung verändert')
})

await test('OLE2: Leeren entfernt alle Eigenschaften', () => {
  const file = ole2Fixture()
  const filled = writeOle2(file, { title: 'Geheim', creator: 'Max Mustermann' }).bytes
  includes(new TextDecoder('latin1').decode(filled), 'Max Mustermann', 'Testaufbau falsch')

  const cleared = writeOle2(filled, {})
  equal(cleared.error, undefined, `Fehler: ${cleared.error}`)
  excludes(new TextDecoder('latin1').decode(cleared.bytes), 'Max Mustermann', 'Autor nicht entfernt')
  excludes(new TextDecoder('latin1').decode(cleared.bytes), 'Geheim', 'Titel nicht entfernt')
})
