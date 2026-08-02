/**
 * Command line tool — the same cleaning engine as the app, for folders,
 * scripts and scheduled jobs.
 *
 *   metadaten-clean bericht.docx
 *   metadaten-clean --profil streng --rekursiv ~/Dokumente
 *   metadaten-clean --nur-bericht --bericht risiken.txt ~/Ausgehend
 *   metadaten-clean --ueberwachen ~/Ausgehend
 */

import { readdir, readFile, stat, writeFile, mkdir } from 'node:fs/promises'
import { dirname, extname, join, resolve } from 'node:path'
import { DOMParser, XMLSerializer } from '@xmldom/xmldom'

// The cleaning code is written against browser APIs.
const globals = globalThis as unknown as { DOMParser?: unknown; XMLSerializer?: unknown }
if (!globals.DOMParser) globals.DOMParser = DOMParser
if (!globals.XMLSerializer) globals.XMLSerializer = XMLSerializer

import {
  DEFAULT_OPTIONS,
  SUPPORTED_EXTENSIONS,
  buildReportText,
  cleanFile,
  loadFile,
  type Options,
  type ReportEntry,
} from '../lib/clean'

// ---------------------------------------------------------------------------
// Profiles — "policies" that decide what is switched on, in one place
// ---------------------------------------------------------------------------

const on = <T extends object>(options: T): T =>
  Object.fromEntries(Object.keys(options).map((key) => [key, true])) as T

export const PROFILES: Record<string, { description: string; options: Options; clearAll?: boolean }> = {
  standard: {
    description: 'Ausgewogen: Metadaten bereinigen, Inhalte unangetastet lassen',
    options: DEFAULT_OPTIONS,
  },
  streng: {
    description: 'Alles entfernen, was entfernt werden kann — inklusive Inhalten wie Notizen und ausgeblendeten Blättern',
    options: {
      base: on(DEFAULT_OPTIONS.base),
      deep: on(DEFAULT_OPTIONS.deep),
      odf: on(DEFAULT_OPTIONS.odf),
      pdf: on(DEFAULT_OPTIONS.pdf),
      rtf: on(DEFAULT_OPTIONS.rtf),
    },
    clearAll: true,
  },
  weitergabe: {
    description: 'Für den Versand nach außen: Namen anonymisieren, Notizen und Verknüpfungen entfernen',
    options: {
      base: { ...DEFAULT_OPTIONS.base, stripCustomProps: true, stripComments: true },
      deep: {
        ...DEFAULT_OPTIONS.deep,
        anonymizeAuthors: true,
        removeSpeakerNotes: true,
        removeChartWorkbooks: true,
        removeMacros: true,
      },
      odf: { ...DEFAULT_OPTIONS.odf, anonymizeAuthors: true },
      pdf: DEFAULT_OPTIONS.pdf,
      rtf: { ...DEFAULT_OPTIONS.rtf, anonymizeAuthors: true },
    },
  },
}

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

interface Args {
  paths: string[]
  profile: string
  profilePath?: string
  out?: string
  inPlace: boolean
  recursive: boolean
  watch: boolean
  intervalSeconds: number
  reportPath?: string
  json: boolean
  scanOnly: boolean
  clearAll: boolean
  values: Record<string, string>
  help: boolean
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    paths: [],
    profile: 'standard',
    inPlace: false,
    recursive: false,
    watch: false,
    intervalSeconds: 10,
    json: false,
    scanOnly: false,
    clearAll: false,
    values: {},
    help: false,
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const next = () => argv[++i]
    switch (arg) {
      case '--hilfe':
      case '--help':
      case '-h':
        args.help = true
        break
      case '--profil':
      case '--profile':
        args.profile = next()
        break
      case '--profil-datei':
        args.profilePath = next()
        break
      case '--ziel':
      case '--out':
        args.out = next()
        break
      case '--ersetzen':
        args.inPlace = true
        break
      case '--rekursiv':
        args.recursive = true
        break
      case '--ueberwachen':
      case '--watch':
        args.watch = true
        break
      case '--intervall':
        args.intervalSeconds = Math.max(2, Number(next()) || 10)
        break
      case '--bericht':
        args.reportPath = next()
        break
      case '--json':
        args.json = true
        break
      case '--nur-bericht':
        args.scanOnly = true
        break
      case '--alles-leeren':
        args.clearAll = true
        break
      case '--setzen': {
        const pair = next() ?? ''
        const at = pair.indexOf('=')
        if (at > 0) args.values[pair.slice(0, at)] = pair.slice(at + 1)
        break
      }
      default:
        if (arg.startsWith('-')) throw new Error(`Unbekannte Option: ${arg}`)
        args.paths.push(arg)
    }
  }

  return args
}

