/**
 * Robustness: damaged input must never crash the tool, and whatever it hands
 * back without an error must read back cleanly. Every fixture is mangled in
 * several deterministic ways — truncated, bit-flipped, zero-filled, with
 * garbage appended — and pushed through load and clean.
 */

import { DEFAULT_OPTIONS, cleanFile, loadFile } from '../lib/clean'
import { readZip, writeZip, ZipError } from '../lib/zip'
import { docxEntries, pptxEntries, toZip, xlsxEntries } from './fixtures'
import { assert, equal, jpegWithMetadata, pngWithMetadata, test } from './helpers'
import { incrementalPdf, objectStreamPdf, pdfWithExtras, simplePdf } from './pdfFixtures'

/** Deterministic pseudo-random bytes, so a failure is reproducible. */
function lcg(seed: number) {
  let x = seed >>> 0
  return () => {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0
    return x
  }
}

function mutations(original: Uint8Array): { label: string; bytes: Uint8Array }[] {
  const out: { label: string; bytes: Uint8Array }[] = []
  const n = original.length
  for (const fraction of [0.1, 0.5, 0.9, 0.99]) {
    out.push({ label: `abgeschnitten bei ${Math.round(fraction * 100)} %`, bytes: original.slice(0, Math.floor(n * fraction)) })
  }
  for (const seed of [1, 2, 3]) {
    const random = lcg(seed)
    const copy = original.slice()
    for (let i = 0; i < Math.max(1, n / 200); i++) copy[random() % n] ^= 1 << random() % 8
    out.push({ label: `Bitfehler (Seed ${seed})`, bytes: copy })
  }
  const zeroed = original.slice()
  zeroed.fill(0, Math.floor(n / 3), Math.floor(n / 2))
  out.push({ label: 'Block genullt', bytes: zeroed })
  const junk = new TextEncoder().encode('MÜLL '.repeat(12))
  const appended = new Uint8Array(n + junk.length)
  appended.set(original)
  appended.set(junk, n)
  out.push({ label: 'Müll angehängt', bytes: appended })
  out.push({ label: 'leer', bytes: new Uint8Array(0) })
  out.push({ label: 'nur Signatur', bytes: original.slice(0, 4) })
  return out
}

async function mustSurvive(name: string, original: Uint8Array): Promise<void> {
  for (const { label, bytes } of mutations(original)) {
    let file
    try {
      file = await loadFile(name, bytes)
    } catch (err) {
      throw new Error(`${name} ${label}: loadFile hat eine Ausnahme geworfen: ${err instanceof Error ? err.message : err}`)
    }
    if (file.error) continue // refused cleanly — that is a valid outcome

    let result
    try {
      result = await cleanFile(file, file.values, file.customProps, DEFAULT_OPTIONS)
    } catch (err) {
      throw new Error(`${name} ${label}: cleanFile hat eine Ausnahme geworfen: ${err instanceof Error ? err.message : err}`)
    }
    if (result.error) continue

    // Whatever we claim to have cleaned must at least be readable again.
    const again = await loadFile(result.fileName, result.bytes)
    assert(!again.error, `${name} ${label}: Ergebnis liest sich nicht zurück: ${again.error}`)
    equal(again.kind, file.kind, `${name} ${label}: Ergebnis hat ein anderes Format`)
  }
}

await test('Beschädigte Word-Dateien stürzen nichts ab', async () => mustSurvive('bericht.docm', await toZip(docxEntries())))
await test('Beschädigte Excel-Dateien stürzen nichts ab', async () => mustSurvive('tabelle.xlsx', await toZip(xlsxEntries())))
await test('Beschädigte PowerPoint-Dateien stürzen nichts ab', async () => mustSurvive('folien.pptx', await toZip(pptxEntries())))
await test('Beschädigte PDFs stürzen nichts ab', async () => {
  for (const pdf of [simplePdf(), incrementalPdf(), objectStreamPdf(), pdfWithExtras()]) await mustSurvive('datei.pdf', pdf)
})
await test('Beschädigte Bilder stürzen nichts ab', async () => {
  await mustSurvive('foto.jpg', jpegWithMetadata())
  await mustSurvive('bild.png', pngWithMetadata())
})
await test('Beschädigtes RTF stürzt nichts ab', async () =>
  mustSurvive('text.rtf', new TextEncoder().encode('{\\rtf1\\ansi{\\info{\\title T}{\\author A}}\\pard Text\\par}')))

