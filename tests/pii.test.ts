import {
  DEFAULT_PII_OPTIONS,
  Pseudonymizer,
  findPii,
  isValidGermanSocialSecurity,
  isValidGermanTaxId,
  isValidIban,
  parseNameList,
  passesLuhn,
  piiOptionsFrom,
  DEFAULT_PII_CLEAN,
} from '../lib/pii'
import { applyOdfPii, applyOoxmlPii, applyRtfPii, rtfPlainText, scanOoxmlPii, scanRtfPii } from '../lib/piiDocument'
import { buildMappingText, buildReportText, cleanFile, loadFile, type ReportEntry } from '../lib/clean'
import { profileByKey } from '../lib/profiles'
import { textOf } from '../lib/ooxmlPackage'
import { extractPdfText } from '../lib/pdf'
import { docxEntries, fromZip, makeEntries, toZip } from './fixtures'
import { assert, equal, excludes, includes, test } from './helpers'

const NS_W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
const NS_S = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
const NS_A = 'http://schemas.openxmlformats.org/drawingml/2006/main'
const NS_P = 'http://schemas.openxmlformats.org/presentationml/2006/main'

const categories = (text: string) => findPii(text).map((m) => `${m.category}:${m.value}`)

// ---------------------------------------------------------------------------
// Validators
// ---------------------------------------------------------------------------

await test('DSGVO: Prüfsummen trennen echte Nummern von Zufallszahlen', () => {
  assert(isValidIban('DE89 3704 0044 0532 0130 00'), 'gültige IBAN abgelehnt')
  assert(!isValidIban('DE89 3704 0044 0532 0130 01'), 'IBAN mit falscher Prüfsumme angenommen')
  assert(passesLuhn('4539 1488 0343 6467'), 'gültige Kartennummer abgelehnt')
  assert(!passesLuhn('4539 1488 0343 6468'), 'Kartennummer mit falscher Prüfziffer angenommen')
  assert(isValidGermanTaxId('86095742719'), 'gültige Steuer-ID abgelehnt')
  assert(!isValidGermanTaxId('86095742718'), 'Steuer-ID mit falscher Prüfziffer angenommen')
  assert(!isValidGermanTaxId('12345678901'), 'Steuer-ID ohne Ziffernwiederholung angenommen')
  assert(isValidGermanSocialSecurity('65 170839 J 003'), 'gültige SV-Nummer abgelehnt')
  assert(!isValidGermanSocialSecurity('65 170839 J 004'), 'SV-Nummer mit falscher Prüfziffer angenommen')
})

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

await test('DSGVO: typische Angaben werden gefunden', () => {
  const text = [
    'Sehr geehrte Frau Dr. Erika Musterfrau,',
    'bitte melden Sie sich unter erika.musterfrau@firma.de oder +49 (0)30 123456-78.',
    'Lieferung an Musterstraße 12, 10115 Berlin. Geburtsdatum: 03.04.1975.',
    'IBAN DE89 3704 0044 0532 0130 00, Steuer-ID 86 095 742 719, Server 192.168.10.44.',
    'Mit freundlichen Grüßen',
    'Max Mustermann',
  ].join('\n')
  const found = categories(text)
  for (const expected of [
    'person:Erika Musterfrau',
    'email:erika.musterfrau@firma.de',
    'phone:+49 (0)30 123456-78',
    'address:Musterstraße 12, 10115 Berlin',
    'birthDate:03.04.1975',
    'iban:DE89 3704 0044 0532 0130 00',
    'taxId:86 095 742 719',
    'ip:192.168.10.44',
    'person:Max Mustermann',
  ]) {
    assert(found.includes(expected), `"${expected}" fehlt, gefunden: ${found.join(' | ')}`)
  }
})

await test('DSGVO: Zahlen, Daten und Wörter ohne Personenbezug bleiben unangetastet', () => {
  const text =
    'Umsatz 2024: 1.250.000 EUR, Marge 12,5 %. Rechnung 20240315 vom 15.03.2024, Artikel 4711, Version 10.2.3. ' +
    'Die Sitzung dauerte 90 Minuten. Bestellnummer 12345678901. Kapitel 3 Absatz 2. Preis 0,99 EUR.'
  const found = categories(text)
  equal(found.length, 0, `Fehlalarme: ${found.join(' | ')}`)
})

