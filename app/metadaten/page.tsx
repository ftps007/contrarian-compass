'use client'

import { useCallback, useMemo, useRef, useState } from 'react'
import {
  DEFAULT_CLEANUP,
  FIELDS,
  SUPPORTED_EXTENSIONS,
  buildDocument,
  loadDocument,
  toLocalInput,
  toW3CDTF,
  type CleanupOptions,
  type CustomProp,
  type OfficeDoc,
} from '@/lib/officeMetadata'

const CLEANUP_LABELS: { key: keyof CleanupOptions; label: string; hint: string }[] = [
  {
    key: 'normalizeZipTimestamps',
    label: 'ZIP-Zeitstempel angleichen',
    hint: 'Setzt das Datum aller Paketteile auf „Geändert am". Ohne das verraten die internen Zeitstempel die echte Bearbeitung.',
  },
  {
    key: 'stripRsids',
    label: 'Word-RSIDs entfernen',
    hint: 'Löscht die Sitzungs-IDs, mit denen sich Bearbeitungsrunden und verwandte Dokumente zuordnen lassen.',
  },
  {
    key: 'stripThumbnail',
    label: 'Vorschaubild entfernen',
    hint: 'Das eingebettete Vorschaubild zeigt oft einen älteren Stand der ersten Seite.',
  },
  {
    key: 'stripCustomProps',
    label: 'Benutzerdefinierte Eigenschaften löschen',
    hint: 'Entfernt die komplette custom.xml statt sie einzeln zu bearbeiten.',
  },
  {
    key: 'stripComments',
    label: 'Kommentare & Personenliste entfernen (Word)',
    hint: 'Löscht comments.xml/people.xml samt Verweisen. Nachverfolgte Änderungen bleiben — die müssen in Word angenommen werden.',
  },
]