// ---------------------------------------------------------------------------
// ZIP guarantees
// ---------------------------------------------------------------------------

await test('ZIP: eine falsche Prüfsumme wird erkannt statt stillschweigend akzeptiert', async () => {
  const bytes = await toZip(docxEntries())
  // The central directory's CRC field of the first entry sits 16 bytes into
  // the first central header; find it via the signature.
  const view = new DataView(bytes.buffer)
  let at = -1
  for (let i = bytes.length - 22; i >= 0; i--) {
    if (view.getUint32(i, true) === 0x02014b50) at = i
  }
  assert(at > 0, 'Central Directory nicht gefunden')
  view.setUint32(at + 16, view.getUint32(at + 16, true) ^ 0xdeadbeef, true)
  let error: unknown
  await readZip(bytes.buffer).catch((err) => (error = err))
  assert(error instanceof ZipError, 'Prüfsummenfehler nicht gemeldet')
  assert(String((error as Error).message).includes('Prüfsumme'), `Falsche Meldung: ${(error as Error).message}`)
})

await test('ZIP: passwortgeschützte Archive werden klar abgelehnt', async () => {
  const bytes = await toZip(docxEntries())
  const view = new DataView(bytes.buffer)
  for (let i = bytes.length - 22; i >= 0; i--) {
    if (view.getUint32(i, true) === 0x02014b50) view.setUint16(i + 8, view.getUint16(i + 8, true) | 1, true)
  }
  let error: unknown
  await readZip(bytes.buffer).catch((err) => (error = err))
  assert(error instanceof ZipError, 'Verschlüsselung nicht gemeldet')
  assert(String((error as Error).message).includes('passwortgeschützt'), `Falsche Meldung: ${(error as Error).message}`)
})

await test('ZIP: unveränderte Einträge werden ohne Neukompression übernommen', async () => {
  const first = await toZip(docxEntries())
  const entries = await readZip(first.buffer)
  // Touch exactly one part, leave the rest alone.
  const core = entries.find((e) => e.name === 'docProps/core.xml')!
  core.data = new TextEncoder().encode(new TextDecoder().decode(core.data).replace('Max Mustermann', 'Anon'))
  const second = new Uint8Array(await (await writeZip(entries)).arrayBuffer())

  const before = await readZip(first.buffer)
  const after = await readZip(second.buffer)
  for (const entry of after) {
    const original = before.find((e) => e.name === entry.name)!
    if (entry.name === 'docProps/core.xml') {
      assert(new TextDecoder().decode(entry.data).includes('Anon'), 'Änderung nicht geschrieben')
      continue
    }
    // Same compressed bytes means they were copied, not recompressed.
    equal(entry.source!.raw.length, original.source!.raw.length, `${entry.name} wurde neu komprimiert`)
    equal(entry.source!.crc, original.source!.crc, `${entry.name} hat eine andere Prüfsumme`)
  }
})

await test('ZIP: Bilder werden gespeichert statt sinnlos komprimiert, und bleiben byteidentisch', async () => {
  const image = jpegWithMetadata()
  const bytes = new Uint8Array(await (await writeZip([{ name: 'word/media/image1.jpeg', data: image, method: 8, dosTime: 0, dosDate: 33, externalAttr: 0 }])).arrayBuffer())
  const [entry] = await readZip(bytes.buffer)
  equal(entry.source!.method, 0, 'JPEG wurde komprimiert')
  equal(entry.data.length, image.length, 'Länge verändert')
  for (let i = 0; i < image.length; i++) if (entry.data[i] !== image[i]) throw new Error(`Byte ${i} verändert`)
})

await test('ZIP: doppelte Einträge werden abgelehnt', async () => {
  const entry = { name: 'a.xml', data: new Uint8Array([1]), method: 8, dosTime: 0, dosDate: 33, externalAttr: 0 }
  let error: unknown
  await writeZip([entry, { ...entry }]).catch((err) => (error = err))
  assert(error instanceof ZipError, 'Doppelter Eintrag nicht gemeldet')
})

await test('Beschädigte Mediendateien stürzen nichts ab', async () => {
  const { mp3WithTags, mp4WithTags } = await import('./fixtures')
  await mustSurvive('ton.mp3', mp3WithTags())
  await mustSurvive('film.mp4', mp4WithTags())
})
await test('Beschädigte .doc-Dateien stürzen nichts ab', async () => {
  const { ole2Fixture } = await import('./fixtures')
  await mustSurvive('alt.doc', ole2Fixture())
})