await test('DSGVO: bekannte Namen werden überall erkannt, auch ohne Anrede', () => {
  const options = { ...DEFAULT_PII_OPTIONS, knownNames: ['Max Mustermann'] }
  const found = findPii('Protokoll von Max Mustermann; Rückfragen an Mustermann-Nachfolger.', options)
  equal(found.length, 1, `erwartet eine Stelle, gefunden: ${found.map((m) => m.value).join(' | ')}`)
  equal(found[0].value, 'Max Mustermann', 'falscher Treffer')
})

await test('DSGVO: Platzhalter sind konsistent und die Zuordnung vollständig', () => {
  const p = new Pseudonymizer(DEFAULT_PII_OPTIONS)
  const one = p.apply('Kontakt: max@firma.de, Vertretung erika@firma.de, nochmal MAX@firma.de').text
  equal(one, 'Kontakt: [E-Mail 1], Vertretung [E-Mail 2], nochmal [E-Mail 1]', 'Platzhalter nicht konsistent')
  const two = p.apply('Herr Max Mustermann und Frau Erika Musterfrau').text
  equal(two, 'Herr [Person 1] und Frau [Person 2]', 'Namen nicht ersetzt')
  const mapping = p.mapping()
  equal(mapping.length, 4, 'Zuordnungsliste unvollständig')
  assert(mapping.some((m) => m.token === '[Person 1]' && m.original === 'Max Mustermann'), 'Zuordnung fehlt')

  const remover = new Pseudonymizer({ ...DEFAULT_PII_OPTIONS, mode: 'entfernen' })
  equal(remover.apply('Mail an max@firma.de bitte').text, 'Mail an  bitte', 'Löschmodus ersetzt statt zu löschen')
})

await test('DSGVO: Namensliste wird aus freiem Text gelesen', () => {
  equal(parseNameList('Max Mustermann, Erika Musterfrau\nDr. Beispiel;').join('|'), 'Max Mustermann|Erika Musterfrau|Dr. Beispiel', 'Liste falsch zerlegt')
  const options = piiOptionsFrom({ ...DEFAULT_PII_CLEAN, knownNames: ['ab', 'Autor 1', '  Max Mustermann  '] }, ['12345'])
  equal(options.knownNames.join('|'), 'Max Mustermann', 'Kurze, generische oder numerische Namen müssen herausfallen')
})

// ---------------------------------------------------------------------------
// Word, Excel, PowerPoint
// ---------------------------------------------------------------------------

