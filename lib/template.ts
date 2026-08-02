/**
 * Templates — one set of values applied to every loaded file of a format.
 *
 * The rule is the one users know from other metadata tools: a ticked field is
 * written with the value next to it, an unticked field is deleted. That fits
 * the way the rest of this code works, where an empty value means the property
 * is removed from the file rather than written as an empty string.
 */

import type { Field, FileKind, LoadedFile } from './clean'

export interface TemplateEntry {
  checked: boolean
  value: string
}

export type Template = Record<string, TemplateEntry>

export const emptyTemplate = (fields: Field[]): Template =>
  Object.fromEntries(fields.map((field) => [field.key, { checked: false, value: '' }]))

/** Prefills a template from a file, so editing starts from what is there. */
export const templateFrom = (file: LoadedFile): Template =>
  Object.fromEntries(
    file.fields.map((field) => {
      const value = file.values[field.key] ?? ''
      return [field.key, { checked: value !== '', value }]
    })
  )

/** The values a file should get when the template is applied to it. */
export function applyTemplate(fields: Field[], template: Template): Record<string, string> {
  const values: Record<string, string> = {}
  for (const field of fields) {
    const entry = template[field.key]
    values[field.key] = entry?.checked ? entry.value : ''
  }
  return values
}

/** How many fields the template writes, and how many it deletes. */
export function templateSummary(fields: Field[], template: Template): { written: number; deleted: number } {
  let written = 0
  let deleted = 0
  for (const field of fields) {
    if (template[field.key]?.checked) written++
    else deleted++
  }
  return { written, deleted }
}

export const KIND_LABELS: Record<FileKind, string> = {
  ooxml: 'Word, Excel, PowerPoint',
  odf: 'OpenDocument',
  pdf: 'PDF',
  ole2: 'Alte Binärformate (.doc/.xls/.ppt)',
  rtf: 'RTF',
  image: 'Bilder',
  media: 'Audio und Video',
  unbekannt: 'Unbekannt',
}
