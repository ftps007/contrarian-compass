/**
 * Personal data inside the document body — Word, Excel, PowerPoint,
 * OpenDocument and RTF.
 *
 * The difficulty is not the pattern matching (lib/pii.ts) but the fact that a
 * single e-mail address is routinely split over several runs: Word starts a
 * new `<w:r>` whenever spell-checking, formatting or a saved session boundary
 * says so. So the text of one paragraph is first joined into a plain string,
 * matched as a whole, and the replacement is then written back across the
 * run boundaries: the first run that a match touches gets the placeholder,
 * the others lose their share of the match. Formatting survives, the
 * document stays valid, and "max@" + "firma.de" is found.
 *
 * RTF has no DOM; its text is extracted with a byte map back to the source,
 * and the edits are applied to the raw string in reverse order.
 */

import type { ZipEntry } from './zip'
import { NS, decodeText, parseXml, serializeXml, setText } from './ooxmlPackage'
import { ODF_NS } from './odf'
import {
  Pseudonymizer,
  addCounts,
  countByCategory,
  findPii,
  type PiiCategory,
  type PiiMatch,
  type PiiOptions,
} from './pii'

// ---------------------------------------------------------------------------
// Segments: the text of one paragraph, piece by piece
// ---------------------------------------------------------------------------

interface Segment {
  text: string
  /** Absent for separators (ODF <text:s/>, RTF \tab) that cannot carry a replacement. */
  write?: (text: string) => void
}

type Group = Segment[]

const joinGroup = (group: Group): string => group.map((s) => s.text).join('')

/**
 * Writes the matches back into the segments of one group. Each segment ends
 * up with: its text outside any match, plus the replacement for every match
 * that *starts* inside it. A match that began in an earlier segment removes
 * its remainder here without adding anything.
 */
function writeGroup(group: Group, text: string, matches: PiiMatch[], pseudonymizer: Pseudonymizer): void {
  const emitted = matches.map(() => false)
  let offset = 0
  let first = 0 // first match that may still reach into the current segment
  for (const segment of group) {
    const start = offset
    const end = offset + segment.text.length
    offset = end
    while (first < matches.length && matches[first].end <= start) first++
    if (!segment.write) continue

    let out = ''
    let cursor = start
    for (let i = first; i < matches.length && matches[i].start < end; i++) {
      const match = matches[i]
      if (!emitted[i]) {
        // The placeholder goes into the first writable segment the match touches —
        // normally the one it starts in, unless that was a separator.
        out += text.slice(cursor, Math.max(match.start, start)) + pseudonymizer.replacementFor(match)
        emitted[i] = true
      }
      cursor = Math.min(end, match.end)
    }
    out += text.slice(cursor, end)
    if (out !== segment.text) segment.write(out)
  }
}

/** A separator-only group has nothing to match against. */
const hasRealText = (group: Group) => group.some((s) => s.write && s.text.trim() !== '')

function scanGroups(groups: Group[], options: PiiOptions): PiiMatch[] {
  const found: PiiMatch[] = []
  for (const group of groups) {
    if (!hasRealText(group)) continue
    found.push(...findPii(joinGroup(group), options))
  }
  return found
}

/** Replaces in place and returns what was replaced. */
function replaceGroups(groups: Group[], options: PiiOptions, pseudonymizer: Pseudonymizer): PiiMatch[] {
  const replaced: PiiMatch[] = []
  for (const group of groups) {
    if (!hasRealText(group)) continue
    const text = joinGroup(group)
    const matches = findPii(text, options)
    if (matches.length === 0) continue
    writeGroup(group, text, matches, pseudonymizer)
    replaced.push(...matches)
  }
  return replaced
}

// ---------------------------------------------------------------------------
// OOXML
// ---------------------------------------------------------------------------

const XML_NS = 'http://www.w3.org/XML/1998/namespace'

const NS_A = 'http://schemas.openxmlformats.org/drawingml/2006/main'