const docxWithRuns = () =>
  makeEntries({
    '[Content_Types].xml': '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
    'word/document.xml':
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="${NS_W}"><w:body>` +
      `<w:p><w:r><w:t>Kontakt: max</w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>@fir</w:t></w:r><w:r><w:t>ma.de bitte.</w:t></w:r></w:p>` +
      `<w:p><w:r><w:t xml:space="preserve">Frau </w:t></w:r><w:r><w:t>Erika Musterfrau</w:t></w:r><w:r><w:t xml:space="preserve"> kommt.</w:t></w:r></w:p>` +
      `<w:p><w:r><w:t>Max Mustermann hat unterschrieben.</w:t></w:r></w:p>` +
      `<w:p><w:r><w:instrText xml:space="preserve"> HYPERLINK "mailto:max@firma.de" </w:instrText></w:r></w:p>` +
      `</w:body></w:document>`,
    'word/_rels/document.xml.rels':
      `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="mailto:max@firma.de?subject=Hallo" TargetMode="External"/></Relationships>`,
    'word/styles.xml': `<?xml version="1.0"?><w:styles xmlns:w="${NS_W}"><w:style><w:name w:val="max@firma.de"/></w:style></w:styles>`,
  })

await test('Word: Ersetzen über Lauf-Grenzen hinweg, Formatierung bleibt', () => {
  const entries = docxWithRuns()
  const options = piiOptionsFrom(DEFAULT_PII_CLEAN, ['Max Mustermann'])
  const found = scanOoxmlPii(entries, options)
  equal(found.filter((m) => m.category === 'email').length, 2, 'E-Mail über drei Läufe nicht erkannt')
  equal(found.filter((m) => m.category === 'person').length, 2, 'Namen nicht erkannt')

  const result = applyOoxmlPii(entries, options, new Pseudonymizer(options))
  const xml = textOf(entries, 'word/document.xml') ?? ''
  includes(xml, '<w:t>Kontakt: [E-Mail 1]</w:t>', 'Platzhalter nicht im ersten Lauf')
  includes(xml, '<w:rPr><w:b/></w:rPr><w:t/>', 'Formatierter Lauf wurde nicht geleert, sondern entfernt')
  includes(xml, '<w:t xml:space="preserve"> bitte.</w:t>', 'Rest hinter dem Treffer fehlt oder verliert Leerzeichen')
  includes(xml, '<w:t>[Person 1]</w:t>', 'Name nach Anrede nicht ersetzt')
  includes(xml, '[Person 2] hat unterschrieben', 'Bekannter Name nicht ersetzt')
  includes(xml, 'HYPERLINK "mailto:[E-Mail 1]"', 'Feldfunktion nicht ersetzt')
  excludes(xml, 'firma.de', 'E-Mail weiterhin im Dokument')
  const rels = textOf(entries, 'word/_rels/document.xml.rels') ?? ''
  excludes(rels, 'max@firma.de', 'mailto-Ziel im Hyperlink nicht ersetzt')
  includes(rels, '?subject=Hallo', 'Hyperlink-Parameter verloren')
  includes(textOf(entries, 'word/styles.xml') ?? '', 'max@firma.de', 'Formatvorlagen dürfen nicht angefasst werden')
  equal(result.replaced.email, 3, 'Zählung der E-Mails falsch')
  assert(result.parts.includes('word/document.xml') && result.parts.includes('word/_rels/document.xml.rels'), 'Teile nicht protokolliert')
})

await test('Excel: Zeichenkettentabelle, Inline-Text und Kommentare', () => {
  const entries = makeEntries({
    'xl/sharedStrings.xml':
      `<?xml version="1.0"?><sst xmlns="${NS_S}"><si><t>Kunde</t></si>` +
      `<si><r><t>erika</t></r><r><rPr><b/></rPr><t>@firma.de</t></r></si>` +
      `<si><t>DE89 3704 0044 0532 0130 00</t></si><si><t>Betrag 120000</t></si></sst>`,
    'xl/worksheets/sheet1.xml':
      `<?xml version="1.0"?><worksheet xmlns="${NS_S}"><sheetData><row r="1">` +
      `<c r="A1" t="inlineStr"><is><t>Tel. 0170 1234567</t></is></c></row></sheetData></worksheet>`,
    'xl/comments1.xml': `<?xml version="1.0"?><comments xmlns="${NS_S}"><commentList><comment ref="A1"><text><r><t>Von max@firma.de geprüft</t></r></text></comment></commentList></comments>`,
  })
  const options = piiOptionsFrom(DEFAULT_PII_CLEAN)
  applyOoxmlPii(entries, options, new Pseudonymizer(options))
  const sst = textOf(entries, 'xl/sharedStrings.xml') ?? ''
  includes(sst, '<r><t>[E-Mail 1]</t></r><r><rPr><b/></rPr><t/></r>', 'Rich-Text-Zelle nicht über die Läufe ersetzt')
  includes(sst, '<t>[IBAN 1]</t>', 'IBAN nicht ersetzt')
  includes(sst, 'Betrag 120000', 'Harmlose Zahl verändert')
  includes(textOf(entries, 'xl/worksheets/sheet1.xml') ?? '', 'Tel. [Telefon 1]', 'Inline-Text nicht ersetzt')
  includes(textOf(entries, 'xl/comments1.xml') ?? '', 'Von [E-Mail 2] geprüft', 'Kommentar nicht ersetzt')
})

await test('PowerPoint: Folientext, Notizen und Alternativtext', () => {
  const entries = makeEntries({
    'ppt/slides/slide1.xml':
      `<?xml version="1.0"?><p:sld xmlns:p="${NS_P}" xmlns:a="${NS_A}"><p:cSld><p:spTree>` +
      `<p:nvSpPr><p:cNvPr id="2" name="Bild 1" descr="Foto von Max Mustermann"/></p:nvSpPr>` +
      `<p:sp><p:txBody><a:p><a:r><a:t>Ansprechpartner: Herr </a:t></a:r><a:r><a:t>Max Muster</a:t></a:r><a:r><a:t>mann, Tel. +49 89 1234567</a:t></a:r></a:p></p:txBody></p:sp>` +
      `</p:spTree></p:cSld></p:sld>`,
    'ppt/notesSlides/notesSlide1.xml': `<?xml version="1.0"?><p:notes xmlns:p="${NS_P}" xmlns:a="${NS_A}"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>Erika anrufen: 030 9876543</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:notes>`,
  })
  const options = piiOptionsFrom(DEFAULT_PII_CLEAN, ['Max Mustermann'])
  applyOoxmlPii(entries, options, new Pseudonymizer(options))
  const slide = textOf(entries, 'ppt/slides/slide1.xml') ?? ''
  includes(slide, '<a:t>Ansprechpartner: Herr </a:t></a:r><a:r><a:t>[Person 1]</a:t></a:r><a:r><a:t>, Tel. [Telefon 1]</a:t>', 'Name und Nummer nicht über die Läufe hinweg ersetzt')
  includes(slide, 'descr="Foto von [Person 1]"', 'Alternativtext nicht ersetzt')
  includes(textOf(entries, 'ppt/notesSlides/notesSlide1.xml') ?? '', '[Telefon 2]', 'Notizen nicht ersetzt')
})

// ---------------------------------------------------------------------------
// OpenDocument and RTF
// ---------------------------------------------------------------------------

await test('OpenDocument: Absätze mit Leerzeichen-Elementen und Anmerkungen', () => {
  const entries = makeEntries({
    mimetype: 'application/vnd.oasis.opendocument.text',
    'content.xml':
      `<?xml version="1.0"?><office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" ` +
      `xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:dc="http://purl.org/dc/elements/1.1/"><office:body><office:text>` +
      `<text:p>Kontakt:<text:s/>max@firma.de<text:s text:c="2"/>oder<text:span text:style-name="T1"> Frau Erika</text:span> Musterfrau.</text:p>` +
      `<text:p>Notiz<office:annotation><dc:creator>Dr. Beispiel</dc:creator><text:p>Bitte Herrn Mustermann fragen</text:p></office:annotation> Ende</text:p>` +
      `</office:text></office:body></office:document-content>`,
  })
  const options = piiOptionsFrom(DEFAULT_PII_CLEAN)
  applyOdfPii(entries, options, new Pseudonymizer(options))
  const xml = textOf(entries, 'content.xml') ?? ''
  includes(xml, 'Kontakt:<text:s/>[E-Mail 1]<text:s text:c="2"/>oder<text:span text:style-name="T1"> Frau [Person 1]</text:span>.', 'Absatz falsch ersetzt')
  includes(xml, '<text:p>Bitte Herrn [Person 2] fragen</text:p>', 'Anmerkungstext nicht ersetzt')
  includes(xml, '<dc:creator>Dr. Beispiel</dc:creator>', 'Autorenfeld gehört der Anonymisierung, nicht dem Textersatz')
})

