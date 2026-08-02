'use client'

import { useCallback, useMemo, useRef, useState } from 'react'
import {
  DEFAULT_OPTIONS,
  SUPPORTED_EXTENSIONS,
  buildReportText,
  cleanFile,
  loadFile,
  toW3CDTF,
  type CleanResult,
  type Field,
  type Finding,
  type LoadedFile,
  type Options,
  type ReportEntry,
} from '@/lib/clean'
import { OPTION_GROUPS, PROFILES, profileByKey } from '@/lib/profiles'
import { toLocalInput, type CustomProp } from '@/lib/officeMetadata'
import { writeZip } from '@/lib/zip'

interface Item {
  file: LoadedFile
  values: Record<string, string>
  customProps: CustomProp[]
  result?: CleanResult
}

const SEVERITY_STYLE: Record<Finding['severity'], string> = {
  hoch: 'bg-red-100 text-red-800',
  mittel: 'bg-amber-100 text-amber-900',
  niedrig: 'bg-stone-200 text-stone-700',
}

export default function MetadatenPage() {
  const [items, setItems] = useState<Item[]>([])
  const [selected, setSelected] = useState(0)
  const [profileKey, setProfileKey] = useState('standard')
  const [options, setOptions] = useState<Options>(DEFAULT_OPTIONS)
  const [dragging, setDragging] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [message, setMessage] = useState<{ kind: 'info' | 'error'; text: string } | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const accept = useMemo(() => SUPPORTED_EXTENSIONS.join(','), [])
  const current = items[selected]
  const kinds = useMemo(() => Array.from(new Set(items.map((item) => item.file.kind))), [items])

  const addFiles = useCallback(async (files: File[]) => {
    if (files.length === 0) return
    setBusy(`${files.length} Datei(en) werden gelesen…`)
    setMessage(null)
    const loaded: Item[] = []
    for (const file of files) {
      try {
        const bytes = new Uint8Array(await file.arrayBuffer())
        const parsed = await loadFile(file.name, bytes)
        loaded.push({ file: parsed, values: { ...parsed.values }, customProps: parsed.customProps.map((p) => ({ ...p })) })
      } catch (err) {
        setMessage({ kind: 'error', text: `${file.name}: ${err instanceof Error ? err.message : 'nicht lesbar'}` })
      }
    }
    setItems((previous) => [...previous, ...loaded])
    setBusy(null)
  }, [])

  /**
   * Turns a drop into a file list.
   *
   * When the browser hands us directory entries we go by those alone: the plain
   * `files` list of a folder drop also contains the folder itself, which would
   * otherwise be loaded as a bogus file. Files named directly by the user are
   * taken as they are — a format we cannot read then says so per file instead
   * of disappearing. Inside a folder we do filter by extension, otherwise a
   * Documents folder would drag in hundreds of unrelated files.
   */
  const filesFromDrop = async (transfer: DataTransfer): Promise<{ files: File[]; skipped: number }> => {
    const entries = Array.from(transfer.items)
      .map((item) => (typeof item.webkitGetAsEntry === 'function' ? item.webkitGetAsEntry() : null))
      .filter(Boolean) as FileSystemEntry[]
    if (entries.length === 0) return { files: Array.from(transfer.files), skipped: 0 }

    const out: File[] = []
    let skipped = 0
    const fileOf = (entry: FileSystemEntry) =>
      new Promise<File>((done, fail) => (entry as FileSystemFileEntry).file(done, fail))

    const walk = async (entry: FileSystemEntry, depth: number): Promise<void> => {
      if (entry.isFile) {
        const file = await fileOf(entry)
        if (SUPPORTED_EXTENSIONS.some((ext) => file.name.toLowerCase().endsWith(ext))) out.push(file)
        else skipped++
        return
      }
      if (!entry.isDirectory || depth > 6) return
      const reader = (entry as FileSystemDirectoryEntry).createReader()
      for (;;) {
        const batch = await new Promise<FileSystemEntry[]>((done, fail) => reader.readEntries(done, fail))
        if (batch.length === 0) break
        for (const child of batch) await walk(child, depth + 1)
      }
    }

    for (const entry of entries) {
      if (entry.isFile) out.push(await fileOf(entry))
      else await walk(entry, 0)
    }
    return { files: out, skipped }
  }

  const applyProfile = (key: string) => {
    setProfileKey(key)
    const profile = profileByKey(key)
    setOptions(profile.options)
    if (profile.clearAll) {
      setItems((previous) =>
        previous.map((item) => ({
          ...item,
          values: Object.fromEntries(item.file.fields.map((field) => [field.key, ''])),
          customProps: [],
        }))
      )
      setMessage({ kind: 'info', text: 'Profil „Streng" leert zusätzlich alle Eigenschaftsfelder.' })
    }
  }

  const setOption = (group: keyof Options, key: string, value: boolean) => {
    setOptions((previous) => ({ ...previous, [group]: { ...previous[group], [key]: value } }))
    setProfileKey('eigenes')
  }

  const cleanAll = async () => {
    if (items.length === 0) return
    setBusy('Dateien werden bereinigt…')
    setMessage(null)
    const done: Item[] = []
    for (const item of items) {
      const result = await cleanFile(item.file, item.values, item.customProps, options)
      done.push({ ...item, result })
    }
    setItems(done)
    setBusy(null)

    const failed = done.filter((item) => item.result?.error).length
    setMessage(
      failed > 0
        ? { kind: 'error', text: `${failed} von ${done.length} Datei(en) konnten nicht bereinigt werden — Details unten.` }
        : { kind: 'info', text: `${done.length} Datei(en) bereinigt. Unten herunterladen.` }
    )
  }

  const download = (bytes: Uint8Array, name: string, type = 'application/octet-stream') => {
    const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type }))
    const link = document.createElement('a')
    link.href = url
    link.download = name
    document.body.appendChild(link)
    link.click()
    link.remove()
    setTimeout(() => URL.revokeObjectURL(url), 10_000)
  }

  const downloadAll = async () => {
    const cleaned = items.filter((item) => item.result && !item.result.error)
    if (cleaned.length === 0) return
    if (cleaned.length === 1) {
      download(cleaned[0].result!.bytes, cleaned[0].result!.fileName)
      return
    }
    const blob = await writeZip(
      cleaned.map((item) => ({
        name: item.result!.fileName,
        data: item.result!.bytes,
        method: 8,
        dosTime: 0,
        dosDate: 33,
        externalAttr: 0,
      }))
    )
    download(new Uint8Array(await blob.arrayBuffer()), 'bereinigt.zip', 'application/zip')
  }

  const reportEntries = (): ReportEntry[] =>
    items.map((item) => ({
      file: item.result?.fileName ?? item.file.name,
      kind: item.file.kind,
      sizeBefore: item.file.size,
      sizeAfter: item.result?.bytes.length ?? item.file.size,
      sha256Before: item.file.sha256,
      sha256After: item.result?.sha256After ?? item.file.sha256,
      findingsBefore: item.file.findings,
      steps: item.result?.steps ?? [],
      remaining: item.result?.remaining ?? item.file.findings,
      error: item.result?.error ?? item.file.error,
    }))

  const downloadReport = () => {
    const text = buildReportText(reportEntries(), new Date().toLocaleString('de-DE'))
    download(new TextEncoder().encode(text), 'metadaten-protokoll.txt', 'text/plain')
  }

  const setValue = (key: string, value: string) =>
    setItems((previous) =>
      previous.map((item, index) => (index === selected ? { ...item, values: { ...item.values, [key]: value } } : item))
    )

  const relevantGroups = OPTION_GROUPS.filter((group) => kinds.some((kind) => group.kinds.includes(kind)))

  return (
    <div className="space-y-8">
      <header>
        <h1 className="text-3xl font-bold text-stone-800">Metadaten-Editor</h1>
        <p className="mt-2 text-stone-600">
          Dateien oder ganze Ordner hierher ziehen. Prüfen, bereinigen, herunterladen — vollständig im Browser, es
          wird nichts hochgeladen.
        </p>
      </header>

      <div
        onDragOver={(e) => {
          e.preventDefault()
          setDragging(true)
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={async (e) => {
          e.preventDefault()
          setDragging(false)
          const { files, skipped } = await filesFromDrop(e.dataTransfer)
          if (files.length === 0) {
            setMessage({
              kind: 'error',
              text:
                skipped > 0
                  ? `${skipped} Datei(en) im Ordner haben kein unterstütztes Format — nichts zu tun.`
                  : 'Aus dieser Ablage kam keine Datei an. Klick auf das Feld öffnet den Auswahldialog.',
            })
            return
          }
          await addFiles(files)
          if (skipped > 0) {
            setMessage({ kind: 'info', text: `${skipped} Datei(en) im Ordner übersprungen (Format wird nicht unterstützt).` })
          }
        }}
        onClick={() => inputRef.current?.click()}
        className={`cursor-pointer rounded-lg border-2 border-dashed p-10 text-center transition-colors ${
          dragging ? 'border-amber-700 bg-amber-50' : 'border-stone-300 bg-stone-100 hover:border-amber-600'
        }`}
      >
        <p className="text-lg font-medium text-stone-700">
          {items.length === 0 ? 'Dateien oder Ordner hierher ziehen' : `${items.length} Datei(en) geladen — weitere hinzufügen`}
        </p>
        <p className="mt-1 text-sm text-stone-500">
          Word, Excel, PowerPoint, OpenDocument, PDF, RTF, die alten .doc/.xls/.ppt, Bilder, MP3/MP4
        </p>
        <input
          ref={inputRef}
          type="file"
          multiple
          accept={accept}
          className="hidden"
          onChange={async (e) => {
            await addFiles(Array.from(e.target.files ?? []))
            e.target.value = ''
          }}
        />
      </div>

      {busy && <div className="rounded-md border border-stone-300 bg-stone-100 px-4 py-3 text-sm text-stone-700">{busy}</div>}
      {message && (
        <div
          className={`rounded-md border px-4 py-3 text-sm ${
            message.kind === 'error' ? 'border-red-300 bg-red-50 text-red-800' : 'border-amber-300 bg-amber-50 text-amber-900'
          }`}
        >
          {message.text}
        </div>
      )}

      {items.length > 0 && (
        <>
          <section className="rounded-lg border border-stone-200 bg-white p-6">
            <h2 className="mb-4 text-xl font-semibold text-stone-800">Profil</h2>
            <div className="grid gap-3 md:grid-cols-3">
              {PROFILES.map((profile) => (
                <button
                  key={profile.key}
                  onClick={() => applyProfile(profile.key)}
                  className={`rounded-md border p-3 text-left transition-colors ${
                    profileKey === profile.key ? 'border-amber-700 bg-amber-50' : 'border-stone-300 hover:border-amber-600'
                  }`}
                >
                  <span className="block font-medium text-stone-800">{profile.label}</span>
                  <span className="mt-1 block text-sm text-stone-500">{profile.description}</span>
                </button>
              ))}
            </div>
            {profileKey === 'eigenes' && (
              <p className="mt-3 text-sm text-stone-500">Eigene Auswahl — die Schalter unten weichen von den Profilen ab.</p>
            )}
          </section>

          <section className="rounded-lg border border-stone-200 bg-white p-6">
            <h2 className="mb-1 text-xl font-semibold text-stone-800">Dateien</h2>
            <p className="mb-4 text-sm text-stone-500">Zum Bearbeiten der Eigenschaften eine Datei auswählen.</p>
            <ul className="divide-y divide-stone-200">
              {items.map((item, index) => {
                const high = item.file.findings.filter((f) => f.severity === 'hoch').length
                return (
                  <li key={`${item.file.name}-${index}`}>
                    <button
                      onClick={() => setSelected(index)}
                      className={`flex w-full items-center justify-between gap-4 px-2 py-3 text-left ${
                        index === selected ? 'bg-amber-50' : 'hover:bg-stone-50'
                      }`}
                    >
                      <span className="min-w-0">
                        <span className="block truncate font-medium text-stone-800">{item.file.name}</span>
                        <span className="block text-sm text-stone-500">
                          {item.file.kind} · {Math.max(1, Math.round(item.file.size / 1024))} KB ·{' '}
                          {item.file.findings.length} Fund(e)
                          {item.file.error ? ` · ${item.file.error}` : ''}
                        </span>
                      </span>
                      <span className="flex shrink-0 items-center gap-2">
                        {high > 0 && <span className={`rounded px-2 py-0.5 text-xs ${SEVERITY_STYLE.hoch}`}>{high}× hoch</span>}
                        {item.result && !item.result.error && (
                          <span className="rounded bg-green-100 px-2 py-0.5 text-xs text-green-800">bereinigt</span>
                        )}
                        {item.result?.error && <span className="rounded bg-red-100 px-2 py-0.5 text-xs text-red-800">Fehler</span>}
                      </span>
                    </button>
                  </li>
                )
              })}
            </ul>
            <button
              onClick={() => {
                setItems([])
                setSelected(0)
                setMessage(null)
              }}
              className="mt-4 text-sm text-stone-600 underline hover:text-amber-800"
            >
              Liste leeren
            </button>
          </section>

          {current && current.file.fields.length > 0 && <FieldEditor item={current} onChange={setValue} />}

          {current && (
            <section className="rounded-lg border border-stone-200 bg-white p-6">
              <h2 className="mb-4 text-xl font-semibold text-stone-800">Befund: {current.file.name}</h2>
              {current.file.findings.length === 0 ? (
                <p className="text-sm text-stone-500">Keine der bekannten Spuren gefunden.</p>
              ) : (
                <ul className="space-y-3">
                  {current.file.findings.map((finding, index) => (
                    <li key={`${finding.id}-${index}`} className="border-l-2 border-stone-300 pl-3">
                      <p className="text-sm font-medium text-stone-700">
                        <span className={`mr-2 rounded px-2 py-0.5 text-xs ${SEVERITY_STYLE[finding.severity]}`}>
                          {finding.severity}
                        </span>
                        {finding.label}
                        {!finding.option && (
                          <span className="ml-2 rounded bg-stone-200 px-2 py-0.5 text-xs text-stone-700">
                            nur manuell zu beheben
                          </span>
                        )}
                      </p>
                      <p className="mt-1 text-sm text-stone-500">{finding.detail}</p>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}

          {relevantGroups.map((group) => (
            <section key={group.group} className="rounded-lg border border-stone-200 bg-white p-6">
              <h2 className="mb-4 text-xl font-semibold text-stone-800">{group.title}</h2>
              <div className="space-y-3">
                {group.items.map((item) => (
                  <label key={item.key} className="flex gap-3">
                    <input
                      type="checkbox"
                      checked={Boolean((options[group.group] as unknown as Record<string, boolean>)[item.key])}
                      onChange={(e) => setOption(group.group, item.key, e.target.checked)}
                      className="mt-1 h-4 w-4 accent-amber-700"
                    />
                    <span>
                      <span className="block text-sm font-medium text-stone-700">{item.label}</span>
                      <span className="block text-sm text-stone-500">{item.hint}</span>
                    </span>
                  </label>
                ))}
              </div>
            </section>
          ))}

          <div className="flex flex-wrap items-center gap-4">
            <button
              onClick={cleanAll}
              disabled={Boolean(busy)}
              className="rounded-md bg-amber-800 px-6 py-3 font-medium text-white hover:bg-amber-900 disabled:opacity-50"
            >
              {items.length === 1 ? 'Datei bereinigen' : `${items.length} Dateien bereinigen`}
            </button>
            {items.some((item) => item.result && !item.result.error) && (
              <button
                onClick={downloadAll}
                className="rounded-md bg-stone-200 px-4 py-3 font-medium text-stone-700 hover:bg-stone-300"
              >
                {items.filter((item) => item.result && !item.result.error).length === 1
                  ? 'Datei herunterladen'
                  : 'Alle als ZIP herunterladen'}
              </button>
            )}
            {items.some((item) => item.result) && (
              <button onClick={downloadReport} className="text-sm text-stone-600 underline hover:text-amber-800">
                Protokoll herunterladen
              </button>
            )}
          </div>

          {items.some((item) => item.result) && <ResultList items={items} />}
        </>
      )}

      <section className="rounded-lg border border-stone-300 bg-stone-100 p-6">
        <h2 className="mb-2 text-lg font-semibold text-stone-800">Was dieses Tool nicht kann</h2>
        <ul className="list-disc space-y-1 pl-5 text-sm text-stone-600">
          <li>Zeitstempel des Dateisystems — beim Speichern immer neu gesetzt.</li>
          <li>Versionsverlauf in OneDrive, SharePoint, Google Drive oder einem DMS.</li>
          <li>Kopien, die bereits verschickt wurden.</li>
          <li>Nachverfolgte Änderungen: die müssen in Word bzw. LibreOffice angenommen werden.</li>
          <li>Eingebettete Fremddokumente (OLE) und SmartArt-Datenmodelle — dort nur Hinweis, keine Automatik.</li>
          <li>Verschlüsselte PDFs werden bewusst abgelehnt statt beschädigt.</li>
        </ul>
        <p className="mt-3 text-sm text-stone-600">
          Rückdatierung fällt in forensischen Prüfungen regelmäßig auf und ist im rechtlichen Kontext strafbar.
        </p>
      </section>
    </div>
  )
}

function FieldEditor({ item, onChange }: { item: Item; onChange: (key: string, value: string) => void }) {
  const groups = Array.from(new Set(item.file.fields.map((field) => field.group)))

  return (
    <>
      {groups.map((group) => (
        <section key={group} className="rounded-lg border border-stone-200 bg-white p-6">
          <h2 className="mb-4 text-xl font-semibold text-stone-800">{group}</h2>
          <div className="grid gap-4 md:grid-cols-2">
            {item.file.fields
              .filter((field) => field.group === group)
              .map((field) => (
                <FieldInput key={field.key} field={field} value={item.values[field.key] ?? ''} onChange={onChange} />
              ))}
          </div>
        </section>
      ))}
    </>
  )
}

function FieldInput({
  field,
  value,
  onChange,
}: {
  field: Field
  value: string
  onChange: (key: string, value: string) => void
}) {
  const className = 'w-full rounded-md border border-stone-300 px-3 py-2 text-sm focus:border-amber-600 focus:outline-none'

  return (
    <div className={field.kind === 'longtext' ? 'md:col-span-2' : undefined}>
      <label className="mb-1 block text-sm font-medium text-stone-600">{field.label}</label>
      {field.kind === 'longtext' ? (
        <textarea rows={3} value={value} onChange={(e) => onChange(field.key, e.target.value)} className={className} />
      ) : field.kind === 'datetime' ? (
        <input
          type="datetime-local"
          value={toLocalInput(value)}
          onChange={(e) => onChange(field.key, e.target.value ? toW3CDTF(new Date(e.target.value)) : '')}
          className={className}
        />
      ) : (
        <input
          type={field.kind === 'number' ? 'number' : 'text'}
          value={value}
          onChange={(e) => onChange(field.key, e.target.value)}
          className={className}
        />
      )}
      {field.hint && <p className="mt-1 text-xs text-stone-500">{field.hint}</p>}
    </div>
  )
}

function ResultList({ items }: { items: Item[] }) {
  return (
    <section className="rounded-lg border border-stone-200 bg-white p-6">
      <h2 className="mb-4 text-xl font-semibold text-stone-800">Protokoll</h2>
      <div className="space-y-5">
        {items
          .filter((item) => item.result)
          .map((item, index) => (
            <div key={`${item.file.name}-${index}`}>
              <p className="font-medium text-stone-800">{item.result!.fileName}</p>
              {item.result!.error ? (
                <p className="mt-1 text-sm text-red-700">{item.result!.error}</p>
              ) : (
                <>
                  <p className="mt-1 font-mono text-xs text-stone-500">
                    SHA-256 vorher {item.result!.sha256Before.slice(0, 16)}… · nachher {item.result!.sha256After.slice(0, 16)}…
                  </p>
                  <ul className="mt-2 list-disc pl-5 text-sm text-stone-600">
                    {item.result!.steps.map((step, i) => (
                      <li key={i}>{step}</li>
                    ))}
                  </ul>
                  <p className="mt-2 text-sm">
                    {item.result!.remaining.length === 0 ? (
                      <span className="text-green-700">Nachkontrolle: keine Funde mehr.</span>
                    ) : (
                      <span className="text-amber-800">
                        Nachkontrolle: {item.result!.remaining.map((f) => f.label).join(', ')}
                      </span>
                    )}
                  </p>
                </>
              )}
            </div>
          ))}
      </div>
    </section>
  )
}
