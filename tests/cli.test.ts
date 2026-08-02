import { mkdtemp, readFile, readdir, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PROFILES, main } from '../cli/main'
import { readZip } from '../lib/zip'
import { decodeText } from '../lib/ooxmlPackage'
import { docxEntries, toZip } from './fixtures'
import { assert, equal, excludes, includes, test } from './helpers'

/**
 * The text inside an OOXML file is deflate-compressed, so searching the raw
 * bytes would silently succeed for every "must not contain" assertion.
 */
async function packageText(path: string): Promise<string> {
  const bytes = new Uint8Array(await readFile(path))
  const entries = await readZip(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer)
  return entries.map((entry) => decodeText(entry.data)).join('\n')
}

/** Runs the CLI with stdout captured, so the suite stays readable. */
async function run(args: string[]): Promise<{ code: number; output: string }> {
  const lines: string[] = []
  const log = console.log
  const error = console.error
  console.log = (...parts: unknown[]) => lines.push(parts.join(' '))
  console.error = (...parts: unknown[]) => lines.push(parts.join(' '))
  try {
    const code = await main(args)
    return { code, output: lines.join('\n') }
  } finally {
    console.log = log
    console.error = error
  }
}

async function workspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'metadaten-'))
  await mkdir(join(dir, 'unterordner'), { recursive: true })
  await writeFile(join(dir, 'bericht.docm'), await toZip(docxEntries()))
  await writeFile(join(dir, 'unterordner', 'kopie.docx'), await toZip(docxEntries()))
  await writeFile(join(dir, 'notiz.txt'), 'wird ignoriert')
  return dir
}

await test('CLI: Nur-Bericht verändert nichts und listet die Funde', async () => {
  const dir = await workspace()
  const { code, output } = await run(['--nur-bericht', dir])

  equal(code, 0, 'Rückgabewert falsch')
  includes(output, 'bericht.docm', 'Datei nicht aufgeführt')
  includes(output, 'Fund(e)', 'Funde nicht gemeldet')
  const files = await readdir(dir)
  assert(!files.some((name) => name.includes('bereinigt')), 'Es wurde trotz --nur-bericht geschrieben')
})

await test('CLI: ohne --rekursiv bleibt der Unterordner unangetastet', async () => {
  const dir = await workspace()
  await run([dir])
  const sub = await readdir(join(dir, 'unterordner'))
  equal(sub.length, 1, `Unterordner wurde bearbeitet: ${sub.join(', ')}`)
})

await test('CLI: rekursiv, mit Profil und Protokolldatei', async () => {
  const dir = await workspace()
  const reportPath = join(dir, 'protokoll.txt')
  const { code, output } = await run(['--profil', 'weitergabe', '--rekursiv', '--bericht', reportPath, dir])

  equal(code, 0, `Rückgabewert ${code}, Ausgabe: ${output}`)
  const files = await readdir(dir)
  // Macro removal must also change the extension.
  assert(files.includes('bericht-bereinigt.docx'), `Ergebnisdatei fehlt: ${files.join(', ')}`)
  assert((await readdir(join(dir, 'unterordner'))).includes('kopie-bereinigt.docx'), 'Unterordner nicht bearbeitet')

  const cleaned = await packageText(join(dir, 'bericht-bereinigt.docx'))
  excludes(cleaned, 'Erika Musterfrau', 'Name in der Ausgabedatei geblieben')
  excludes(cleaned, 'Max Mustermann', 'Name in der Ausgabedatei geblieben')
  includes(cleaned, 'Autor 1', 'Ersatzname fehlt in der Ausgabedatei')
  includes(cleaned, 'Sichtbarer Text', 'Inhalt der Ausgabedatei zerstört')

  const report = await readFile(reportPath, 'utf8')
  includes(report, 'SHA-256', 'Hashes fehlen im Protokoll')
  includes(report, 'Nachkontrolle', 'Nachkontrolle fehlt im Protokoll')
  includes(report, 'Autor 1', 'Ersetzung nicht protokolliert')
})

