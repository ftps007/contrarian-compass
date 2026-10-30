/**
 * Profiles — a named set of switches, so the same decision does not have to be
 * made file by file. Shared by the app, the standalone build and the CLI.
 */

import { DEFAULT_OPTIONS, type Options } from './clean'
import { PII_LABELS } from './pii'

export interface Profile {
  key: string
  label: string
  description: string
  options: Options
  /** Empty every property field as well. */
  clearAll?: boolean
}

const all = <T extends object>(options: T): T =>
  Object.fromEntries(Object.keys(options).map((key) => [key, true])) as T

export const PROFILES: Profile[] = [
  {
    key: 'standard',
    label: 'Standard',
    description: 'Metadaten bereinigen, Inhalte unangetastet lassen.',
    options: DEFAULT_OPTIONS,
  },
  {
    key: 'weitergabe',
    label: 'Weitergabe nach außen',
    description: 'Zusätzlich Namen anonymisieren, Notizen, Diagrammdaten und Makros entfernen.',
    options: {
      base: { ...DEFAULT_OPTIONS.base, stripCustomProps: true, stripComments: true },
      deep: {
        ...DEFAULT_OPTIONS.deep,
        anonymizeAuthors: true,
        removeSpeakerNotes: true,
        removeChartWorkbooks: true,
        removeMacros: true,
        flattenCroppedImages: true,
      },
      odf: { ...DEFAULT_OPTIONS.odf, anonymizeAuthors: true },
      pdf: DEFAULT_OPTIONS.pdf,
      rtf: { ...DEFAULT_OPTIONS.rtf, anonymizeAuthors: true },
      pii: DEFAULT_OPTIONS.pii,
    },
  },
  {
    key: 'dsgvo',
    label: 'DSGVO-Bereinigung',
    description:
      'Personenbezogene Daten in Eigenschaften und Text durch Platzhalter ersetzen, Namen anonymisieren, versteckte Inhalte entfernen. Ersetzt nicht die rechtliche Prüfung.',
    options: {
      base: { ...DEFAULT_OPTIONS.base, stripCustomProps: true, stripComments: true },
      deep: {
        ...DEFAULT_OPTIONS.deep,
        anonymizeAuthors: true,
        removeSpeakerNotes: true,
        removeChartWorkbooks: true,
        removeMacros: true,
        flattenCroppedImages: true,
        removeHiddenSheets: true,
        clearHiddenRowsCols: true,
        removeHiddenSlides: true,
        clearPivotCaches: true,
      },
      odf: { ...DEFAULT_OPTIONS.odf, anonymizeAuthors: true },
      pdf: { ...DEFAULT_OPTIONS.pdf, removeAnnotations: true },
      rtf: { ...DEFAULT_OPTIONS.rtf, anonymizeAuthors: true },
      pii: { ...DEFAULT_OPTIONS.pii, enabled: true },
    },
  },
  {
    key: 'streng',
    label: 'Streng',
    description: 'Alles entfernen, was entfernt werden kann — auch Inhalte wie ausgeblendete Blätter und Folien, alle Felder leeren.',
    options: {
      base: all(DEFAULT_OPTIONS.base),
      deep: all(DEFAULT_OPTIONS.deep),
      odf: all(DEFAULT_OPTIONS.odf),
      pdf: all(DEFAULT_OPTIONS.pdf),
      rtf: all(DEFAULT_OPTIONS.rtf),
      pii: { ...DEFAULT_OPTIONS.pii, enabled: true },
    },
    clearAll: true,
  },
]

/** Merges a partial options object (profile file, saved settings) over the defaults. */
export function mergeOptions(raw: Partial<Record<keyof Options, Record<string, unknown>>> | undefined): Options {
  const pii = { ...DEFAULT_OPTIONS.pii, ...(raw?.pii ?? {}) }
  if (!Array.isArray(pii.knownNames)) pii.knownNames = []
  return {
    base: { ...DEFAULT_OPTIONS.base, ...(raw?.base ?? {}) },
    deep: { ...DEFAULT_OPTIONS.deep, ...(raw?.deep ?? {}) },
    odf: { ...DEFAULT_OPTIONS.odf, ...(raw?.odf ?? {}) },
    pdf: { ...DEFAULT_OPTIONS.pdf, ...(raw?.pdf ?? {}) },
    rtf: { ...DEFAULT_OPTIONS.rtf, ...(raw?.rtf ?? {}) },
    pii,
  }
}

