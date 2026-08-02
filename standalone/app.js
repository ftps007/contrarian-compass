/**
 * Vanilla-JS front end for the standalone (file://) build.
 *
 * Same engine as the web page — lib/clean.ts is bundled in by
 * standalone/build.mjs — so there is no second copy of the cleaning rules,
 * only a second presentation of them.
 */

import {
  DEFAULT_OPTIONS,
  SUPPORTED_EXTENSIONS,
  buildReportText,
  cleanFile,
  loadFile,
  toW3CDTF,
} from '../lib/clean'
import { OPTION_GROUPS, PROFILES, profileByKey } from '../lib/profiles'
import { toLocalInput } from '../lib/officeMetadata'
import { writeZip } from '../lib/zip'

const state = {
  items: [],
  selected: 0,
  profile: 'standard',
  options: DEFAULT_OPTIONS,
}

const $ = (id) => document.getElementById(id)

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag)
  for (const [key, value] of Object.entries(props)) {
    if (key === 'class') node.className = value
    else if (key === 'text') node.textContent = value
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value)
    else if (value !== undefined && value !== null) node.setAttribute(key, value)
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

async function addFiles(files) {
  if (files.length === 0) return
  setMessage('info', `${files.length} Datei(en) werden gelesen…`)
  for (const file of files) {
    try {
      const bytes = new Uint8Array(await file.arrayBuffer())
      const parsed = await loadFile(file.name, bytes)
      state.items.push({
        file: parsed,
        values: { ...parsed.values },
        customProps: parsed.customProps.map((p) => ({ ...p })),
        result: null,
      })
    } catch (err) {
      setMessage('error', `${file.name}: ${err instanceof Error ? err.message : 'nicht lesbar'}`)
      render()
      return
    }
  }
  setMessage(null, null)
  render()
}

/** Dropped folders arrive as directory entries and have to be walked. */
async function filesFromDrop(transfer) {
  const entries = Array.from(transfer.items || [])
    .map((item) => (typeof item.webkitGetAsEntry === 'function' ? item.webkitGetAsEntry() : null))
    .filter(Boolean)
  if (entries.length === 0) return Array.from(transfer.files || [])

  const out = []
  const walk = async (entry, depth) => {
    if (entry.isFile) {
      const file = await new Promise((done, fail) => entry.file(done, fail))
      if (SUPPORTED_EXTENSIONS.some((ext) => file.name.toLowerCase().endsWith(ext))) out.push(file)
      return
    }
    if (!entry.isDirectory || depth > 6) return
    const reader = entry.createReader()
    for (;;) {
      const batch = await new Promise((done, fail) => reader.readEntries(done, fail))
      if (batch.length === 0) break
      for (const child of batch) await walk(child, depth + 1)
    }
  }
  for (const entry of entries) await walk(entry, 0)
  return out
}