await test('CLI: --alles-leeren und --setzen wirken auf die Eigenschaften', async () => {
  const dir = await workspace()
  await run(['--alles-leeren', '--setzen', 'title=Freigabe', '--ziel', join(dir, 'aus'), join(dir, 'bericht.docm')])

  // Mit --ziel behalten die Dateien ihren Namen; die Endung bleibt .docm,
  // weil das Standardprofil keine Makros entfernt.
  const written = await readdir(join(dir, 'aus'))
  equal(written.join(','), 'bericht.docm', 'Unerwartete Ausgabedateien')
  const text = await packageText(join(dir, 'aus', 'bericht.docm'))
  includes(text, '<dc:title>Freigabe</dc:title>', 'Gesetzter Titel fehlt')
  excludes(text, '<dc:creator>', 'Autorenfeld wurde nicht geleert')
  excludes(text, '<cp:lastModifiedBy>', 'Bearbeiterfeld wurde nicht geleert')
  // Der Name im VBA-Projekt bleibt: Makros entfernt erst das Profil "streng".
  includes(text, 'VBA-Modul von Max Mustermann', 'Testannahme zum Makro stimmt nicht mehr')
})

await test('CLI: unbekanntes Profil und fehlende Pfade werden gemeldet', async () => {
  const dir = await workspace()
  let failed = false
  await main(['--profil', 'gibtsnicht', dir]).catch(() => (failed = true))
  assert(failed, 'Unbekanntes Profil wurde akzeptiert')

  const { code } = await run([])
  equal(code, 2, 'Aufruf ohne Pfade muss mit 2 enden')
})

await test('CLI: die Profile sind vollständig definiert', () => {
  for (const key of ['standard', 'streng', 'weitergabe']) {
    const profile = PROFILES[key]
    assert(profile, `Profil "${key}" fehlt`)
    for (const group of ['base', 'deep', 'odf', 'pdf', 'rtf'] as const) {
      assert(profile.options[group], `Profil "${key}" hat keine Gruppe "${group}"`)
    }
  }
  const strict = PROFILES.streng.options
  assert(
    Object.values(strict.deep).every(Boolean),
    'Profil "streng" muss alle Tiefenreinigungs-Schalter aktivieren'
  )
})

await test('CLI: ein Profil kann eine Vorlage für alle Dateien mitbringen', async () => {
  const dir = await workspace()
  const profil = join(dir, 'profil.json')
  await writeFile(profil, JSON.stringify({ values: { title: 'Aus der Vorlage', creator: 'Anon' } }))

  await run(['--profil-datei', profil, '--rekursiv', dir])
  for (const datei of ['bericht-bereinigt.docm', join('unterordner', 'kopie-bereinigt.docx')]) {
    const text = await packageText(join(dir, datei))
    includes(text, '<dc:title>Aus der Vorlage</dc:title>', `Titel aus der Vorlage fehlt in ${datei}`)
    includes(text, '<dc:creator>Anon</dc:creator>', `Autor aus der Vorlage fehlt in ${datei}`)
  }

  // --setzen sticht die Vorlage.
  const dir2 = await workspace()
  await run(['--profil-datei', profil, '--setzen', 'title=Direkt gesetzt', join(dir2, 'bericht.docm')])
  includes(await packageText(join(dir2, 'bericht-bereinigt.docm')), '<dc:title>Direkt gesetzt</dc:title>', 'Vorrang von --setzen fehlt')
})

await test('CLI: Anonymisieren sticht einen gesetzten Namen', async () => {
  const dir = await workspace()
  const profil = join(dir, 'profil.json')
  await writeFile(profil, JSON.stringify({ deep: { anonymizeAuthors: true }, values: { creator: 'Anon' } }))

  await run(['--profil-datei', profil, join(dir, 'bericht.docm')])
  const text = await packageText(join(dir, 'bericht-bereinigt.docm'))
  // Der gesetzte Name wird mit anonymisiert — die stärkere Maßnahme gewinnt.
  excludes(text, '<dc:creator>Anon</dc:creator>', 'Gesetzter Name blieb trotz Anonymisierung stehen')
  includes(text, '<dc:creator>Autor ', 'Kein Platzhalter gesetzt')
})