export default function MetadatenPage() {
  const [doc, setDoc] = useState<OfficeDoc | null>(null)
  const [values, setValues] = useState<Record<string, string>>({})
  const [customProps, setCustomProps] = useState<CustomProp[]>([])
  const [cleanup, setCleanup] = useState<CleanupOptions>(DEFAULT_CLEANUP)
  const [dragging, setDragging] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const accept = useMemo(() => SUPPORTED_EXTENSIONS.join(','), [])

  const openFile = useCallback(async (file: File) => {
    setBusy(true)
    setError(null)
    setStatus(null)
    try {
      const loaded = await loadDocument(file)
      setDoc(loaded)
      setValues(loaded.values)
      setCustomProps(loaded.customProps)
    } catch (err) {
      setDoc(null)
      setError(err instanceof Error ? err.message : 'Die Datei konnte nicht gelesen werden.')
    } finally {
      setBusy(false)
    }
  }, [])

  const onDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault()
      setDragging(false)
      const file = event.dataTransfer.files?.[0]
      if (file) void openFile(file)
    },
    [openFile]
  )

  const setValue = (key: string, value: string) => setValues((prev) => ({ ...prev, [key]: value }))

  const clearAll = () => {
    const cleared: Record<string, string> = {}
    for (const field of FIELDS) cleared[field.key] = ''
    setValues(cleared)
    setCustomProps([])
    setStatus('Alle Felder geleert. Leere Felder werden beim Speichern komplett aus der Datei entfernt.')
  }

  const applyAuthorEverywhere = () => {
    const author = values.creator?.trim()
    if (!author) {
      setStatus('Trage zuerst einen Autor ein.')
      return
    }
    setValues((prev) => ({ ...prev, lastModifiedBy: author }))
  }

  const neutralizeCounters = () => {
    setValues((prev) => ({ ...prev, revision: '1', TotalTime: '0', lastPrinted: '' }))
    setStatus('Revisionsnummer auf 1, Bearbeitungszeit auf 0, Druckdatum entfernt.')
  }

  const download = async () => {
    if (!doc) return
    setBusy(true)
    setError(null)
    setStatus(null)
    try {
      const { blob } = await buildDocument(doc, values, customProps, cleanup)
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = doc.fileName
      document.body.appendChild(link)
      link.click()
      link.remove()
      // Revoking straight away can cancel the download in some browsers.
      setTimeout(() => URL.revokeObjectURL(url), 10_000)
      setStatus(
        'Datei gespeichert. Öffne sie einmal zur Kontrolle — und denk daran, dass der Zeitstempel deines Dateisystems jetzt „heute" ist.'
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Die Datei konnte nicht geschrieben werden.')
    } finally {
      setBusy(false)
    }
  }

  const coreFields = FIELDS.filter((f) => f.part === 'core')
  const appFields = FIELDS.filter((f) => f.part === 'app')

  return (
    <div className="space-y-8">
      <header>
        <h1 className="text-3xl font-bold text-stone-800">Metadaten-Editor</h1>
        <p className="mt-2 text-stone-600">
          Office-Datei hierher ziehen, Eigenschaften bearbeiten, neu speichern. Die Verarbeitung passiert
          vollständig im Browser — es wird nichts hochgeladen.
        </p>
      </header>

      <div
        onDragOver={(e) => {
          e.preventDefault()
          setDragging(true)
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        onClick={() => inputRef.current?.click()}
        className={`cursor-pointer rounded-lg border-2 border-dashed p-10 text-center transition-colors ${
          dragging ? 'border-amber-700 bg-amber-50' : 'border-stone-300 bg-stone-100 hover:border-amber-600'
        }`}
      >
        <p className="text-lg font-medium text-stone-700">
          {doc ? doc.fileName : 'Datei hierher ziehen oder klicken'}
        </p>
        <p className="mt-1 text-sm text-stone-500">{SUPPORTED_EXTENSIONS.join('  ')}</p>
        <input
          ref={inputRef}
          type="file"
          accept={accept}
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0]
            if (file) void openFile(file)
            e.target.value = ''
          }}
        />
      </div>

      {error && (
        <div className="rounded-md border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800">{error}</div>
      )}
      {status && (
        <div className="rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">{status}</div>
      )}

      {doc && (
        <>
          <div className="flex flex-wrap gap-2">
            <button
              onClick={clearAll}
              className="rounded-md bg-stone-200 px-4 py-2 text-sm font-medium text-stone-700 hover:bg-stone-300"
            >
              Alle Felder leeren
            </button>
            <button
              onClick={applyAuthorEverywhere}
              className="rounded-md bg-stone-200 px-4 py-2 text-sm font-medium text-stone-700 hover:bg-stone-300"
            >
              Autor auch als „zuletzt geändert von"
            </button>
            <button
              onClick={neutralizeCounters}
              className="rounded-md bg-stone-200 px-4 py-2 text-sm font-medium text-stone-700 hover:bg-stone-300"
            >
              Zähler zurücksetzen
            </button>
            <button
              onClick={() => {
                const now = toW3CDTF(new Date())
                setValues((prev) => ({ ...prev, created: now, modified: now }))
              }}
              className="rounded-md bg-stone-200 px-4 py-2 text-sm font-medium text-stone-700 hover:bg-stone-300"
            >
              Datum auf jetzt
            </button>
          </div>

          <section className="rounded-lg border border-stone-200 bg-white p-6">
            <h2 className="mb-4 text-xl font-semibold text-stone-800">Dokumenteigenschaften</h2>
            <div className="grid gap-4 md:grid-cols-2">
              {coreFields.map((field) => (
                <FieldInput key={field.key} field={field} value={values[field.key] ?? ''} onChange={setValue} />
              ))}
            </div>
          </section>

          <section className="rounded-lg border border-stone-200 bg-white p-6">
            <h2 className="mb-4 text-xl font-semibold text-stone-800">Erweiterte Eigenschaften</h2>
            <div className="grid gap-4 md:grid-cols-2">
              {appFields.map((field) => (
                <FieldInput key={field.key} field={field} value={values[field.key] ?? ''} onChange={setValue} />
              ))}
            </div>
          </section>

          {customProps.length > 0 && (
            <section className="rounded-lg border border-stone-200 bg-white p-6">
              <h2 className="mb-4 text-xl font-semibold text-stone-800">Benutzerdefinierte Eigenschaften</h2>
              <div className="space-y-3">
                {customProps.map((prop, index) => (
                  <div key={prop.name} className="flex items-end gap-3">
                    <div className="flex-1">
                      <label className="mb-1 block text-sm font-medium text-stone-600">
                        {prop.name} <span className="text-stone-400">({prop.type})</span>
                      </label>
                      <input
                        value={prop.value}
                        onChange={(e) =>
                          setCustomProps((prev) =>
                            prev.map((p, i) => (i === index ? { ...p, value: e.target.value } : p))
                          )
                        }
                        className="w-full rounded-md border border-stone-300 px-3 py-2 text-sm focus:border-amber-600 focus:outline-none"
                      />
                    </div>
                    <button
                      onClick={() => setCustomProps((prev) => prev.filter((_, i) => i !== index))}
                      className="rounded-md bg-stone-200 px-3 py-2 text-sm text-stone-700 hover:bg-red-100 hover:text-red-800"
                    >
                      Löschen
                    </button>
                  </div>
                ))}
              </div>
            </section>
          )}

          <section className="rounded-lg border border-stone-200 bg-white p-6">
            <h2 className="mb-4 text-xl font-semibold text-stone-800">Zusätzliche Spuren</h2>
            <div className="space-y-3">
              {CLEANUP_LABELS.map(({ key, label, hint }) => (
                <label key={key} className="flex gap-3">
                  <input
                    type="checkbox"
                    checked={cleanup[key]}
                    onChange={(e) => setCleanup((prev) => ({ ...prev, [key]: e.target.checked }))}
                    className="mt-1 h-4 w-4 accent-amber-700"
                  />
                  <span>
                    <span className="block text-sm font-medium text-stone-700">{label}</span>
                    <span className="block text-sm text-stone-500">{hint}</span>
                  </span>
                </label>
              ))}
            </div>
          </section>

          <section className="rounded-lg border border-stone-200 bg-white p-6">
            <h2 className="mb-4 text-xl font-semibold text-stone-800">In dieser Datei gefunden</h2>
            {doc.traces.length === 0 ? (
              <p className="text-sm text-stone-500">Keine der bekannten Zusatzspuren gefunden.</p>
            ) : (
              <ul className="space-y-3">
                {doc.traces.map((trace) => (
                  <li key={trace.id} className="border-l-2 border-stone-300 pl-3">
                    <p className="text-sm font-medium text-stone-700">
                      {trace.label}
                      {!trace.removable && (
                        <span className="ml-2 rounded bg-red-100 px-2 py-0.5 text-xs text-red-800">
                          nicht automatisch entfernbar
                        </span>
                      )}
                    </p>
                    <p className="text-sm text-stone-500">{trace.detail}</p>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <div className="flex items-center gap-4">
            <button
              onClick={download}
              disabled={busy}
              className="rounded-md bg-amber-800 px-6 py-3 font-medium text-white hover:bg-amber-900 disabled:opacity-50"
            >
              {busy ? 'Wird geschrieben…' : 'Bearbeitete Datei speichern'}
            </button>
            <button
              onClick={() => {
                setValues(doc.values)
                setCustomProps(doc.customProps)
                setStatus('Ursprüngliche Werte wiederhergestellt.')
              }}
              className="text-sm text-stone-600 underline hover:text-amber-800"
            >
              Änderungen verwerfen
            </button>
          </div>
        </>
      )}

      <section className="rounded-lg border border-stone-300 bg-stone-100 p-6">
        <h2 className="mb-2 text-lg font-semibold text-stone-800">Was dieses Tool nicht kann</h2>
        <p className="mb-3 text-sm text-stone-600">
          Bearbeitete Metadaten sind kein sauberer Zustand — sie sind ein bearbeiteter Zustand. Außerhalb der Datei
          bleiben Spuren, an die kein Editor herankommt:
        </p>
        <ul className="list-disc space-y-1 pl-5 text-sm text-stone-600">
          <li>Zeitstempel des Dateisystems (Erstellt/Geändert/Zugriff) — beim Speichern immer neu gesetzt.</li>
          <li>Versionsverlauf in OneDrive, SharePoint, Google Drive, Dropbox oder einem DMS.</li>
          <li>Kopien, die bereits per Mail, Chat oder Backup verschickt wurden.</li>
          <li>
            Kompressionsmerkmale: die Datei wird hier neu gepackt, das unterscheidet sich messbar von einer
            Original-Word-Datei.
          </li>
          <li>Inhaltliche Spuren wie nachverfolgte Änderungen oder in Bildern eingebettete EXIF-Daten.</li>
        </ul>
        <p className="mt-3 text-sm text-stone-600">
          Für den eigentlichen Zweck — persönliche Daten vor der Weitergabe eines Dokuments entfernen — reicht das
          hier vollständig aus. Als Nachweis gegenüber Dritten, dass ein Dokument zu einem bestimmten Zeitpunkt
          entstanden ist, taugen manipulierte Metadaten nicht: Rückdatierung fällt in forensischen Prüfungen
          regelmäßig auf und ist im rechtlichen Kontext strafbar.
        </p>
      </section>
    </div>
  )
}

function FieldInput({
  field,
  value,
  onChange,
}: {
  field: (typeof FIELDS)[number]
  value: string
  onChange: (key: string, value: string) => void
}) {
  const common =
    'w-full rounded-md border border-stone-300 px-3 py-2 text-sm focus:border-amber-600 focus:outline-none'

  return (
    <div className={field.kind === 'longtext' ? 'md:col-span-2' : undefined}>
      <label className="mb-1 block text-sm font-medium text-stone-600">{field.label}</label>
      {field.kind === 'longtext' ? (
        <textarea rows={3} value={value} onChange={(e) => onChange(field.key, e.target.value)} className={common} />
      ) : field.kind === 'datetime' ? (
        <input
          type="datetime-local"
          value={toLocalInput(value)}
          onChange={(e) => onChange(field.key, e.target.value ? toW3CDTF(new Date(e.target.value)) : '')}
          className={common}
        />
      ) : (
        <input
          type={field.kind === 'number' ? 'number' : 'text'}
          value={value}
          onChange={(e) => onChange(field.key, e.target.value)}
          className={common}
        />
      )}
      {field.hint && <p className="mt-1 text-xs text-stone-500">{field.hint}</p>}
    </div>
  )
}
