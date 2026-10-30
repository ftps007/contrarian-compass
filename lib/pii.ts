/**
 * Personal data in document text.
 *
 * Detection is pattern-based and deliberately conservative: an IBAN has to
 * pass its checksum, a card number Luhn, a tax id its check digit. Names are
 * the hard case — there is no reliable grammar for them — so they come from
 * three dependable sources: salutations and titles ("Frau Dr. Erika
 * Musterfrau"), signature blocks, and names already known from the document's
 * own metadata or a list the user supplies.
 *
 * Replacement is pseudonymisation in the sense of Art. 4 No. 5 GDPR: the same
 * value gets the same placeholder throughout, so a document stays readable and
 * internally consistent while no longer naming anyone. The mapping is returned
 * so it can be kept with the report — it is the "additional information" the
 * article speaks of and must be stored separately from the document.
 */

export type PiiCategory =
  | 'email'
  | 'phone'
  | 'iban'
  | 'card'
  | 'taxId'
  | 'socialSecurity'
  | 'ip'
  | 'birthDate'
  | 'address'
  | 'person'

export const PII_LABELS: Record<PiiCategory, string> = {
  email: 'E-Mail-Adresse',
  phone: 'Telefonnummer',
  iban: 'IBAN',
  card: 'Kartennummer',
  taxId: 'Steuer-Identifikationsnummer',
  socialSecurity: 'Sozialversicherungsnummer',
  ip: 'IP-Adresse',
  birthDate: 'Geburtsdatum',
  address: 'Postanschrift',
  person: 'Personenname',
}

const PLACEHOLDER: Record<PiiCategory, string> = {
  email: 'E-Mail',
  phone: 'Telefon',
  iban: 'IBAN',
  card: 'Karte',
  taxId: 'Steuer-ID',
  socialSecurity: 'SV-Nummer',
  ip: 'IP',
  birthDate: 'Geburtsdatum',
  address: 'Anschrift',
  person: 'Person',
}

export interface PiiMatch {
  category: PiiCategory
  start: number
  end: number
  value: string
}

export interface PiiOptions {
  categories: Record<PiiCategory, boolean>
  /** Names to treat as personal data wherever they appear. */
  knownNames: string[]
  /** Replace with placeholders ("pseudonymisieren") or delete outright. */
  mode: 'pseudonymisieren' | 'entfernen'
}

export const PII_CATEGORIES: PiiCategory[] = ['email', 'phone', 'iban', 'card', 'taxId', 'socialSecurity', 'ip', 'birthDate', 'address', 'person']

export const DEFAULT_PII_OPTIONS: PiiOptions = {
  categories: {
    email: true,
    phone: true,
    iban: true,
    card: true,
    taxId: true,
    socialSecurity: true,
    ip: true,
    birthDate: true,
    address: true,
    person: true,
  },
  knownNames: [],
  mode: 'pseudonymisieren',
}

/**
 * The switches as the options panel and profiles see them: flat booleans, so
 * the generic checkbox rendering works, plus the name list.
 */
export interface PiiCleanOptions {
  /** Master switch — nothing in the content is touched while this is off. */
  enabled: boolean
  /** Delete instead of putting a numbered placeholder in. */
  remove: boolean
  email: boolean
  phone: boolean
  iban: boolean
  card: boolean
  taxId: boolean
  socialSecurity: boolean
  ip: boolean
  birthDate: boolean
  address: boolean
  person: boolean
  /** Names the user supplies, replaced wherever they appear. */
  knownNames: string[]
}

export const DEFAULT_PII_CLEAN: PiiCleanOptions = {
  enabled: false,
  remove: false,
  email: true,
  phone: true,
  iban: true,
  card: true,
  taxId: true,
  socialSecurity: true,
  ip: true,
  birthDate: true,
  address: true,
  person: true,
  knownNames: [],
}

/** Engine options from the panel switches plus names learnt from the file itself. */
export function piiOptionsFrom(clean: PiiCleanOptions, extraNames: string[] = []): PiiOptions {
  const names = new Set<string>()
  for (const name of [...clean.knownNames, ...extraNames]) {
    const trimmed = name.trim()
    // Skip what is too short to be safe, what is already a placeholder, and what has no letters.
    if (trimmed.length >= 3 && !/^Autor \d+$/.test(trimmed) && !/^\[.*\]$/.test(trimmed) && /[A-Za-zÄÖÜäöüß]/.test(trimmed)) names.add(trimmed)
  }
  return {
    categories: Object.fromEntries(PII_CATEGORIES.map((category) => [category, Boolean(clean[category])])) as Record<PiiCategory, boolean>,
    knownNames: Array.from(names),
    mode: clean.remove ? 'entfernen' : 'pseudonymisieren',
  }
}

