/**
 * Vanilla-JS UI for the standalone (file://) build of the metadata editor.
 *
 * The OOXML logic is shared with the web page — it is imported from lib/ and
 * bundled into a single HTML file by standalone/build.mjs, so there is no
 * second copy of the parsing and rewriting rules.
 */

import {
  DEFAULT_CLEANUP,
  FIELDS,
  SUPPORTED_EXTENSIONS,
  buildDocument,
  loadDocument,
  toLocalInput,
  toW3CDTF,
} from '../lib/officeMetadata'

const CLEANUP_LABELS = [
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

const state = {
  doc: null,
  values: {},
  customProps: [],
  cleanup: { ...DEFAULT_CLEANUP },
}

const $ = (id) => document.getElementById(id)

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag)
  for (const [key, value] of Object.entries(props)) {
    if (key === 'class') node.className = value
    else if (key === 'text') node.textContent = value
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value)
    else node.setAttribute(key, value)
  }
  for (const child of children) node.appendChild(child)
  return node
}

function setMessage(kind, text) {
  const box = $('message')
  box.className = text ? `message ${kind}` : 'hidden'
  box.textContent = text ?? ''
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

async function openFile(file) {
  setMessage('info', 'Datei wird gelesen…')
  try {
    const doc = await loadDocument(file)
    state.doc = doc
    state.values = { ...doc.values }
    state.customProps = doc.customProps.map((p) => ({ ...p }))
    state.cleanup = { ...DEFAULT_CLEANUP }
    $('dropzone-name').textContent = doc.fileName
    render()
    setMessage(null, null)
  } catch (err) {
    state.doc = null
    $('editor').classList.add('hidden')
    setMessage('error', err instanceof Error ? err.message : 'Die Datei konnte nicht gelesen werden.')
  }
}

function wireDropzone() {
  const zone = $('dropzone')
  const input = $('file-input')
  input.setAttribute('accept', SUPPORTED_EXTENSIONS.join(','))
  $('dropzone-formats').textContent = SUPPORTED_EXTENSIONS.join('  ')

  zone.addEventListener('click', () => input.click())
  zone.addEventListener('dragover', (e) => {
    e.preventDefault()
    zone.classList.add('dragging')
  })
  zone.addEventListener('dragleave', () => zone.classList.remove('dragging'))
  zone.addEventListener('drop', (e) => {
    e.preventDefault()
    zone.classList.remove('dragging')
    const file = e.dataTransfer.files?.[0]
    if (file) void openFile(file)
  })
  input.addEventListener('change', (e) => {
    const file = e.target.files?.[0]
    if (file) void openFile(file)
    e.target.value = ''
  })

  // Dropping anywhere on the window works too — the zone is just the hint.
  document.addEventListener('dragover', (e) => e.preventDefault())
  document.addEventListener('drop', (e) => {
    e.preventDefault()
    const file = e.dataTransfer?.files?.[0]
    if (file) void openFile(file)
  })
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function fieldRow(field) {
  const value = state.values[field.key] ?? ''
  let input

  if (field.kind === 'longtext') {
    input = el('textarea', { rows: '3' })
    input.value = value
    input.addEventListener('input', () => (state.values[field.key] = input.value))
  } else if (field.kind === 'datetime') {
    input = el('input', { type: 'datetime-local' })
    input.value = toLocalInput(value)
    input.addEventListener('input', () => {
      state.values[field.key] = input.value ? toW3CDTF(new Date(input.value)) : ''
    })
  } else {
    input = el('input', { type: field.kind === 'number' ? 'number' : 'text' })
    input.value = value
    input.addEventListener('input', () => (state.values[field.key] = input.value))
  }

  input.id = `field-${field.key}`
  const children = [el('label', { text: field.label, for: input.id }), input]
  if (field.hint) children.push(el('p', { class: 'hint', text: field.hint }))
  return el('div', { class: field.kind === 'longtext' ? 'field wide' : 'field' }, children)
}

function renderFields(containerId, part) {
  const container = $(containerId)
  container.replaceChildren(...FIELDS.filter((f) => f.part === part).map(fieldRow))
}

function renderCustomProps() {
  const section = $('custom-section')
  const container = $('custom-props')
  if (state.customProps.length === 0) {
    section.classList.add('hidden')
    return
  }
  section.classList.remove('hidden')

  container.replaceChildren(
    ...state.customProps.map((prop, index) => {
      const input = el('input', { type: 'text' })
      input.value = prop.value
      input.addEventListener('input', () => (state.customProps[index].value = input.value))
      return el('div', { class: 'custom-row' }, [
        el('div', { class: 'field' }, [el('label', { text: `${prop.name} (${prop.type})` }), input]),
        el('button', {
          class: 'ghost danger',
          text: 'Löschen',
          onclick: () => {
            state.customProps.splice(index, 1)
            renderCustomProps()
          },
        }),
      ])
    })
  )
}

function renderCleanup() {
  const container = $('cleanup')
  container.replaceChildren(
    ...CLEANUP_LABELS.map(({ key, label, hint }) => {
      const box = el('input', { type: 'checkbox', id: `cleanup-${key}` })
      box.checked = state.cleanup[key]
      box.addEventListener('change', () => (state.cleanup[key] = box.checked))
      return el('label', { class: 'check' }, [
        box,
        el('span', {}, [el('span', { class: 'check-label', text: label }), el('span', { class: 'hint', text: hint })]),
      ])
    })
  )
}

function renderTraces() {
  const container = $('traces')
  if (!state.doc || state.doc.traces.length === 0) {
    container.replaceChildren(el('p', { class: 'hint', text: 'Keine der bekannten Zusatzspuren gefunden.' }))
    return
  }
  container.replaceChildren(
    ...state.doc.traces.map((trace) => {
      const heading = el('p', { class: 'trace-label', text: trace.label })
      if (!trace.removable) heading.appendChild(el('span', { class: 'badge', text: 'nicht automatisch entfernbar' }))
      return el('li', {}, [heading, el('p', { class: 'hint', text: trace.detail })])
    })
  )
}

function render() {
  $('editor').classList.remove('hidden')
  renderFields('core-fields', 'core')
  renderFields('app-fields', 'app')
  renderCustomProps()
  renderCleanup()
  renderTraces()
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

function wireActions() {
  $('clear-all').addEventListener('click', () => {
    for (const field of FIELDS) state.values[field.key] = ''
    state.customProps = []
    render()
    setMessage('info', 'Alle Felder geleert. Leere Felder werden beim Speichern komplett aus der Datei entfernt.')
  })

  $('same-author').addEventListener('click', () => {
    const author = (state.values.creator ?? '').trim()
    if (!author) {
      setMessage('info', 'Trage zuerst einen Autor ein.')
      return
    }
    state.values.lastModifiedBy = author
    render()
  })

  $('reset-counters').addEventListener('click', () => {
    state.values.revision = '1'
    state.values.TotalTime = '0'
    state.values.lastPrinted = ''
    render()
    setMessage('info', 'Revisionsnummer auf 1, Bearbeitungszeit auf 0, Druckdatum entfernt.')
  })

  $('now').addEventListener('click', () => {
    const now = toW3CDTF(new Date())
    state.values.created = now
    state.values.modified = now
    render()
  })

  $('revert').addEventListener('click', () => {
    if (!state.doc) return
    state.values = { ...state.doc.values }
    state.customProps = state.doc.customProps.map((p) => ({ ...p }))
    render()
    setMessage('info', 'Ursprüngliche Werte wiederhergestellt.')
  })

  $('save').addEventListener('click', async () => {
    if (!state.doc) return
    const button = $('save')
    button.disabled = true
    try {
      const { blob } = await buildDocument(state.doc, state.values, state.customProps, state.cleanup)
      const url = URL.createObjectURL(blob)
      const link = el('a', { href: url, download: state.doc.fileName })
      document.body.appendChild(link)
      link.click()
      link.remove()
      setTimeout(() => URL.revokeObjectURL(url), 10_000)
      setMessage(
        'info',
        'Datei im Download-Ordner gespeichert. Öffne sie einmal zur Kontrolle — und denk daran, dass der Zeitstempel deines Dateisystems jetzt „heute" ist.'
      )
    } catch (err) {
      setMessage('error', err instanceof Error ? err.message : 'Die Datei konnte nicht geschrieben werden.')
    } finally {
      button.disabled = false
    }
  })
}

if (typeof CompressionStream === 'undefined') {
  setMessage('error', 'Dieser Browser ist zu alt (CompressionStream fehlt). Nimm Safari 16.4+, Chrome oder Firefox 113+.')
} else {
  wireDropzone()
  wireActions()
}
