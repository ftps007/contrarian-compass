/**
 * Primitives for working with an OOXML package in memory: finding parts,
 * reading and writing their XML, and removing a part together with every
 * reference to it (content-type override plus relationships).
 *
 * Shared by the property editor and the deep cleaner.
 */

import type { ZipEntry } from './zip'

export const NS = {
  cp: 'http://schemas.openxmlformats.org/package/2006/metadata/core-properties',
  dc: 'http://purl.org/dc/elements/1.1/',
  dcterms: 'http://purl.org/dc/terms/',
  dcmitype: 'http://purl.org/dc/dcmitype/',
  xsi: 'http://www.w3.org/2001/XMLSchema-instance',
  ep: 'http://schemas.openxmlformats.org/officeDocument/2006/extended-properties',
  vt: 'http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes',
  ct: 'http://schemas.openxmlformats.org/package/2006/content-types',
  rel: 'http://schemas.openxmlformats.org/package/2006/relationships',
  custom: 'http://schemas.openxmlformats.org/officeDocument/2006/custom-properties',
  w: 'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
  r: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
  sheet: 'http://schemas.openxmlformats.org/spreadsheetml/2006/main',
  p: 'http://schemas.openxmlformats.org/presentationml/2006/main',
  chart: 'http://schemas.openxmlformats.org/drawingml/2006/chart',
}

export const CONTENT_TYPES = '[Content_Types].xml'
export const ROOT_RELS = '_rels/.rels'

const decoder = new TextDecoder()
const encoder = new TextEncoder()

export function findEntry(entries: ZipEntry[], name: string): ZipEntry | undefined {
  return entries.find((e) => e.name === name)
}

export function textOf(entries: ZipEntry[], name: string): string | undefined {
  const entry = findEntry(entries, name)
  return entry ? decoder.decode(entry.data) : undefined
}

export const decodeText = (data: Uint8Array) => decoder.decode(data)
export const encodeText = (text: string) => encoder.encode(text)

export function setText(entries: ZipEntry[], name: string, xml: string): void {
  const entry = findEntry(entries, name)
  if (entry) {
    entry.data = encoder.encode(xml)
  } else {
    entries.push({ name, data: encoder.encode(xml), method: 8, dosTime: 0, dosDate: 33, externalAttr: 0 })
  }
}

export function parseXml(xml: string, label: string): Document {
  const doc = new DOMParser().parseFromString(xml, 'application/xml')
  if (doc.getElementsByTagName('parsererror').length > 0) {
    throw new Error(`XML konnte nicht gelesen werden: ${label}`)
  }
  return doc
}

export function serializeXml(doc: Document): string {
  const xml = new XMLSerializer().serializeToString(doc)
  // Chromium keeps the original declaration, Firefox drops it — normalise both.
  if (xml.startsWith('<?xml')) return xml
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n' + xml
}

export function firstByTag(doc: Document, ns: string, tag: string): Element | null {
  const list = doc.getElementsByTagNameNS(ns, tag)
  return list.length > 0 ? list[0] : null
}

/** Run a text-level edit over every part whose name matches. */
export function editParts(
  entries: ZipEntry[],
  matches: (name: string) => boolean,
  edit: (xml: string, name: string) => string
): string[] {
  const touched: string[] = []
  for (const entry of entries) {
    if (!matches(entry.name)) continue
    const xml = decoder.decode(entry.data)
    const next = edit(xml, entry.name)
    if (next !== xml) {
      entry.data = encoder.encode(next)
      touched.push(entry.name)
    }
  }
  return touched
}

/** Absolute part name a relationship target points at. */
export function resolveTarget(relsPath: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1)
  const base = relsPath.replace(/_rels\/[^/]+$/, '')
  const segments = (base + target).split('/')
  const out: string[] = []
  for (const segment of segments) {
    if (segment === '.' || segment === '') continue
    if (segment === '..') out.pop()
    else out.push(segment)
  }
  return out.join('/')
}

/** The rels part belonging to a part, e.g. word/document.xml -> word/_rels/document.xml.rels */
export function relsPathFor(partName: string): string {
  const slash = partName.lastIndexOf('/')
  const dir = slash < 0 ? '' : partName.slice(0, slash + 1)
  const file = slash < 0 ? partName : partName.slice(slash + 1)
  return `${dir}_rels/${file}.rels`
}

/**
 * Removes matching parts plus their content-type overrides and every
 * relationship pointing at them. Returns the names that were removed.
 */