/** Turns a free-text list ("Max Mustermann, Erika Musterfrau" or one per line) into names. */
export const parseNameList = (text: string): string[] =>
  text
    .split(/[\n,;]+/)
    .map((name) => name.trim())
    .filter((name) => name.length > 0)

// ---------------------------------------------------------------------------
// Validators — they keep number-heavy documents from lighting up everywhere
// ---------------------------------------------------------------------------

/** ISO 7064 mod 97-10, as used by IBAN. */
export function isValidIban(candidate: string): boolean {
  const iban = candidate.replace(/\s+/g, '').toUpperCase()
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(iban)) return false
  const rearranged = iban.slice(4) + iban.slice(0, 4)
  let remainder = 0
  for (const char of rearranged) {
    const digits = /[A-Z]/.test(char) ? String(char.charCodeAt(0) - 55) : char
    for (const d of digits) remainder = (remainder * 10 + Number(d)) % 97
  }
  return remainder === 1
}

export function passesLuhn(candidate: string): boolean {
  const digits = candidate.replace(/[\s-]/g, '')
  if (!/^\d{13,19}$/.test(digits)) return false
  let sum = 0
  let double = false
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = Number(digits[i])
    if (double) {
      d *= 2
      if (d > 9) d -= 9
    }
    sum += d
    double = !double
  }
  return sum % 10 === 0
}

/** German Steuer-ID: 11 digits, first not 0, one digit repeated 2–3 times, check digit per the official scheme. */
export function isValidGermanTaxId(candidate: string): boolean {
  const id = candidate.replace(/[\s/]/g, '')
  if (!/^[1-9]\d{10}$/.test(id)) return false
  const counts = new Map<string, number>()
  for (const d of id.slice(0, 10)) counts.set(d, (counts.get(d) ?? 0) + 1)
  const repeated = Array.from(counts.values()).filter((n) => n > 1)
  if (repeated.length !== 1 || repeated[0] > 3) return false
  let product = 10
  for (const d of id.slice(0, 10)) {
    let sum = (Number(d) + product) % 10
    if (sum === 0) sum = 10
    product = (sum * 2) % 11
  }
  let check = 11 - product
  if (check === 10) check = 0
  return check === Number(id[10])
}