await test('RTF: Text mit Steuerwörtern, Escapes und Unicode', () => {
  const rtf =
    `{\\rtf1\\ansi\\deff0{\\fonttbl{\\f0 Arial;}}{\\info{\\author max@firma.de}}` +
    `{\\*\\generator Word}\\pard\\b Kontakt:\\b0  max@fir\\i ma.de\\i0  und Frau M\\'fcller, Tel. 0170\\~1234567.\\par` +
    `\nGr\\u252?\\u223?e von\\line Herrn J\\u246?rg Beispiel\\par\n}`
  const plain = rtfPlainText(rtf)
  includes(plain, 'Kontakt: max@firma.de und Frau Müller, Tel. 0170 1234567.', 'Klartext falsch extrahiert')
  includes(plain, 'Grüße von\nHerrn Jörg Beispiel', 'Unicode oder Zeilenumbruch falsch')
  excludes(plain, 'Arial', 'Schrifttabelle gehört nicht zum Text')
  excludes(plain, 'Word', 'Generator gehört nicht zum Text')

  const options = piiOptionsFrom(DEFAULT_PII_CLEAN)
  const found = scanRtfPii(rtf, options)
  assert(found.some((m) => m.category === 'email'), 'E-Mail nicht gefunden')
  assert(found.some((m) => m.category === 'person' && m.value === 'Müller'), `Name mit Escape nicht gefunden: ${found.map((m) => m.value).join(' | ')}`)
  assert(found.some((m) => m.category === 'person' && m.value === 'Jörg Beispiel'), 'Unicode-Name nicht gefunden')
  assert(found.some((m) => m.category === 'phone'), 'Telefonnummer mit geschütztem Leerzeichen nicht gefunden')

  const result = applyRtfPii(rtf, options, new Pseudonymizer(options))
  includes(result.text, '\\b Kontakt:\\b0  [E-Mail 1]\\i \\i0  und Frau [Person 1]', 'Ersetzung zerstört die Steuerwörter')
  includes(result.text, 'Herrn [Person 2]\\par', 'Unicode-Name nicht ersetzt')
  includes(result.text, '{\\info{\\author max@firma.de}}', 'Info-Gruppe gehört den Eigenschaften, nicht dem Textersatz')
  excludes(result.text.replace(/\{\\info[^}]*\}\}/, ''), 'firma.de', 'E-Mail weiterhin im Text')
  includes(rtfPlainText(result.text), 'Grüße von\nHerrn [Person 2]', 'Ergebnis liest sich nicht mehr sauber')
})