function wireDropzone() {
  const zone = $('dropzone')
  const input = $('file-input')
  input.setAttribute('accept', SUPPORTED_EXTENSIONS.join(','))
  $('dropzone-formats').textContent =
    'Word, Excel, PowerPoint, OpenDocument, PDF, RTF, die alten .doc/.xls/.ppt, Bilder, MP3/MP4'

  zone.addEventListener('click', () => input.click())
  input.addEventListener('change', async (e) => {
    await addFiles(Array.from(e.target.files || []))
    e.target.value = ''
  })

  const stop = (e) => {
    e.preventDefault()
    e.stopPropagation()
  }
  for (const target of [zone, document]) {
    target.addEventListener('dragover', (e) => {
      stop(e)
      zone.classList.add('dragging')
    })
    target.addEventListener('dragleave', () => zone.classList.remove('dragging'))
    target.addEventListener('drop', async (e) => {
      stop(e)
      zone.classList.remove('dragging')
      await addFiles(await filesFromDrop(e.dataTransfer))
    })
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderProfiles() {
  $('profiles').replaceChildren(
    ...PROFILES.map((profile) =>
      el('button', {
        class: `profile ${state.profile === profile.key ? 'active' : ''}`,
        onclick: () => applyProfile(profile.key),
      }, [
        el('span', { class: 'profile-label', text: profile.label }),
        el('span', { class: 'hint', text: profile.description }),
      ])
    )
  )
}

function applyProfile(key) {
  state.profile = key
  const profile = profileByKey(key)
  state.options = profile.options
  if (profile.clearAll) {
    for (const item of state.items) {
      item.values = Object.fromEntries(item.file.fields.map((field) => [field.key, '']))
      item.customProps = []
    }
    setMessage('info', 'Profil „Streng" leert zusätzlich alle Eigenschaftsfelder.')
  }
  render()
}

function renderFileList() {
  const container = $('file-list')
  container.replaceChildren(
    ...state.items.map((item, index) => {
      const high = item.file.findings.filter((f) => f.severity === 'hoch').length
      const badges = []
      if (high > 0) badges.push(el('span', { class: 'badge hoch', text: `${high}× hoch` }))
      if (item.result && !item.result.error) badges.push(el('span', { class: 'badge ok', text: 'bereinigt' }))
      if (item.result?.error) badges.push(el('span', { class: 'badge hoch', text: 'Fehler' }))

      return el('button', {
        class: `file-row ${index === state.selected ? 'active' : ''}`,
        onclick: () => {
          state.selected = index
          render()
        },
      }, [
        el('span', { class: 'file-main' }, [
          el('span', { class: 'file-name', text: item.file.name }),
          el('span', {
            class: 'hint',
            text: `${item.file.kind} · ${Math.max(1, Math.round(item.file.size / 1024))} KB · ${item.file.findings.length} Fund(e)${item.file.error ? ` · ${item.file.error}` : ''}`,
          }),
        ]),
        el('span', { class: 'badges' }, badges),
      ])
    })
  )
}

function fieldRow(field, item) {
  const value = item.values[field.key] ?? ''
  let input

  if (field.kind === 'longtext') {
    input = el('textarea', { rows: '3' })
    input.value = value
    input.addEventListener('input', () => (item.values[field.key] = input.value))
  } else if (field.kind === 'datetime') {
    input = el('input', { type: 'datetime-local' })
    input.value = toLocalInput(value)
    input.addEventListener('input', () => {
      item.values[field.key] = input.value ? toW3CDTF(new Date(input.value)) : ''
    })
  } else {
    input = el('input', { type: field.kind === 'number' ? 'number' : 'text' })
    input.value = value
    input.addEventListener('input', () => (item.values[field.key] = input.value))
  }

  input.id = `field-${field.key}`
  const children = [el('label', { text: field.label, for: input.id }), input]
  if (field.hint) children.push(el('p', { class: 'hint', text: field.hint }))
  return el('div', { class: field.kind === 'longtext' ? 'field wide' : 'field' }, children)
}

function renderFields() {
  const container = $('fields')
  const item = state.items[state.selected]
  container.replaceChildren()
  if (!item || item.file.fields.length === 0) return

  const groups = Array.from(new Set(item.file.fields.map((field) => field.group)))
  for (const group of groups) {
    container.appendChild(
      el('section', {}, [
        el('h2', { text: group }),
        el(
          'div',
          { class: 'grid' },
          item.file.fields.filter((field) => field.group === group).map((field) => fieldRow(field, item))
        ),
      ])
    )
  }
}

function renderFindings() {
  const item = state.items[state.selected]
  const section = $('findings-section')
  if (!item) {
    section.classList.add('hidden')
    return
  }
  section.classList.remove('hidden')
  $('findings-title').textContent = `Befund: ${item.file.name}`

  const list = $('findings')
  if (item.file.findings.length === 0) {
    list.replaceChildren(el('p', { class: 'hint', text: 'Keine der bekannten Spuren gefunden.' }))
    return
  }
  list.replaceChildren(
    ...item.file.findings.map((finding) => {
      const heading = el('p', { class: 'finding-label' }, [
        el('span', { class: `badge ${finding.severity}`, text: finding.severity }),
        el('span', { text: ` ${finding.label}` }),
      ])
      if (!finding.option) heading.appendChild(el('span', { class: 'badge', text: 'nur manuell zu beheben' }))
      return el('li', {}, [heading, el('p', { class: 'hint', text: finding.detail })])
    })
  )
}

function renderOptions() {
  const kinds = Array.from(new Set(state.items.map((item) => item.file.kind)))
  const container = $('options')
  container.replaceChildren(
    ...OPTION_GROUPS.filter((group) => kinds.some((kind) => group.kinds.includes(kind))).map((group) =>
      el('section', {}, [
        el('h2', { text: group.title }),
        el(
          'div',
          {},
          group.items.map((option) => {
            const box = el('input', { type: 'checkbox', id: `option-${group.group}-${option.key}` })
            box.checked = Boolean(state.options[group.group][option.key])
            box.addEventListener('change', () => {
              state.options = {
                ...state.options,
                [group.group]: { ...state.options[group.group], [option.key]: box.checked },
              }
              state.profile = 'eigenes'
              renderProfiles()
            })
            return el('label', { class: 'check' }, [
              box,
              el('span', {}, [
                el('span', { class: 'check-label', text: option.label }),
                el('span', { class: 'hint', text: option.hint }),
              ]),
            ])
          })
        ),
      ])
    )
  )
}

function renderResults() {
  const section = $('results-section')
  const done = state.items.filter((item) => item.result)
  if (done.length === 0) {
    section.classList.add('hidden')
    return
  }
  section.classList.remove('hidden')

  $('results').replaceChildren(
    ...done.map((item) => {
      const children = [el('p', { class: 'file-name', text: item.result.fileName })]
      if (item.result.error) {
        children.push(el('p', { class: 'error-text', text: item.result.error }))
      } else {
        children.push(
          el('p', {
            class: 'hash',
            text: `SHA-256 vorher ${item.result.sha256Before.slice(0, 16)}… · nachher ${item.result.sha256After.slice(0, 16)}…`,
          }),
          el('ul', {}, item.result.steps.map((step) => el('li', { text: step }))),
          el('p', {
            class: item.result.remaining.length === 0 ? 'ok-text' : 'warn-text',
            text:
              item.result.remaining.length === 0
                ? 'Nachkontrolle: keine Funde mehr.'
                : `Nachkontrolle: ${item.result.remaining.map((f) => f.label).join(', ')}`,
          })
        )
      }
      return el('div', { class: 'result' }, children)
    })
  )
}

function render() {
  const hasFiles = state.items.length > 0
  $('editor').classList.toggle('hidden', !hasFiles)
  $('dropzone-name').textContent = hasFiles
    ? `${state.items.length} Datei(en) geladen — weitere hinzufügen`
    : 'Dateien oder Ordner hierher ziehen'
  if (!hasFiles) {
    $('results-section').classList.add('hidden')
    return
  }
  if (state.selected >= state.items.length) state.selected = 0

  renderProfiles()
  renderFileList()
  renderFields()
  renderFindings()
  renderOptions()
  renderResults()

  const cleaned = state.items.filter((item) => item.result && !item.result.error)
  $('clean').textContent = state.items.length === 1 ? 'Datei bereinigen' : `${state.items.length} Dateien bereinigen`
  $('download').classList.toggle('hidden', cleaned.length === 0)
  const verb = runsNative() ? 'sichern' : 'herunterladen'
  $('download').textContent = cleaned.length === 1 ? `Datei ${verb}` : `Alle als ZIP ${verb}`
  $('report').classList.toggle('hidden', state.items.every((item) => !item.result))
  $('report').textContent = `Protokoll ${verb}`
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/** The native shell exposes a save bridge; in a browser we fall back to a download. */
const nativeSave = () => globalThis.webkit?.messageHandlers?.speichern ?? null

export const runsNative = () => nativeSave() !== null

function toBase64(bytes) {
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}

function download(bytes, name, type = 'application/octet-stream') {
  const bridge = nativeSave()
  if (bridge) {
    bridge.postMessage({ name, daten: toBase64(bytes) })
    return
  }
  const url = URL.createObjectURL(new Blob([bytes], { type }))
  const link = el('a', { href: url, download: name })
  document.body.appendChild(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

function wireActions() {
  $('clean').addEventListener('click', async () => {
    const button = $('clean')
    button.disabled = true
    setMessage('info', 'Dateien werden bereinigt…')
    try {
      for (const item of state.items) {
        item.result = await cleanFile(item.file, item.values, item.customProps, state.options)
      }
      const failed = state.items.filter((item) => item.result?.error).length
      const wohin = runsNative() ? 'Unten sichern.' : 'Unten herunterladen.'
      setMessage(
        failed > 0 ? 'error' : 'info',
        failed > 0
          ? `${failed} von ${state.items.length} Datei(en) konnten nicht bereinigt werden — Details unten.`
          : `${state.items.length} Datei(en) bereinigt. ${wohin}`
      )
    } catch (err) {
      setMessage('error', err instanceof Error ? err.message : 'Die Bereinigung ist fehlgeschlagen.')
    } finally {
      button.disabled = false
      render()
    }
  })

  $('download').addEventListener('click', async () => {
    const cleaned = state.items.filter((item) => item.result && !item.result.error)
    if (cleaned.length === 0) return
    if (cleaned.length === 1) {
      download(cleaned[0].result.bytes, cleaned[0].result.fileName)
      return
    }
    const blob = await writeZip(
      cleaned.map((item) => ({
        name: item.result.fileName,
        data: item.result.bytes,
        method: 8,
        dosTime: 0,
        dosDate: 33,
        externalAttr: 0,
      }))
    )
    download(new Uint8Array(await blob.arrayBuffer()), 'bereinigt.zip', 'application/zip')
  })

  $('report').addEventListener('click', () => {
    const entries = state.items.map((item) => ({
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
    const text = buildReportText(entries, new Date().toLocaleString('de-DE'))
    download(new TextEncoder().encode(text), 'metadaten-protokoll.txt', 'text/plain')
  })

  $('clear').addEventListener('click', () => {
    state.items = []
    state.selected = 0
    setMessage(null, null)
    render()
  })
}

if (typeof CompressionStream === 'undefined') {
  setMessage('error', 'Dieser Browser ist zu alt (CompressionStream fehlt). Nimm Safari 16.4+, Chrome oder Firefox 113+.')
} else {
  wireDropzone()
  wireActions()
  render()
}
