/**
 * RTF — a text format, but its metadata sits in nested brace groups rather
 * than in XML: `{\info{\author …}{\creatim…}}`, plus a generator stamp, a
 * revision table listing every author, and annotation authors.
 *
 * Everything here works on the raw text and keeps byte offsets irrelevant, so
 * the document body is never touched.
 */

export interface RtfField {
  key: string
  label: string
  control: string
  kind: 'text' | 'number'
}

export const RTF_FIELDS: RtfField[] = [
  { key: 'title', label: 'Titel', control: 'title', kind: 'text' },
  { key: 'subject', label: 'Thema', control: 'subject', kind: 'text' },
  { key: 'author', label: 'Autor', control: 'author', kind: 'text' },
  { key: 'operator', label: 'Zuletzt geändert von', control: 'operator', kind: 'text' },
  { key: 'keywords', label: 'Stichwörter', control: 'keywords', kind: 'text' },
  { key: 'comment', label: 'Kommentare', control: 'doccomm', kind: 'text' },
  { key: 'company', label: 'Firma', control: 'company', kind: 'text' },
  { key: 'category', label: 'Kategorie', control: 'category', kind: 'text' },
  { key: 'manager', label: 'Vorgesetzter', control: 'manager', kind: 'text' },
  { key: 'version', label: 'Version', control: 'vern', kind: 'number' },
  { key: 'editingTime', label: 'Bearbeitungszeit (Min.)', control: 'edmins', kind: 'number' },
  { key: 'revisions', label: 'Revisionsnummer', control: 'nofrev', kind: 'number' },
]

export const isRtf = (text: string) => text.trimStart().startsWith('{\\rtf')

/** Index just past the group that starts at `start` (which must be a brace). */
function groupEnd(text: string, start: number): number {
  let depth = 0
  for (let i = start; i < text.length; i++) {
    const char = text[i]
    if (char === '\\') {
      i++ // escaped character, skip it
      continue
    }
    if (char === '{') depth++
    else if (char === '}') {
      depth--
      if (depth === 0) return i + 1
    }
  }
  return text.length
}

function findGroup(text: string, control: string): { start: number; end: number } | null {
  const marker = `{\\${control}`
  const start = text.indexOf(marker)
  if (start < 0) return null
  const next = text[start + marker.length]
  // Guard against matching {\infobox by requiring a delimiter.
  if (next && /[a-z0-9]/i.test(next)) return null
  return { start, end: groupEnd(text, start) }
}

export function readRtfFields(text: string): Record<string, string> {
  const values: Record<string, string> = {}
  const info = findGroup(text, 'info')
  if (!info) return values
  const block = text.slice(info.start, info.end)

  for (const field of RTF_FIELDS) {
    if (field.kind === 'number') {
      const match = new RegExp(`\\\\${field.control}(-?\\d+)`).exec(block)
      values[field.key] = match ? match[1] : ''
      continue
    }
    const group = findGroup(block, field.control)
    if (!group) {
      values[field.key] = ''
      continue
    }
    const inner = block
      .slice(group.start, group.end)
      .replace(new RegExp(`^\\{\\\\${field.control}\\s?`), '')
      .replace(/\}$/, '')
    values[field.key] = decodeRtfText(inner)
  }
  return values
}

/**
 * Turns the RTF representation of a value back into plain text: escaped
 * braces and backslashes become literal, \'hh and \uN become their character,
 * and remaining control words are dropped.
 */
function decodeRtfText(input: string): string {
  let out = ''
  let i = 0
  while (i < input.length) {
    const char = input[i]
    if (char !== '\\') {
      out += char
      i++
      continue
    }
    const next = input[i + 1]
    if (next === '\\' || next === '{' || next === '}') {
      out += next
      i += 2
      continue
    }
    if (next === "'") {
      out += String.fromCharCode(parseInt(input.substr(i + 2, 2), 16))
      i += 4
      continue
    }
    const unicode = /^\\u(-?\d+)\s?\??/.exec(input.slice(i))
    if (unicode) {
      const code = Number(unicode[1])
      out += String.fromCharCode(code < 0 ? code + 65536 : code)
      i += unicode[0].length
      continue
    }
    const control = /^\\([a-z]+)(-?\d+)?\s?/i.exec(input.slice(i))
    if (control) {
      i += control[0].length
      continue
    }
    i += 2 // unknown escape
  }
  return out.trim()
}

/** Escape for RTF: braces and backslashes, and anything outside ASCII. */
function escapeRtf(value: string): string {
  return value
    .replace(/[\\{}]/g, (char) => `\\${char}`)
    .replace(/[^\x20-\x7e]/g, (char) => `\\u${char.charCodeAt(0)}?`)
}