// ---------------------------------------------------------------------------
// PDF: report only
// ---------------------------------------------------------------------------

await test('PDF: Text wird zur Prüfung gelesen, nicht verändert', async () => {
  const content = 'BT /F1 12 Tf 72 700 Td (Kontakt: max@firma.de) Tj 0 -14 Td [(Frau Dr. Erika) -300 (Musterfrau)] TJ ET'
  const pdf =
    `%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n` +
    `3 0 obj << /Type /Page /Parent 2 0 R /Contents 4 0 R >> endobj\n4 0 obj << /Length ${content.length} >> stream\n${content}\nendstream endobj\n` +
    `trailer << /Root 1 0 R >>\n%%EOF`
  const bytes = new TextEncoder().encode(pdf)
  const text = await extractPdfText(bytes)
  includes(text.text, 'max@firma.de', 'E-Mail nicht extrahiert')
  includes(text.text, 'Frau Dr. Erika Musterfrau', 'TJ-Array nicht zusammengesetzt')

  const file = await loadFile('brief.pdf', bytes)
  const finding = file.findings.find((f) => f.id === 'pii')
  assert(finding, 'PDF-Fund fehlt')
  includes(finding.label, '1 E-Mail-Adresse', 'Zählung fehlt')
  equal(finding.option, undefined, 'PDF-Text muss als manuell gekennzeichnet sein')
})

// ---------------------------------------------------------------------------
// End to end through the umbrella module
// ---------------------------------------------------------------------------