export const profileByKey = (key: string): Profile => PROFILES.find((p) => p.key === key) ?? PROFILES[0]

/** Human-readable labels for every switch, grouped for the options panel. */
export const OPTION_GROUPS: {
  group: keyof Options
  title: string
  /** Which file kinds this group applies to. */
  kinds: string[]
  items: { key: string; label: string; hint: string }[]
}[] = [
  {
    group: 'base',
    title: 'Grundlagen',
    kinds: ['ooxml', 'odf'],
    items: [
      { key: 'normalizeZipTimestamps', label: 'ZIP-Zeitstempel angleichen', hint: 'Sonst verraten die internen Datumsangaben die echte Bearbeitung.' },
      { key: 'stripRsids', label: 'Word-RSIDs entfernen', hint: 'Sitzungs-IDs, über die sich Bearbeitungsrunden und verwandte Dateien zuordnen lassen.' },
      { key: 'stripThumbnail', label: 'Vorschaubild entfernen', hint: 'Zeigt oft einen älteren Stand der ersten Seite.' },
      { key: 'stripCustomProps', label: 'Benutzerdefinierte Eigenschaften löschen', hint: 'Aktenzeichen und Benutzer-IDs aus Vorlagen- und DMS-Systemen.' },
      { key: 'stripComments', label: 'Kommentare & Personenliste entfernen', hint: 'Nachverfolgte Änderungen bleiben — die müssen in Word angenommen werden.' },
    ],
  },
  {
    group: 'deep',
    title: 'Versteckte Inhalte (Word, Excel, PowerPoint)',
    kinds: ['ooxml'],
    items: [
      { key: 'stripImageMetadata', label: 'EXIF/GPS aus eingebetteten Bildern', hint: 'Aufnahmeort, Kameramodell und Seriennummer eingefügter Fotos.' },
      { key: 'flattenCroppedImages', label: 'Zugeschnittene Bilder wirklich beschneiden', hint: 'Der weggeschnittene Teil ist sonst weiter in der Datei. Das Bild wird dabei neu berechnet.' },
      { key: 'clearPivotCaches', label: 'Pivot-Cache leeren', hint: 'Enthält die vollständigen Quelldaten, auch wenn das Quellblatt gelöscht wurde.' },
      { key: 'removeHiddenSheets', label: 'Ausgeblendete Tabellenblätter löschen', hint: 'Entfernt Inhalt — Formeln, die darauf verweisen, laufen ins Leere.' },
      { key: 'clearHiddenRowsCols', label: 'Ausgeblendete Zeilen/Spalten leeren', hint: 'Löscht deren Werte samt zugehöriger Einträge in der Zeichenkettentabelle.' },
      { key: 'removeHiddenSlides', label: 'Ausgeblendete Folien löschen', hint: 'Nicht vorgeführte Folien sind in der Datei vollständig vorhanden.' },
      { key: 'removeSpeakerNotes', label: 'Notizenseiten entfernen', hint: 'Sprechernotizen sind im Klartext lesbar.' },
      { key: 'removePrinterSettings', label: 'Druckereinstellungen entfernen', hint: 'Druckername und Treiberkonfiguration verraten das Firmennetz.' },
      { key: 'removeExternalLinks', label: 'Externe Verknüpfungen & Seriendruckquellen', hint: 'Pfade wie \\\\server\\abteilung oder /Users/vorname.nachname.' },
      { key: 'removeDocumentIds', label: 'Dokument-GUIDs und Absatz-IDs entfernen', hint: 'Wiedererkennungsmerkmale über Dateikopien hinweg.' },
      { key: 'removeChartWorkbooks', label: 'Eingebettete Diagrammdaten entfernen', hint: 'Hinter jedem Diagramm steckt eine vollständige Excel-Mappe.' },
      { key: 'removeMacros', label: 'Makros entfernen', hint: 'Die Datei wird dabei in ein makrofreies Format überführt (.docm → .docx).' },
      { key: 'anonymizeAuthors', label: 'Namen durch „Autor 1, 2, 3" ersetzen', hint: 'Konsistent über Kommentare, Änderungsverfolgung und Eigenschaften hinweg.' },
    ],
  },
  {
    group: 'pii',
    title: 'DSGVO: personenbezogene Daten in Eigenschaften und Inhalt',
    kinds: ['ooxml', 'odf', 'rtf', 'pdf', 'ole2'],
    items: [
      {
        key: 'enabled',
        label: 'Personenbezogene Daten ersetzen',
        hint: 'Ersetzt jede Fundstelle konsistent durch einen nummerierten Platzhalter wie „[Person 1]" — in Word, Excel, PowerPoint, OpenDocument und RTF auch im Text, bei PDF nur in den Eigenschaften.',
      },
      { key: 'remove', label: 'Löschen statt Platzhalter', hint: 'Entfernt die Stellen ersatzlos. Der Text wird dadurch schwerer lesbar, eine Zuordnungsliste entfällt.' },
      { key: 'person', label: PII_LABELS.person, hint: 'Namen aus den Dokumenteigenschaften, aus Kommentaren, nach Anrede oder Titel („Frau Dr. …") und aus Grußformeln, dazu die eigene Namensliste.' },
      { key: 'email', label: PII_LABELS.email, hint: 'Auch in Hyperlinks (mailto:).' },
      { key: 'phone', label: PII_LABELS.phone, hint: 'Internationale und nationale Schreibweisen mit mindestens sieben Ziffern.' },
      { key: 'address', label: PII_LABELS.address, hint: 'Straße mit Hausnummer, Postleitzahl und Ort.' },
      { key: 'birthDate', label: PII_LABELS.birthDate, hint: 'Datumsangaben neben „geb.", „Geburtsdatum" oder „date of birth".' },
      { key: 'iban', label: PII_LABELS.iban, hint: 'Nur mit gültiger Prüfsumme.' },
      { key: 'card', label: PII_LABELS.card, hint: 'Nur mit gültiger Luhn-Prüfziffer.' },
      { key: 'taxId', label: PII_LABELS.taxId, hint: 'Deutsche Steuer-ID mit gültiger Prüfziffer.' },
      { key: 'socialSecurity', label: PII_LABELS.socialSecurity, hint: 'Deutsche Rentenversicherungsnummer mit gültiger Prüfziffer.' },
      { key: 'ip', label: PII_LABELS.ip, hint: 'IPv4 und IPv6.' },
    ],
  },
  {
    group: 'pdf',
    title: 'PDF',
    kinds: ['pdf'],
    items: [
      { key: 'dropOldRevisions', label: 'Ältere Fassungen verwerfen', hint: 'Schreibt die Datei neu, sodass frühere Stände nicht wiederherstellbar sind.' },
      { key: 'removeXmp', label: 'XMP-Metadaten entfernen', hint: 'Bearbeitungsverlauf mit Programmen, Zeitstempeln und Dokument-IDs.' },
      { key: 'removeJavaScript', label: 'JavaScript entfernen', hint: 'Skripte, die beim Öffnen ausgeführt werden.' },
      { key: 'removeEmbeddedFiles', label: 'Eingebettete Dateien entfernen', hint: 'Anhänge samt ihrer eigenen Metadaten.' },
      { key: 'removeAnnotations', label: 'Anmerkungen entfernen', hint: 'Kommentare und Formularfelder mit Autorennamen — entfernt Inhalt.' },
    ],
  },
  {
    group: 'odf',
    title: 'OpenDocument',
    kinds: ['odf'],
    items: [
      { key: 'removeThumbnail', label: 'Vorschaubild entfernen', hint: 'Zeigt die erste Seite in einem möglicherweise älteren Stand.' },
      { key: 'stripImageMetadata', label: 'EXIF/GPS aus Bildern entfernen', hint: 'Auch LibreOffice übernimmt EXIF-Daten unverändert.' },
      { key: 'removeUserFields', label: 'Benutzerdefinierte Felder entfernen', hint: 'Freie Felder in meta.xml, oft mit Aktenzeichen.' },
      { key: 'anonymizeAuthors', label: 'Namen anonymisieren', hint: 'Betrifft Kommentare und Änderungen im Text.' },
    ],
  },
  {
    group: 'rtf',
    title: 'RTF',
    kinds: ['rtf'],
    items: [
      { key: 'removeGenerator', label: 'Erzeugerkennung entfernen', hint: 'Nennt Programm und Version.' },
      { key: 'removeRevisionTable', label: 'Revisionstabelle entfernen', hint: 'RTF führt jede Person, die je gespeichert hat.' },
      { key: 'anonymizeAuthors', label: 'Namen anonymisieren', hint: 'Betrifft Kommentarautoren.' },
    ],
  },
]