export function removeParts(entries: ZipEntry[], predicate: (name: string) => boolean): string[] {
  const removed = entries.filter((e) => predicate(e.name)).map((e) => e.name)
  if (removed.length === 0) return []

  // A removed part's own rels file goes with it.
  const withRels = new Set(removed)
  for (const name of removed) {
    const rels = relsPathFor(name)
    if (findEntry(entries, rels)) withRels.add(rels)
  }

  for (const name of Array.from(withRels)) {
    const index = entries.findIndex((e) => e.name === name)
    if (index >= 0) entries.splice(index, 1)
  }

  const typesXml = textOf(entries, CONTENT_TYPES)
  if (typesXml) {
    const doc = parseXml(typesXml, CONTENT_TYPES)
    for (const override of Array.from(doc.getElementsByTagNameNS(NS.ct, 'Override'))) {
      const partName = (override.getAttribute('PartName') ?? '').replace(/^\//, '')
      if (withRels.has(partName)) override.parentNode?.removeChild(override)
    }
    setText(entries, CONTENT_TYPES, serializeXml(doc))
  }

  for (const entry of entries.filter((e) => e.name.endsWith('.rels'))) {
    const doc = parseXml(decoder.decode(entry.data), entry.name)
    let changed = false
    for (const rel of Array.from(doc.getElementsByTagNameNS(NS.rel, 'Relationship'))) {
      if (rel.getAttribute('TargetMode') === 'External') continue
      if (withRels.has(resolveTarget(entry.name, rel.getAttribute('Target') ?? ''))) {
        rel.parentNode?.removeChild(rel)
        changed = true
      }
    }
    if (changed) entry.data = encoder.encode(serializeXml(doc))
  }

  return removed
}

/**
 * Removes parts like removeParts, and additionally cleans up the references
 * that pointed at them: an element that exists only to carry the reference is
 * dropped, otherwise just the r:id/r:embed attribute goes. Without this a
 * removed part leaves a dangling id and Office offers to "repair" the file.
 */
export function removePartsAndReferences(entries: ZipEntry[], predicate: (name: string) => boolean): string[] {
  const doomed = new Set(entries.filter((e) => predicate(e.name)).map((e) => e.name))
  if (doomed.size === 0) return []

  // Collect the relationship ids about to become invalid, per owning part.
  const danglingByOwner = new Map<string, string[]>()
  for (const entry of entries.filter((e) => e.name.endsWith('.rels'))) {
    const ids: string[] = []
    for (const rel of readRelationships(entries, entry.name)) {
      if (rel.external) continue
      if (doomed.has(resolveTarget(entry.name, rel.target))) ids.push(rel.id)
    }
    if (ids.length === 0) continue
    const owner = entry.name.replace(/_rels\/([^/]+)\.rels$/, '$1')
    danglingByOwner.set(owner, ids)
  }

  const removed = removeParts(entries, predicate)

  for (const [owner, ids] of Array.from(danglingByOwner.entries())) {
    const entry = findEntry(entries, owner)
    if (!entry) continue
    let xml = decoder.decode(entry.data)
    for (const id of ids) {
      // Self-closing elements whose only purpose was the reference.
      xml = xml.replace(new RegExp(`<[^<>]*r:(?:id|embed)="${id}"[^<>]*/>`, 'g'), '')
      // Otherwise keep the element and its content, drop the attribute.
      xml = xml.replace(new RegExp(`\\sr:(?:id|embed)="${id}"`, 'g'), '')
    }
    entry.data = encoder.encode(xml)
  }

  return removed
}

/** Relationship ids in a rels part, keyed by id. */
export function readRelationships(
  entries: ZipEntry[],
  relsPath: string
): { id: string; type: string; target: string; external: boolean }[] {
  const xml = textOf(entries, relsPath)
  if (!xml) return []
  const doc = parseXml(xml, relsPath)
  return Array.from(doc.getElementsByTagNameNS(NS.rel, 'Relationship')).map((rel) => ({
    id: rel.getAttribute('Id') ?? '',
    type: rel.getAttribute('Type') ?? '',
    target: rel.getAttribute('Target') ?? '',
    external: rel.getAttribute('TargetMode') === 'External',
  }))
}

/** Sets a content-type override, replacing any existing one for that part. */
export function setContentTypeOverride(entries: ZipEntry[], partName: string, contentType: string): void {
  const xml = textOf(entries, CONTENT_TYPES)
  if (!xml) return
  const doc = parseXml(xml, CONTENT_TYPES)
  for (const override of Array.from(doc.getElementsByTagNameNS(NS.ct, 'Override'))) {
    if (override.getAttribute('PartName') === `/${partName}`) {
      override.setAttribute('ContentType', contentType)
      setText(entries, CONTENT_TYPES, serializeXml(doc))
      return
    }
  }
  const override = doc.createElementNS(NS.ct, 'Override')
  override.setAttribute('PartName', `/${partName}`)
  override.setAttribute('ContentType', contentType)
  doc.documentElement.appendChild(override)
  setText(entries, CONTENT_TYPES, serializeXml(doc))
}