await test('DSGVO-Profil: Eigenschaften, Inhalt, Protokoll und Zuordnungsliste', async () => {
  const entries = docxEntries()
  const document = entries.find((e) => e.name === 'word/document.xml')!
  const xml = new TextDecoder().decode(document.data).replace(
    '<w:t>Sichtbarer Text.</w:t>',
    '<w:t>Sichtbarer Text von Max Mustermann, max.mustermann@firma.de.</w:t>'
  )
  document.data = new TextEncoder().encode(xml)
  const profile = profileByKey('dsgvo')
  const file = await loadFile('bericht.docm', await toZip(entries), profile.options.pii)
  const finding = file.findings.find((f) => f.id === 'pii')
  assert(finding, 'Inhaltsfund fehlt')
  includes(finding.label, 'Personenname', 'Name aus den Eigenschaften nicht im Text erkannt')
  includes(finding.detail, 'max.mustermann@firma.de', 'Beispiel fehlt im Fund')

  const result = await cleanFile(file, { ...file.values, title: 'Bericht von Erika Musterfrau' }, file.customProps, profile.options)
  assert(!result.error, `Fehler: ${result.error}`)
  assert(result.pii, 'DSGVO-Zusammenfassung fehlt')
  assert(result.steps.some((s) => s.startsWith('Pseudonymisiert im Inhalt')), `Inhaltsschritt fehlt: ${result.steps.join(' | ')}`)
  assert(result.steps.some((s) => s.startsWith('Pseudonymisiert in den Eigenschaften')), 'Eigenschaftenschritt fehlt')

  const out = await fromZip(result.bytes)
  const all = out.map((e) => new TextDecoder().decode(e.data)).join('\n')
  excludes(all, 'max.mustermann@firma.de', 'E-Mail weiterhin enthalten')
  excludes(all.replace(/vbaProject[\s\S]*?(?=\n)/, ''), 'Max Mustermann', 'Name weiterhin enthalten (außer im entfernten Makro)')
  excludes(all, 'Erika Musterfrau', 'Name aus dem Titel weiterhin enthalten')
  includes(textOf(out, 'docProps/core.xml') ?? '', 'Bericht von [Person', 'Titel nicht pseudonymisiert')
  assert(!result.remaining.some((f) => f.id === 'pii'), `Nachkontrolle findet noch: ${result.remaining.map((f) => f.label).join(', ')}`)
  assert(result.pii.mapping.some((m) => m.original === 'Max Mustermann'), 'Zuordnung fehlt')

  const entry: ReportEntry = {
    file: result.fileName,
    kind: file.kind,
    sizeBefore: file.size,
    sizeAfter: result.bytes.length,
    sha256Before: file.sha256,
    sha256After: result.sha256After,
    findingsBefore: file.findings,
    steps: result.steps,
    remaining: result.remaining,
    pii: result.pii,
  }
  const report = buildReportText([entry], 'jetzt')
  includes(report, 'DSGVO-Bereinigung:', 'DSGVO-Abschnitt fehlt')
  includes(report, 'In Ihrer Verantwortung bleibt', 'Verantwortungsliste fehlt')
  includes(report, 'bescheinigt keine', 'Das Protokoll darf nicht wie ein Zertifikat wirken')
  excludes(report, 'Max Mustermann', 'Klarnamen gehören nicht ins Protokoll')
  const mapping = buildMappingText([entry], 'jetzt')
  includes(mapping, 'VERTRAULICH', 'Zuordnungsliste nicht als vertraulich markiert')
  includes(mapping, 'Max Mustermann', 'Zuordnungsliste ohne Original')
})

await test('Standardprofil: Inhalt bleibt unangetastet, der Fund steht in der Nachkontrolle', async () => {
  const entries = docxWithRuns()
  const file = await loadFile('brief.docx', await toZip(entries))
  const result = await cleanFile(file, file.values, file.customProps, profileByKey('standard').options)
  assert(!result.error, `Fehler: ${result.error}`)
  equal(result.pii, undefined, 'Ohne Schalter darf es keine DSGVO-Zusammenfassung geben')
  assert(result.remaining.some((f) => f.id === 'pii'), 'Verbleibender Inhaltsfund fehlt in der Nachkontrolle')
})

await test('DSGVO: Platzhalter werden bei der Nachkontrolle nicht als Namen gewertet', async () => {
  const rtf = new TextEncoder().encode('{\\rtf1\\ansi{\\info{\\author Max Mustermann}}\\pard Kontakt: max@firma.de, Frau Dr. Erika Musterfrau\\par}')
  const options = profileByKey('dsgvo').options
  const file = await loadFile('brief.rtf', rtf, options.pii)
  const result = await cleanFile(file, file.values, file.customProps, options)
  assert(!result.error, `Fehler: ${result.error}`)
  equal(result.remaining.filter((f) => f.id === 'pii').length, 0, `Nachkontrolle meldet: ${result.remaining.map((f) => f.label).join(', ')}`)
  const original = result.pii?.mapping.find((m) => m.category === 'email')?.original
  equal(original, 'max@firma.de', 'Zuordnungsliste muss das Original in Schreibweise des Dokuments führen')
})