/** German Sozialversicherungsnummer: 2 digits, 6-digit birth date, letter, 2 digits, check digit. */
export function isValidGermanSocialSecurity(candidate: string): boolean {
  const number = candidate.replace(/\s+/g, '').toUpperCase()
  if (!/^\d{8}[A-Z]\d{3}$/.test(number)) return false
  const letterValue = String(number.charCodeAt(8) - 64).padStart(2, '0')
  const digits = number.slice(0, 8) + letterValue + number.slice(9, 11)
  const weights = [2, 1, 2, 5, 7, 1, 2, 1, 2, 1, 2, 1]
  let sum = 0
  for (let i = 0; i < 12; i++) {
    const product = Number(digits[i]) * weights[i]
    sum += product >= 10 ? Math.floor(product / 10) + (product % 10) : product
  }
  return sum % 10 === Number(number[11])
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g

// International or national formats with at least 7 digits, allowing the
// usual separators. Requires a leading + or 0 so that plain numbers (prices,
// quantities, years) are not swept up.
const PHONE = /(?:(?<![\w+])\+\d{1,3}[\s./-]?|(?<!\d)0)\(?\d{1,5}\)?(?:[\s./-]?\d{2,5}){2,5}(?!\d)/g

const IBAN = /\b[A-Z]{2}\d{2}(?:[\s]?[A-Z0-9]{4}){2,7}(?:[\s]?[A-Z0-9]{1,4})?\b/g
const CARD = /\b(?:\d[ -]?){13,19}\b/g
const TAX_ID = /\b\d{2}[\s/]?\d{3}[\s/]?\d{3}[\s/]?\d{3}\b|\b\d{11}\b/g
const SOCIAL = /\b\d{8}[A-Za-z]\d{3}\b|\b\d{2}\s?\d{6}\s?[A-Za-z]\s?\d{3}\b/g
const IPV4 = /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g
const IPV6 = /\b(?:[0-9a-fA-F]{1,4}:){2,7}[0-9a-fA-F]{1,4}\b/g

// A date next to a birth cue, in either order.
const BIRTH_DATE =
  /(?:(?:geb(?:oren|\.)?|Geburtsdatum|Geburtstag|date of birth|DOB|born)\s*(?:am|on|:)?\s*)(\d{1,2}[./-]\s?\d{1,2}[./-]\s?\d{2,4}|\d{4}-\d{2}-\d{2})|(\d{1,2}[./-]\s?\d{1,2}[./-]\s?\d{2,4})\s*(?:\(geb(?:oren|\.)?\)|geb\.)/gi

// German-style street address: "Musterstraße 12, 12345 Berlin" or "Hauptstr. 3a\n80331 München".
// Up to two capitalised words before the street word ("Alte Poststraße", "Am Markt"),
// a house number, the postcode and a town with the usual prefixes and connectors.
const STREET_WORD = '(?:[Ss]tra(?:ß|ss)e|[Ss]tr\\.|[Ww]eg|[Gg]asse|[Pp]latz|[Aa]llee|[Rr]ing|[Dd]amm|[Uu]fer|[Cc]haussee|[Ss]teig|[Mm]arkt)'
const TOWN = '(?:(?:Bad|Sankt|St\\.|Neu|Groß|Klein|Ober|Unter|Alt)[ -])?[A-ZÄÖÜ][a-zäöüß-]+(?: (?:am|an der|im|in der|bei|ob der|vor der|a\\. ?d\\.|i\\. ?d\\.) [A-ZÄÖÜ][a-zäöüß-]+)?'
const ADDRESS = new RegExp(
  `(?<![\\wäöüß])(?:[A-ZÄÖÜ][\\wäöüß.-]*[ -]){0,2}[A-ZÄÖÜa-zäöüß][\\wäöüß-]*?${STREET_WORD}\\s+\\d{1,4}\\s?[a-zA-Z]?(?:\\s*[,/\\n]\\s*|\\s+)\\d{4,5}\\s+${TOWN}`,
  'g'
)

const TITLES = '(?:Herrn?|Frau|Hr\\.|Fr\\.|Mr\\.?|Mrs\\.?|Ms\\.?|Dr\\.|Prof\\.|Dipl\\.-[A-Za-z]+\\.?|Mag\\.|Ing\\.|Dr\\. med\\.|RA|StB|WP)'
const NAME_WORD = "[A-ZÄÖÜ][a-zäöüßA-ZÄÖÜ'’-]+"
// Salutation or title followed by one to three capitalised words — none of
// which may itself be a title, or "Frau Dr." would yield the name "Dr".
const NOT_TITLE = `(?!${TITLES}(?![\\wäöüß]))`
const SALUTED_NAME = new RegExp(`\\b${TITLES}(?:\\s+${TITLES})*\\s+(${NOT_TITLE}${NAME_WORD}(?:\\s+${NOT_TITLE}${NAME_WORD}){0,2})`, 'g')
// Signature block: closing formula, then the name on the next line.
const SIGNATURE_NAME = new RegExp(
  `(?:Mit freundlichen Grüßen|Freundliche Grüße|Viele Grüße|Beste Grüße|Herzliche Grüße|Hochachtungsvoll|Kind regards|Best regards|Sincerely|Regards)[,.]?\\s*\\n+\\s*(?:i\\.\\s?A\\.\\s*|i\\.\\s?V\\.\\s*|ppa\\.\\s*)?(${NAME_WORD}(?:\\s+${NAME_WORD}){1,2})`,
  'g'
)

const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** All personal data in a text, non-overlapping, ordered by position. */
export function findPii(text: string, options: PiiOptions = DEFAULT_PII_OPTIONS): PiiMatch[] {
  const matches: PiiMatch[] = []
  const on = options.categories

  const scan = (category: PiiCategory, pattern: RegExp, accept?: (value: string) => boolean, group = 0) => {
    pattern.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = pattern.exec(text))) {
      const value = match[group] ?? match[0]
      if (value === undefined || value === '') {
        if (match[0].length === 0) pattern.lastIndex++
        continue
      }
      if (accept && !accept(value)) continue
      const start = group === 0 ? match.index : match.index + match[0].indexOf(value)
      matches.push({ category, start, end: start + value.length, value })
    }
  }

  if (on.email) scan('email', EMAIL)
  if (on.iban) scan('iban', IBAN, isValidIban)
  if (on.card) scan('card', CARD, (v) => passesLuhn(v) && !isValidIban(v))
  if (on.taxId) scan('taxId', TAX_ID, isValidGermanTaxId)
  if (on.socialSecurity) scan('socialSecurity', SOCIAL, isValidGermanSocialSecurity)
  if (on.ip) {
    scan('ip', IPV4)
    scan('ip', IPV6, (v) => v.includes(':') && /[a-fA-F]|::/.test(v) ? true : v.split(':').length >= 4)
  }
  if (on.birthDate) {
    BIRTH_DATE.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = BIRTH_DATE.exec(text))) {
      const value = match[1] ?? match[2]
      if (!value) continue
      const start = match.index + match[0].indexOf(value)
      matches.push({ category: 'birthDate', start, end: start + value.length, value })
    }
  }
  if (on.address) scan('address', ADDRESS)
  if (on.phone) scan('phone', PHONE, (v) => v.replace(/\D/g, '').length >= 7 && v.replace(/\D/g, '').length <= 15)

  if (on.person) {
    scan('person', SALUTED_NAME, undefined, 1)
    scan('person', SIGNATURE_NAME, undefined, 1)
    for (const name of options.knownNames) {
      const trimmed = name.trim()
      if (trimmed.length < 3) continue
      scan('person', new RegExp(`(?<![\\wäöüß])${escapeRegex(trimmed)}(?![\\wäöüß])`, 'g'))
    }
  }

  // Resolve overlaps: longer match wins, then earlier category in priority order.
  const priority: PiiCategory[] = ['iban', 'card', 'taxId', 'socialSecurity', 'email', 'address', 'birthDate', 'phone', 'ip', 'person']
  matches.sort((a, b) => a.start - b.start || b.end - b.start - (a.end - a.start) || priority.indexOf(a.category) - priority.indexOf(b.category))
  const resolved: PiiMatch[] = []
  let cursor = -1
  for (const match of matches) {
    if (match.start < cursor) continue
    resolved.push(match)
    cursor = match.end
  }
  return resolved
}