const HELP = `Metadaten-Bereinigung

  metadaten-clean [Optionen] <Datei|Ordner> ...

Optionen
  --profil <name>        standard | streng | weitergabe   (Vorgabe: standard)
  --profil-datei <pfad>  Eigenes Profil als JSON-Datei
  --ziel <ordner>        Ergebnisse dorthin schreiben
  --ersetzen             Dateien an Ort und Stelle überschreiben
  --rekursiv             Unterordner mitnehmen
  --ueberwachen          Ordner beobachten und neue Dateien automatisch bereinigen
  --intervall <sek>      Prüfabstand beim Überwachen (Vorgabe: 10)
  --nur-bericht          Nichts verändern, nur prüfen
  --bericht <datei>      Protokoll zusätzlich in eine Datei schreiben
  --json                 Ausgabe maschinenlesbar
  --alles-leeren         Alle Eigenschaftsfelder leeren
  --setzen key=wert      Einzelnes Feld setzen (mehrfach möglich)
  --hilfe                Diese Übersicht

Ohne --ziel und ohne --ersetzen wird "name-bereinigt.endung" daneben gelegt;
mit --ziel behalten die Dateien ihren Namen.
Der Rückgabewert ist 1, sobald eine Datei nicht verarbeitet werden konnte.`

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

async function collectFiles(paths: string[], recursive: boolean): Promise<string[]> {
  const files: string[] = []

  const visit = async (path: string, depth: number): Promise<void> => {
    const info = await stat(path).catch(() => null)
    if (!info) return
    if (info.isFile()) {
      if (SUPPORTED_EXTENSIONS.includes(extname(path).toLowerCase())) files.push(path)
      return
    }
    if (!info.isDirectory()) return
    if (depth > 0 && !recursive) return
    for (const item of await readdir(path)) {
      if (item.startsWith('.')) continue
      await visit(join(path, item), depth + 1)
    }
  }

  for (const path of paths) await visit(resolve(path), 0)
  return files
}

function targetPath(source: string, args: Args): string {
  if (args.inPlace) return source
  const extension = extname(source)
  const name = source.slice(0, source.length - extension.length)
  if (!args.out) return `${name}-bereinigt${extension}`
  return join(resolve(args.out), `${name.split('/').pop()}${extension}`)
}

async function loadProfile(args: Args): Promise<{ options: Options; clearAll: boolean }> {
  if (args.profilePath) {
    const raw = JSON.parse(await readFile(resolve(args.profilePath), 'utf8'))
    return {
      options: {
        base: { ...DEFAULT_OPTIONS.base, ...raw.base },
        deep: { ...DEFAULT_OPTIONS.deep, ...raw.deep },
        odf: { ...DEFAULT_OPTIONS.odf, ...raw.odf },
        pdf: { ...DEFAULT_OPTIONS.pdf, ...raw.pdf },
        rtf: { ...DEFAULT_OPTIONS.rtf, ...raw.rtf },
      },
      clearAll: Boolean(raw.clearAll),
    }
  }

  const profile = PROFILES[args.profile]
  if (!profile) throw new Error(`Unbekanntes Profil "${args.profile}". Verfügbar: ${Object.keys(PROFILES).join(', ')}`)
  return { options: profile.options, clearAll: Boolean(profile.clearAll) }
}

// ---------------------------------------------------------------------------
// Processing
// ---------------------------------------------------------------------------

async function processFile(
  path: string,
  args: Args,
  options: Options,
  clearAll: boolean
): Promise<ReportEntry> {
  const bytes = new Uint8Array(await readFile(path))
  const file = await loadFile(path.split('/').pop() ?? path, bytes)

  const entry: ReportEntry = {
    file: path,
    kind: file.kind,
    sizeBefore: bytes.length,
    sizeAfter: bytes.length,
    sha256Before: file.sha256,
    sha256After: file.sha256,
    findingsBefore: file.findings,
    steps: [],
    remaining: file.findings,
    error: file.error,
  }

  if (args.scanOnly || file.error) return entry

  const values: Record<string, string> = clearAll
    ? Object.fromEntries(file.fields.map((field) => [field.key, '']))
    : { ...file.values }
  for (const [key, value] of Object.entries(args.values)) values[key] = value

  const customProps = clearAll ? [] : file.customProps
  const result = await cleanFile(file, values, customProps, options)
  if (result.error) {
    entry.error = result.error
    return entry
  }

  const destination = targetPath(path, args).replace(/\.[^.]+$/, extname(result.fileName))
  await mkdir(dirname(destination), { recursive: true })
  await writeFile(destination, result.bytes)

  entry.file = destination
  entry.sizeAfter = result.bytes.length
  entry.sha256After = result.sha256After
  entry.steps = result.steps
  entry.remaining = result.remaining
  return entry
}

