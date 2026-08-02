import { detectFormat, inspectImage, stripImageMetadata } from '../lib/imageMeta'
import { assert, equal, excludes, includes, jpegWithMetadata, pngWithMetadata, test } from './helpers'

const asText = (bytes: Uint8Array) => new TextDecoder('latin1').decode(bytes)
const labels = (bytes: Uint8Array) => inspectImage(bytes).map((f) => f.label)

await test('JPEG wird erkannt und vollständig ausgelesen', () => {
  const jpeg = jpegWithMetadata()
  equal(detectFormat(jpeg), 'jpeg', 'Format nicht erkannt')

  const found = labels(jpeg)
  for (const expected of [
    'Kamera-Hersteller',
    'Kamera-Modell',
    'Software',
    'Aufnahmedatum',
    'Fotograf',
    'GPS-Position',
    'Seriennummer der Kamera',
    'XMP-Block (Bearbeitungsverlauf)',
    'IPTC-Block (Bildagentur-Daten)',
    'JPEG-Kommentar',
  ]) {
    assert(found.includes(expected), `"${expected}" nicht gefunden, nur: ${found.join(', ')}`)
  }

  const details = inspectImage(jpeg)
  equal(details.find((f) => f.label === 'Kamera-Modell')?.value, 'X-1000', 'Modell falsch gelesen')
  equal(details.find((f) => f.label === 'Fotograf')?.value, 'Max Mustermann', 'Fotograf falsch gelesen')
})

await test('JPEG-Bereinigung entfernt alle Metadaten, behält Bilddaten und ICC', () => {
  const jpeg = jpegWithMetadata()
  const cleaned = stripImageMetadata(jpeg)
  const text = asText(cleaned)

  excludes(text, 'Max Mustermann', 'Fotograf noch enthalten')
  excludes(text, 'ACME Cameras', 'Kamera noch enthalten')
  excludes(text, 'SN-12345678', 'Seriennummer noch enthalten')
  excludes(text, 'xmpmeta', 'XMP noch enthalten')
  excludes(text, 'IPTC-Daten', 'IPTC noch enthalten')
  excludes(text, 'nicht weitergeben', 'Kommentar noch enthalten')
  includes(text, 'ICC_PROFILE', 'ICC-Profil wurde fälschlich entfernt')
  includes(text, 'JFIF', 'JFIF-Header wurde fälschlich entfernt')

  equal(labels(cleaned).length, 0, 'Nach der Bereinigung wird noch etwas gefunden')
  assert(cleaned.length < jpeg.length, 'Datei wurde nicht kleiner')

  // Pixel data must survive byte for byte: SOS marker to end of file.
  const sos = (b: Uint8Array) => {
    for (let i = 2; i < b.length - 1; i++) if (b[i] === 0xff && b[i + 1] === 0xda) return b.subarray(i)
    throw new Error('kein SOS gefunden')
  }
  const before = sos(jpeg)
  const after = sos(cleaned)
  equal(after.length, before.length, 'Bilddaten haben andere Länge')
  for (let i = 0; i < before.length; i++) equal(after[i], before[i], `Bilddaten unterscheiden sich bei Byte ${i}`)
})

await test('PNG-Bereinigung entfernt Text-, XMP-, EXIF- und Zeitchunks', () => {
  const png = pngWithMetadata()
  const found = labels(png)
  assert(found.includes('PNG-Textfeld'), `tEXt nicht erkannt: ${found.join(', ')}`)
  assert(found.includes('XMP-Block (Bearbeitungsverlauf)'), 'iTXt nicht erkannt')
  assert(found.includes('GPS-Position'), 'eXIf-GPS nicht erkannt')
  assert(found.includes('Änderungszeitstempel im Bild'), 'tIME nicht erkannt')

  const cleaned = stripImageMetadata(png)
  const text = asText(cleaned)
  excludes(text, 'Max Mustermann', 'tEXt noch enthalten')
  excludes(text, 'xmpmeta', 'iTXt noch enthalten')
  excludes(text, 'eXIf', 'eXIf-Chunk noch enthalten')
  excludes(text, 'tIME', 'tIME-Chunk noch enthalten')
  includes(text, 'IHDR', 'IHDR fehlt')
  includes(text, 'IDAT', 'IDAT fehlt')
  includes(text, 'IEND', 'IEND fehlt')
  includes(text, 'pHYs', 'pHYs wurde fälschlich entfernt')
  equal(labels(cleaned).length, 0, 'Nach der Bereinigung wird noch etwas gefunden')
})

await test('Bilder ohne Metadaten bleiben unverändert', () => {
  const clean = stripImageMetadata(pngWithMetadata())
  const again = stripImageMetadata(clean)
  equal(again.length, clean.length, 'Zweiter Durchlauf ändert die Datei')
})

await test('Unbekannte Formate werden unverändert durchgereicht', () => {
  const junk = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])
  equal(detectFormat(junk), 'unknown', 'Format fälschlich erkannt')
  equal(stripImageMetadata(junk), junk, 'Unbekanntes Format wurde verändert')
})