// ---------------------------------------------------------------------------
// Replacement
// ---------------------------------------------------------------------------

/** Consistent placeholders: the same value always maps to the same token. */
export class Pseudonymizer {
  private readonly tokens = new Map<string, { token: string; category: PiiCategory; original: string }>()
  private readonly counters = new Map<PiiCategory, number>()

  constructor(private readonly options: PiiOptions) {}

  replacementFor(match: PiiMatch): string {
    if (this.options.mode === 'entfernen') return ''
    const key = `${match.category}:${normalise(match.category, match.value)}`
    let entry = this.tokens.get(key)
    if (!entry) {
      const n = (this.counters.get(match.category) ?? 0) + 1
      this.counters.set(match.category, n)
      entry = { token: `[${PLACEHOLDER[match.category]} ${n}]`, category: match.category, original: match.value.replace(/\s+/g, ' ') }
      this.tokens.set(key, entry)
    }
    return entry.token
  }

  /** Placeholder → original (as first seen), for the confidential mapping list. */
  mapping(): { token: string; category: PiiCategory; original: string }[] {
    return Array.from(this.tokens.values()).map((entry) => ({ ...entry }))
  }

  /** Replaces every match in a plain string. */
  apply(text: string): { text: string; count: number } {
    const matches = findPii(text, this.options)
    if (matches.length === 0) return { text, count: 0 }
    let out = ''
    let cursor = 0
    for (const match of matches) {
      out += text.slice(cursor, match.start) + this.replacementFor(match)
      cursor = match.end
    }
    return { text: out + text.slice(cursor), count: matches.length }
  }
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

export interface PiiMapping {
  token: string
  category: PiiCategory
  original: string
}

/** What a run did to one file, for the report. */
export interface PiiSummary {
  /** Matches replaced (or deleted), by category. */
  replaced: Partial<Record<PiiCategory, number>>
  /** Placeholder → original. Confidential; kept apart from the report. */
  mapping: PiiMapping[]
  /** Things the tool could not do and the user has to check by hand. */
  notes: string[]
}

export const countByCategory = (matches: PiiMatch[]): Partial<Record<PiiCategory, number>> => {
  const counts: Partial<Record<PiiCategory, number>> = {}
  for (const match of matches) counts[match.category] = (counts[match.category] ?? 0) + 1
  return counts
}

export function addCounts(target: Partial<Record<PiiCategory, number>>, extra: Partial<Record<PiiCategory, number>>): void {
  for (const category of PII_CATEGORIES) {
    const n = extra[category]
    if (n) target[category] = (target[category] ?? 0) + n
  }
}

export const totalCount = (counts: Partial<Record<PiiCategory, number>>): number =>
  PII_CATEGORIES.reduce((sum, category) => sum + (counts[category] ?? 0), 0)

/** "2 E-Mail-Adressen, 1 IBAN, 3 Personennamen" */
export function describeCounts(counts: Partial<Record<PiiCategory, number>>): string {
  const plural: Record<PiiCategory, string> = {
    email: 'E-Mail-Adressen',
    phone: 'Telefonnummern',
    iban: 'IBANs',
    card: 'Kartennummern',
    taxId: 'Steuer-IDs',
    socialSecurity: 'Sozialversicherungsnummern',
    ip: 'IP-Adressen',
    birthDate: 'Geburtsdaten',
    address: 'Postanschriften',
    person: 'Personennamen',
  }
  return PII_CATEGORIES.filter((category) => counts[category])
    .map((category) => `${counts[category]} ${counts[category] === 1 ? PII_LABELS[category] : plural[category]}`)
    .join(', ')
}

/**
 * What no tool can take off the controller's plate. Printed with every run
 * that had the GDPR switch on, so the report never reads as a certificate.
 */
export const GDPR_RESPONSIBILITIES: string[] = [
  'Rechtsgrundlage (Art. 6 DSGVO): Für die verbleibende Verarbeitung — auch die Weitergabe des bereinigten Dokuments — muss eine Rechtsgrundlage vorliegen.',
  'Zweckbindung und Datenminimierung (Art. 5 Abs. 1 lit. b und c): Prüfen, ob die verbliebenen Inhalte für den Zweck der Weitergabe erforderlich sind.',
  'Vollständigkeit der Erkennung: Die Mustererkennung findet typische Formate. Namen ohne Anrede, Namen in Bildern, eingebetteten Objekten, Diagrammdaten und Spitznamen müssen von Hand geprüft werden.',
  'Pseudonymisierung ist keine Anonymisierung (Art. 4 Nr. 5): Die Zuordnungsliste ist selbst ein personenbezogenes Datum und getrennt vom Dokument, zugriffsgeschützt und mit Löschfrist aufzubewahren — oder zu vernichten, wenn keine Rückführung nötig ist.',
  'Speicherdauer (Art. 5 Abs. 1 lit. e, Art. 17): Das Original mit den Klardaten unterliegt weiterhin der Löschfrist; die Bereinigung einer Kopie ändert daran nichts.',
  'Betroffenenrechte (Art. 15–21): Auskunfts-, Berichtigungs- und Löschersuchen beziehen sich auch auf das Original und die Zuordnungsliste.',
  'Auftragsverarbeitung (Art. 28): Wird das Dokument an einen Dienstleister gegeben, braucht es einen Vertrag zur Auftragsverarbeitung; die Bereinigung ersetzt ihn nicht.',
  'Verzeichnis und Nachweis (Art. 5 Abs. 2, Art. 30): Dieses Protokoll dokumentiert die technische Maßnahme; die Aufnahme in das Verarbeitungsverzeichnis und die Bewertung bleiben Aufgabe des Verantwortlichen.',
]

/** Values that mean the same thing get the same token regardless of spacing. */
function normalise(category: PiiCategory, value: string): string {
  switch (category) {
    case 'email':
      return value.toLowerCase()
    case 'iban':
    case 'card':
    case 'taxId':
    case 'socialSecurity':
    case 'phone':
      return value.replace(/[\s./()-]/g, '')
    case 'person':
    case 'address':
      return value.replace(/\s+/g, ' ').trim()
    default:
      return value
  }
}