function printEntry(entry: ReportEntry, args: Args): void {
  if (args.json) return
  if (entry.error) {
    console.log(`✗ ${entry.file}\n    ${entry.error}`)
    return
  }
  if (args.scanOnly) {
    console.log(`• ${entry.file} (${entry.kind}) — ${entry.findingsBefore.length} Fund(e)`)
    for (const finding of entry.findingsBefore) console.log(`    [${finding.severity}] ${finding.label}`)
    return
  }
  console.log(`✓ ${entry.file} — ${entry.steps.length} Schritt(e), ${entry.remaining.length} Rest-Fund(e)`)
  for (const step of entry.steps) console.log(`    ${step}`)
  for (const finding of entry.remaining) console.log(`    offen: [${finding.severity}] ${finding.label}`)
}

async function runOnce(files: string[], args: Args, options: Options, clearAll: boolean): Promise<ReportEntry[]> {
  const entries: ReportEntry[] = []
  for (const path of files) {
    try {
      const entry = await processFile(path, args, options, clearAll)
      entries.push(entry)
      printEntry(entry, args)
    } catch (err) {
      const entry: ReportEntry = {
        file: path,
        kind: 'unbekannt',
        sizeBefore: 0,
        sizeAfter: 0,
        sha256Before: '',
        sha256After: '',
        findingsBefore: [],
        steps: [],
        remaining: [],
        error: err instanceof Error ? err.message : String(err),
      }
      entries.push(entry)
      printEntry(entry, args)
    }
  }
  return entries
}

async function watchLoop(args: Args, options: Options, clearAll: boolean): Promise<void> {
  const seen = new Map<string, number>()
  // Anything already there when we start counts as known, so a watch run does
  // not reprocess an entire folder on the first tick.
  for (const path of await collectFiles(args.paths, args.recursive)) {
    const info = await stat(path).catch(() => null)
    if (info) seen.set(path, info.mtimeMs)
  }
  console.log(`Überwache ${args.paths.join(', ')} (alle ${args.intervalSeconds}s, Abbruch mit Strg+C)`)

  for (;;) {
    await new Promise((done) => setTimeout(done, args.intervalSeconds * 1000))
    const files = await collectFiles(args.paths, args.recursive)
    const changed: string[] = []
    for (const path of files) {
      if (path.includes('-bereinigt')) continue
      const info = await stat(path).catch(() => null)
      if (!info) continue
      if (seen.get(path) === info.mtimeMs) continue
      seen.set(path, info.mtimeMs)
      changed.push(path)
    }
    if (changed.length > 0) await runOnce(changed, args, options, clearAll)
  }
}

export async function main(argv: string[]): Promise<number> {
  let args: Args
  try {
    args = parseArgs(argv)
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err))
    return 2
  }

  if (args.help || args.paths.length === 0) {
    console.log(HELP)
    return args.help ? 0 : 2
  }

  const { options, clearAll } = await loadProfile(args)

  if (args.watch) {
    await watchLoop(args, options, clearAll || args.clearAll)
    return 0
  }

  const files = await collectFiles(args.paths, args.recursive)
  if (files.length === 0) {
    console.error('Keine unterstützten Dateien gefunden.')
    return 2
  }

  const entries = await runOnce(files, args, options, clearAll || args.clearAll)
  const report = buildReportText(entries, new Date().toISOString())

  if (args.reportPath) {
    await writeFile(resolve(args.reportPath), report, 'utf8')
    if (!args.json) console.log(`\nProtokoll: ${resolve(args.reportPath)}`)
  }
  if (args.json) console.log(JSON.stringify({ entries }, null, 2))

  const failed = entries.filter((entry) => entry.error).length
  if (!args.json && failed > 0) console.error(`\n${failed} Datei(en) konnten nicht verarbeitet werden.`)
  return failed > 0 ? 1 : 0
}