export function writeRtfFields(text: string, values: Record<string, string>): string {
  const parts: string[] = []
  for (const field of RTF_FIELDS) {
    const value = (values[field.key] ?? '').trim()
    if (value === '') continue
    if (field.kind === 'number') {
      if (/^-?\d+$/.test(value)) parts.push(`\\${field.control}${value}`)
    } else {
      parts.push(`{\\${field.control} ${escapeRtf(value)}}`)
    }
  }

  const info = parts.length > 0 ? `{\\info${parts.join('')}}` : ''
  const existing = findGroup(text, 'info')
  if (existing) return text.slice(0, existing.start) + info + text.slice(existing.end)
  if (!info) return text

  // No info group yet — put it right after the header controls.
  const insertAt = text.indexOf('{\\fonttbl') >= 0 ? text.indexOf('{\\fonttbl') : text.indexOf('}') + 1
  return text.slice(0, insertAt) + info + text.slice(insertAt)
}

export interface RtfFinding {
  id: string
  label: string
  detail: string
  severity: 'hoch' | 'mittel' | 'niedrig'
}

export function scanRtf(text: string): RtfFinding[] {
  const findings: RtfFinding[] = []

  const revisionAuthors = collectRevisionAuthors(text)
  if (revisionAuthors.length > 0) {
    findings.push({
      id: 'authors',
      label: `${revisionAuthors.length} Name(n) in der Revisionstabelle`,
      detail: `Gefunden: ${revisionAuthors.join(', ')}. RTF führt jede Person, die je im Dokument gespeichert hat.`,
      severity: 'hoch',
    })
  }
  if (/\\\*\\generator/.test(text)) {
    findings.push({
      id: 'generator',
      label: 'Erzeugerkennung',
      detail: 'Nennt Programm und Version, mit denen die Datei geschrieben wurde.',
      severity: 'niedrig',
    })
  }
  if (/\\\*\\atnauthor|\\annotation/.test(text)) {
    findings.push({
      id: 'annotations',
      label: 'Kommentare mit Autorennamen',
      detail: 'RTF speichert Kommentarautoren im Klartext neben dem Text.',
      severity: 'hoch',
    })
  }
  if (/\\revised|\\deleted/.test(text)) {
    findings.push({
      id: 'trackedChanges',
      label: 'Nachverfolgte Änderungen',
      detail: 'Gelöschter Text bleibt als \\deleted im Dokument stehen und ist lesbar.',
      severity: 'hoch',
    })
  }
  return findings
}

function collectRevisionAuthors(text: string): string[] {
  const table = findGroup(text, '*\\revtbl')
  const authors = new Set<string>()
  if (table) {
    const block = text.slice(table.start, table.end)
    for (const match of Array.from(block.matchAll(/\{([^{}\\;]+);?\}/g))) {
      const name = match[1].trim()
      if (name && name !== 'Unknown') authors.add(name)
    }
  }
  for (const match of Array.from(text.matchAll(/\\\*\\atnauthor\s+([^\\{}]+)/g))) {
    const name = match[1].trim()
    if (name) authors.add(name)
  }
  return Array.from(authors)
}

export interface RtfCleanOptions {
  removeGenerator: boolean
  removeRevisionTable: boolean
  anonymizeAuthors: boolean
}

export const DEFAULT_RTF_CLEAN: RtfCleanOptions = {
  removeGenerator: true,
  removeRevisionTable: true,
  anonymizeAuthors: false,
}

export function cleanRtf(text: string, options: RtfCleanOptions): { text: string; steps: string[] } {
  let out = text
  const steps: string[] = []

  if (options.removeGenerator) {
    const generator = findGroup(out, '*\\generator')
    if (generator) {
      out = out.slice(0, generator.start) + out.slice(generator.end)
      steps.push('Erzeugerkennung entfernt')
    }
  }

  if (options.removeRevisionTable) {
    const table = findGroup(out, '*\\revtbl')
    if (table) {
      out = out.slice(0, table.start) + out.slice(table.end)
      steps.push('Revisionstabelle entfernt')
    }
  }

  if (options.anonymizeAuthors) {
    const authors = collectRevisionAuthors(out).filter((name) => !/^Autor \d+$/.test(name))
    if (authors.length > 0) {
      authors.forEach((name, index) => {
        const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        out = out.replace(new RegExp(`(\\\\\\*\\\\atnauthor\\s+)${escaped}`, 'g'), `$1Autor ${index + 1}`)
      })
      steps.push(`${authors.length} Name(n) in Kommentaren ersetzt`)
    }
  }

  return { text: out, steps }
}