/** Cheap pre-check so that styles, themes and relationships are never parsed. */
const OOXML_TEXT_MARKERS = ['<w:t>', '<w:t ', '<w:delText', '<w:instrText', '<a:t>', '<a:t ', '<t>', '<t ', '<p:text', ' descr="', ' title="']

function isCandidatePart(name: string, xml: string): boolean {
  if (!name.endsWith('.xml') || name.startsWith('docProps/') || name.endsWith('.rels') || name === '[Content_Types].xml') return false
  if (/\/(styles|fontTable|numbering|settings|webSettings|calcChain|theme\d*|presProps|viewProps|tableStyles)\.xml$/.test(name)) return false
  if (/\/theme\//.test(name)) return false
  return OOXML_TEXT_MARKERS.some((marker) => xml.includes(marker))
}

function nearestAncestor(element: Element, ns: string, names: string[]): Element | null {
  let node: Node | null = element.parentNode
  while (node && node.nodeType === 1) {
    const el = node as Element
    if (el.namespaceURI === ns && names.includes(el.localName)) return el
    node = node.parentNode
  }
  return null
}

function elementSegment(element: Element, preserveSpace: boolean): Segment {
  return {
    text: element.textContent ?? '',
    write: (text) => {
      element.textContent = text
      if (preserveSpace && /^\s|\s$/.test(text)) element.setAttributeNS(XML_NS, 'xml:space', 'preserve')
    },
  }
}

function attributeSegment(element: Element, name: string): Segment {
  return { text: element.getAttribute(name) ?? '', write: (text) => element.setAttribute(name, text) }
}

/** Groups text elements by their nearest paragraph-like ancestor, in document order. */
function groupBy(elements: Element[], anchorOf: (element: Element) => Element, preserveSpace: boolean): Group[] {
  const groups = new Map<Element, Group>()
  for (const element of elements) {
    const anchor = anchorOf(element)
    let group = groups.get(anchor)
    if (!group) groups.set(anchor, (group = []))
    group.push(elementSegment(element, preserveSpace))
  }
  return Array.from(groups.values())
}

const byNS = (doc: Document, ns: string, tag: string): Element[] => Array.from(doc.getElementsByTagNameNS(ns, tag))

function ooxmlGroups(doc: Document): Group[] {
  const groups: Group[] = []

  // Word: runs of a paragraph, including deleted text of tracked changes.
  const wordText = [...byNS(doc, NS.w, 't'), ...byNS(doc, NS.w, 'delText')]
  if (wordText.length > 0) {
    wordText.sort(documentOrder)
    groups.push(...groupBy(wordText, (el) => nearestAncestor(el, NS.w, ['p']) ?? el, true))
  }
  // Field codes (HYPERLINK "mailto:…") stand alone.
  for (const field of byNS(doc, NS.w, 'instrText')) groups.push([elementSegment(field, true)])

  // DrawingML: text boxes, shapes, slides, charts.
  const drawingText = byNS(doc, NS_A, 't')
  if (drawingText.length > 0) groups.push(...groupBy(drawingText, (el) => nearestAncestor(el, NS_A, ['p']) ?? el, false))

  // SpreadsheetML: shared strings, inline strings, cell comments.
  const sheetText = byNS(doc, NS.sheet, 't').filter((el) => !nearestAncestor(el, NS.sheet, ['rPh']))
  if (sheetText.length > 0) groups.push(...groupBy(sheetText, (el) => nearestAncestor(el, NS.sheet, ['si', 'is', 'text']) ?? el, true))

  // Legacy PowerPoint comments.
  for (const comment of byNS(doc, NS.p, 'text')) groups.push([elementSegment(comment, false)])

  // Alternative text of pictures and shapes — the element lives in a different
  // namespace per host application (wp:docPr, pic:/p:/xdr:cNvPr).
  for (const element of [...byNS(doc, '*', 'docPr'), ...byNS(doc, '*', 'cNvPr')]) {
    for (const name of ['descr', 'title']) {
      if (element.hasAttribute(name)) groups.push([attributeSegment(element, name)])
    }
  }

  return groups
}

function documentOrder(a: Element, b: Element): number {
  if (a === b) return 0
  if (typeof a.compareDocumentPosition === 'function') {
    const position = a.compareDocumentPosition(b)
    if (position & 4) return -1 // b follows a
    if (position & 2) return 1
    return 0
  }
  return 0
}

export function scanOoxmlPii(entries: ZipEntry[], options: PiiOptions): PiiMatch[] {
  const found: PiiMatch[] = []
  for (const entry of entries) {
    const xml = decodeText(entry.data)
    if (!isCandidatePart(entry.name, xml)) continue
    try {
      found.push(...scanGroups(ooxmlGroups(parseXml(xml, entry.name)), options))
    } catch {
      // A part that does not parse is not ours to judge; the deep scan reports damage.
    }
  }
  return found
}

export interface ContentResult {
  replaced: Partial<Record<PiiCategory, number>>
  parts: string[]
}

export function applyOoxmlPii(entries: ZipEntry[], options: PiiOptions, pseudonymizer: Pseudonymizer): ContentResult {
  const result: ContentResult = { replaced: {}, parts: [] }
  for (const entry of entries) {
    const xml = decodeText(entry.data)
    if (!isCandidatePart(entry.name, xml)) continue
    const doc = parseXml(xml, entry.name)
    const replaced = replaceGroups(ooxmlGroups(doc), options, pseudonymizer)
    if (replaced.length === 0) continue
    setText(entries, entry.name, serializeXml(doc))
    addCounts(result.replaced, countByCategory(replaced))
    result.parts.push(entry.name)
  }

  // Hyperlink targets live in the relationship files, not in the text.
  for (const entry of entries) {
    if (!entry.name.endsWith('.rels')) continue
    const xml = decodeText(entry.data)
    if (!xml.includes('mailto:')) continue
    const next = xml.replace(/Target="mailto:([^"?]+)([^"]*)"/g, (whole, address: string, rest: string) => {
      const decoded = address.replace(/&amp;/g, '&')
      const matches = findPii(decoded, options)
      if (matches.length === 0) return whole
      addCounts(result.replaced, countByCategory(matches))
      const token = pseudonymizer.replacementFor(matches[0])
      const slug = token.replace(/[^\w]+/g, '-').replace(/^-|-$/g, '').toLowerCase()
      return slug ? `Target="mailto:${slug}@beispiel.invalid${rest}"` : `Target="mailto:${rest}"`
    })
    if (next !== xml) {
      setText(entries, entry.name, next)
      result.parts.push(entry.name)
    }
  }
  return result
}

// ---------------------------------------------------------------------------
// OpenDocument
// ---------------------------------------------------------------------------

const ODF_TEXT_PARTS = ['content.xml', 'styles.xml']

function odfGroups(doc: Document): Group[] {
  const groups: Group[] = []
  const paragraphs = [...byNS(doc, ODF_NS.text, 'p'), ...byNS(doc, ODF_NS.text, 'h')]
  for (const paragraph of paragraphs) {
    const group: Group = []
    const walk = (node: Node): void => {
      for (let child = node.firstChild; child; child = child.nextSibling) {
        if (child.nodeType === 3) {
          const textNode = child as Text
          group.push({ text: textNode.data, write: (text) => (textNode.data = text) })
          continue
        }
        if (child.nodeType !== 1) continue
        const el = child as Element
        if (el.namespaceURI === ODF_NS.text) {
          if (el.localName === 'p' || el.localName === 'h') continue // its own paragraph
          if (el.localName === 's') {
            group.push({ text: ' '.repeat(Math.max(1, Number(el.getAttributeNS(ODF_NS.text, 'c') || 1))) })
            continue
          }
          if (el.localName === 'tab') {
            group.push({ text: '\t' })
            continue
          }
          if (el.localName === 'line-break') {
            group.push({ text: '\n' })
            continue
          }
          if (el.localName === 'note' || el.localName === 'tracked-changes') continue // own paragraphs inside
        }
        if (el.namespaceURI === ODF_NS.office || el.namespaceURI === ODF_NS.dc || el.namespaceURI === ODF_NS.meta) continue
        walk(el)
      }
    }
    walk(paragraph)
    if (group.length > 0) groups.push(group)
  }
  return groups
}

export function scanOdfPii(entries: ZipEntry[], options: PiiOptions): PiiMatch[] {
  const found: PiiMatch[] = []
  for (const entry of entries) {
    if (!ODF_TEXT_PARTS.includes(entry.name)) continue
    try {
      found.push(...scanGroups(odfGroups(parseXml(decodeText(entry.data), entry.name)), options))
    } catch {
      // reported elsewhere
    }
  }
  return found
}

export function applyOdfPii(entries: ZipEntry[], options: PiiOptions, pseudonymizer: Pseudonymizer): ContentResult {
  const result: ContentResult = { replaced: {}, parts: [] }
  for (const entry of entries) {
    if (!ODF_TEXT_PARTS.includes(entry.name)) continue
    const doc = parseXml(decodeText(entry.data), entry.name)
    const replaced = replaceGroups(odfGroups(doc), options, pseudonymizer)
    if (replaced.length === 0) continue
    setText(entries, entry.name, serializeXml(doc))
    addCounts(result.replaced, countByCategory(replaced))
    result.parts.push(entry.name)
  }
  return result
}

// ---------------------------------------------------------------------------
// RTF
// ---------------------------------------------------------------------------

interface RtfChar {
  ch: string
  /** Source range; -1 for characters produced by control words (\tab, \par). */
  start: number
  end: number
}

/** Destinations whose content is not document text. */
const RTF_SKIP = new Set([
  'fonttbl', 'colortbl', 'stylesheet', 'info', 'pict', 'object', 'objdata', 'listtable', 'listoverridetable',
  'revtbl', 'rsidtbl', 'themedata', 'colorschememapping', 'datastore', 'latentstyles', 'xmlnstbl', 'mmathPr',
  'generator', 'xe', 'tc', 'sp', 'shpinst', 'nonshppict', 'bkmkstart', 'bkmkend', 'template', 'operator',
  'filetbl', 'listpicture', 'protusertbl', 'pgdsctbl', 'ud', 'atnauthor', 'atnid', 'atndate', 'atnref', 'atnparent',
  'factoidname', 'wgrffmtfilter', 'docvar', 'ftnsep', 'ftnsepc', 'aftnsep', 'aftnsepc', 'pntext', 'pntxta', 'pntxtb',
])
/** `{\*\…}` destinations that *are* document text and must not be ignored. */
const RTF_STAR_KEEP = new Set(['annotation', 'fldinst', 'shptxt'])

const RTF_SPECIALS: Record<string, string> = {
  par: '\n',
  line: '\n',
  sect: '\n',
  page: '\n',
  row: '\n',
  cell: '\t',
  nestcell: '\t',
  nestrow: '\n',
  tab: '\t',
  emdash: '—',
  endash: '–',
  lquote: '‘',
  rquote: '’',
  ldblquote: '“',
  rdblquote: '”',
  bullet: '•',
  emspace: ' ',
  enspace: ' ',
  qmspace: ' ',
}

/** Document text of an RTF file with, for every character, where it came from. */
export function rtfChars(source: string): RtfChar[] {
  const chars: RtfChar[] = []
  // Group stack: whether the group is skipped, and its \uc setting.
  const stack: { skip: boolean; uc: number }[] = [{ skip: false, uc: 1 }]
  const top = () => stack[stack.length - 1]
  let i = 0
  const n = source.length

  const skipFallback = (count: number): void => {
    // After \uN come `uc` fallback characters, each either one char or one \'hh.
    for (let k = 0; k < count && i < n; k++) {
      if (source[i] === '\\' && source[i + 1] === "'") i += 4
      else if (source[i] === '{' || source[i] === '}' || source[i] === '\\') return
      else i++
    }
  }

  while (i < n) {
    const c = source[i]
    if (c === '{') {
      const inherited = top()
      stack.push({ skip: inherited.skip, uc: inherited.uc })
      i++
      // Destination?
      const star = source.startsWith('\\*\\', i)
      const match = /^\\(?:\*\\)?([a-zA-Z]+)/.exec(source.slice(i, i + 40))
      if (match) {
        const word = match[1]
        if (star) {
          if (!RTF_STAR_KEEP.has(word)) top().skip = true
        } else if (RTF_SKIP.has(word)) {
          top().skip = true
        }
      }
      continue
    }
    if (c === '}') {
      if (stack.length > 1) stack.pop()
      i++
      continue
    }
    if (c === '\\') {
      const next = source[i + 1]
      if (next === undefined) break
      if (next === "'") {
        const code = parseInt(source.substr(i + 2, 2), 16)
        if (!top().skip && !Number.isNaN(code)) chars.push({ ch: String.fromCharCode(code), start: i, end: i + 4 })
        i += 4
        continue
      }
      if (next === '\\' || next === '{' || next === '}') {
        if (!top().skip) chars.push({ ch: next, start: i, end: i + 2 })
        i += 2
        continue
      }
      if (next === '~') {
        if (!top().skip) chars.push({ ch: ' ', start: -1, end: -1 })
        i += 2
        continue
      }
      if (next === '-' || next === '_' || next === ':' || next === '|' || next === '*') {
        i += 2
        continue
      }
      if (next === '\n' || next === '\r') {
        if (!top().skip) chars.push({ ch: '\n', start: -1, end: -1 })
        i += 2
        continue
      }
      const control = /^\\([a-zA-Z]+)(-?\d+)?( ?)/.exec(source.slice(i, i + 40))
      if (!control) {
        i += 2
        continue
      }
      const [whole, word, param] = control
      i += whole.length
      if (word === 'bin') {
        i += Math.max(0, Number(param) || 0)
        continue
      }
      if (word === 'uc') {
        top().uc = Math.max(0, Number(param) || 0)
        continue
      }
      if (word === 'u' && param !== undefined) {
        let code = Number(param)
        if (code < 0) code += 65536
        const start = i - whole.length
        skipFallback(top().uc) // the fallback belongs to the character and goes with it
        if (!top().skip) chars.push({ ch: String.fromCharCode(code), start, end: i })
        continue
      }
      if (!top().skip && RTF_SPECIALS[word] !== undefined) chars.push({ ch: RTF_SPECIALS[word], start: -1, end: -1 })
      continue
    }
    if (c === '\r' || c === '\n') {
      i++
      continue
    }
    if (!top().skip) chars.push({ ch: c, start: i, end: i + 1 })
    i++
  }
  return chars
}

/** Readable text of an RTF document (for scanning). */
export const rtfPlainText = (source: string): string => rtfChars(source).map((c) => c.ch).join('')

export function scanRtfPii(source: string, options: PiiOptions): PiiMatch[] {
  return findPii(rtfPlainText(source), options)
}

function escapeRtf(value: string): string {
  return value.replace(/[\\{}]/g, (char) => `\\${char}`).replace(/[^\x20-\x7e]/g, (char) => `\\u${char.charCodeAt(0)}?`)
}

export function applyRtfPii(
  source: string,
  options: PiiOptions,
  pseudonymizer: Pseudonymizer
): { text: string; replaced: Partial<Record<PiiCategory, number>> } {
  const chars = rtfChars(source)
  const plain = chars.map((c) => c.ch).join('')
  const matches = findPii(plain, options)
  if (matches.length === 0) return { text: source, replaced: {} }

  const edits: { pos: number; del: number; insert: string }[] = []
  for (const match of matches) {
    const replacement = escapeRtf(pseudonymizer.replacementFor(match))
    let inserted = false
    for (let k = match.start; k < match.end; k++) {
      const char = chars[k]
      if (char.start < 0) continue // produced by a control word — leave it
      edits.push({ pos: char.start, del: char.end - char.start, insert: inserted ? '' : replacement })
      inserted = true
    }
  }
  edits.sort((a, b) => b.pos - a.pos)
  let out = source
  for (const edit of edits) out = out.slice(0, edit.pos) + edit.insert + out.slice(edit.pos + edit.del)
  return { text: out, replaced: countByCategory(matches) }
}
