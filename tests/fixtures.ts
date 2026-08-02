/**
 * Office packages built by hand, each one carrying the traps the deep cleaner
 * is supposed to find. Built as entry lists so tests can inspect them directly,
 * with `toZip`/`fromZip` for the round trips.
 */

import { readZip, writeZip, type ZipEntry } from '../lib/zip'
import { jpegWithMetadata } from './helpers'

const encoder = new TextEncoder()

export function entry(name: string, data: string | Uint8Array): ZipEntry {
  return {
    name,
    data: typeof data === 'string' ? encoder.encode(data) : data,
    method: 8,
    dosTime: 0,
    dosDate: 33,
    externalAttr: 0,
  }
}

export const makeEntries = (files: Record<string, string | Uint8Array>): ZipEntry[] =>
  Object.entries(files).map(([name, data]) => entry(name, data))

export async function toZip(entries: ZipEntry[]): Promise<Uint8Array> {
  const blob = await writeZip(entries)
  return new Uint8Array(await blob.arrayBuffer())
}

export const fromZip = (bytes: Uint8Array) => readZip(bytes.buffer as ArrayBuffer)

const NS_W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
const NS_R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const NS_A = 'http://schemas.openxmlformats.org/drawingml/2006/main'
const NS_S = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
const NS_P = 'http://schemas.openxmlformats.org/presentationml/2006/main'
const RELS = 'http://schemas.openxmlformats.org/package/2006/relationships'

const rels = (items: string) =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${RELS}">${items}</Relationships>`

const rel = (id: string, type: string, target: string, external = false) =>
  `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${target}"${external ? ' TargetMode="External"' : ''}/>`

const types = (overrides: string) =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
  `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
  `<Default Extension="xml" ContentType="application/xml"/>` +
  `<Default Extension="jpeg" ContentType="image/jpeg"/>` +
  `<Default Extension="bin" ContentType="application/vnd.openxmlformats-officedocument.oleObject"/>` +
  `${overrides}</Types>`

const override = (part: string, contentType: string) => `<Override PartName="/${part}" ContentType="${contentType}"/>`

/**
 * A macro-enabled Word document with: a cropped photo carrying EXIF/GPS, a
 * chart with its embedded workbook, comments and tracked changes by two named
 * people, a mail-merge source, a hyperlink to a network share, printer
 * settings, document GUIDs and white-on-white text.
 */
export function docxEntries(): ZipEntry[] {
  return makeEntries({
    '[Content_Types].xml': types(
      override('word/document.xml', 'application/vnd.ms-word.document.macroEnabled.main+xml') +
        override('word/settings.xml', 'application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml') +
        override('word/comments.xml', 'application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml') +
        override('word/people.xml', 'application/vnd.openxmlformats-officedocument.wordprocessingml.people+xml') +
        override('word/charts/chart1.xml', 'application/vnd.openxmlformats-officedocument.drawingml.chart+xml') +
        override('docProps/core.xml', 'application/vnd.openxmlformats-package.core-properties+xml')
    ),
    '_rels/.rels': rels(
      rel('rId1', 'officeDocument', 'word/document.xml') +
        `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>`
    ),
    'word/_rels/document.xml.rels': rels(
      rel('rId1', 'settings', 'settings.xml') +
        rel('rId2', 'comments', 'comments.xml') +
        rel('rId3', 'people', 'people.xml') +
        rel('rId4', 'image', 'media/image1.jpeg') +
        rel('rId5', 'chart', 'charts/chart1.xml') +
        rel('rId6', 'hyperlink', '\\\\fileserver\\abteilung\\geheim.docx', true) +
        rel('rId7', 'printerSettings', 'printerSettings/printerSettings1.bin') +
        rel('rId8', 'vbaProject', 'vbaProject.bin')
    ),
    'word/document.xml':
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<w:document xmlns:w="${NS_W}" xmlns:r="${NS_R}" xmlns:a="${NS_A}" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml">` +
      `<w:body>` +
      `<w:p w:rsidR="00A1B2C3" w14:paraId="12345678" w14:textId="87654321">` +
      `<w:commentRangeStart w:id="1"/><w:r><w:t>Sichtbarer Text.</w:t></w:r><w:commentRangeEnd w:id="1"/>` +
      `<w:r><w:commentReference w:id="1"/></w:r></w:p>` +
      `<w:p><w:ins w:id="9" w:author="Dr. Beispiel" w:date="2024-02-01T10:00:00Z"><w:r><w:t>Eingefügt.</w:t></w:r></w:ins></w:p>` +
      `<w:p><w:r><w:rPr><w:color w:val="FFFFFF"/></w:rPr><w:t>Unsichtbarer Hinweis</w:t></w:r></w:p>` +
      `<w:p><w:hyperlink r:id="rId6"><w:r><w:t>Netzlaufwerk</w:t></w:r></w:hyperlink></w:p>` +
      `<w:p><w:r><w:drawing><pic:pic><pic:blipFill><a:blip r:embed="rId4"/>` +
      `<a:srcRect l="25000" t="0" r="25000" b="10000"/><a:stretch><a:fillRect/></a:stretch>` +
      `</pic:blipFill></pic:pic></w:drawing></w:r></w:p>` +
      `<w:p><w:r><w:t>Diagramm folgt</w:t></w:r></w:p>` +
      `<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pageSetup r:id="rId7"/></w:sectPr>` +
      `</w:body></w:document>`,
    'word/settings.xml':
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<w:settings xmlns:w="${NS_W}" xmlns:w15="http://schemas.microsoft.com/office/word/2012/wordml">` +
      `<w:proofState w:spelling="clean"/>` +
      `<w:mailMerge><w:mainDocumentType w:val="formLetters"/><w:dataSource r:id="rId20" xmlns:r="${NS_R}"/>` +
      `<w:query w:val="SELECT * FROM /Users/max.mustermann/Adressen.xlsx"/></w:mailMerge>` +
      `<w15:docId w15:val="{8A1B2C3D-4E5F-6789-ABCD-EF0123456789}"/>` +
      `<w:rsids><w:rsidRoot w:val="00A1B2C3"/><w:rsid w:val="00A1B2C3"/></w:rsids>` +
      `</w:settings>`,
    'word/comments.xml':
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:comments xmlns:w="${NS_W}">` +
      `<w:comment w:id="1" w:author="Erika Musterfrau" w:initials="EM" w:date="2024-02-01T10:00:00Z">` +
      `<w:p><w:r><w:t>Bitte prüfen.</w:t></w:r></w:p></w:comment></w:comments>`,
    'word/people.xml':
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<w15:people xmlns:w15="http://schemas.microsoft.com/office/word/2012/wordml">` +
      `<w15:person w15:author="Erika Musterfrau">` +
      `<w15:presenceInfo w15:providerId="AD" w15:userId="S-1-5-21-1234567890-erika.musterfrau@firma.de"/>` +
      `</w15:person></w15:people>`,
    'word/charts/chart1.xml':
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:r="${NS_R}">` +
      `<c:chart><c:plotArea/></c:chart><c:externalData r:id="rId1"><c:autoUpdate val="0"/></c:externalData></c:chartSpace>`,
    'word/charts/_rels/chart1.xml.rels': rels(
      `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/package" Target="../embeddings/Microsoft_Excel_Worksheet1.xlsx"/>`
    ),
    'word/embeddings/Microsoft_Excel_Worksheet1.xlsx': 'PK Umsatzzahlen 2024 Q1 vertraulich',
    'word/media/image1.jpeg': jpegWithMetadata(),
    'word/printerSettings/printerSettings1.bin': 'HP LaserJet 4000 im 3. OG, Abteilung Recht',
    'word/vbaProject.bin': 'VBA-Modul von Max Mustermann',
    'docProps/core.xml':
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/">` +
      `<dc:creator>Max Mustermann</dc:creator><cp:lastModifiedBy>Erika Musterfrau</cp:lastModifiedBy></cp:coreProperties>`,
  })
}

/**
 * A workbook with a hidden sheet, hidden rows and columns holding real values,
 * a pivot cache full of source data, an external link and printer settings.
 */
export function xlsxEntries(): ZipEntry[] {
  const sharedStrings =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><sst xmlns="${NS_S}" count="5" uniqueCount="5">` +
    `<si><t>Sichtbar</t></si>` +
    `<si><t>Gehalt 120000</t></si>` +
    `<si><t>Interne Marge</t></si>` +
    `<si><t>Auch sichtbar</t></si>` +
    `<si><t>Nur im Pivot-Cache</t></si></sst>`

  return makeEntries({
    '[Content_Types].xml': types(
      override('xl/workbook.xml', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml') +
        override('xl/worksheets/sheet1.xml', 'application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml') +
        override('xl/worksheets/sheet2.xml', 'application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml') +
        override('xl/sharedStrings.xml', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml')
    ),
    '_rels/.rels': rels(rel('rId1', 'officeDocument', 'xl/workbook.xml')),
    'xl/_rels/workbook.xml.rels': rels(
      rel('rId1', 'worksheet', 'worksheets/sheet1.xml') +
        rel('rId2', 'worksheet', 'worksheets/sheet2.xml') +
        rel('rId3', 'sharedStrings', 'sharedStrings.xml') +
        rel('rId4', 'pivotCacheDefinition', 'pivotCache/pivotCacheDefinition1.xml') +
        rel('rId5', 'externalLink', 'externalLinks/externalLink1.xml')
    ),
    'xl/workbook.xml':
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="${NS_S}" xmlns:r="${NS_R}">` +
      `<sheets><sheet name="Bericht" sheetId="1" r:id="rId1"/>` +
      `<sheet name="Kalkulation intern" sheetId="2" state="veryHidden" r:id="rId2"/></sheets>` +
      `<definedNames><definedName name="Marge">'Kalkulation intern'!$A$1</definedName></definedNames>` +
      `<externalReferences><externalReference r:id="rId5"/></externalReferences></workbook>`,
    'xl/worksheets/_rels/sheet1.xml.rels': rels(rel('rId1', 'printerSettings', '../printerSettings/printerSettings1.bin')),
    'xl/worksheets/sheet1.xml':
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="${NS_S}" xmlns:r="${NS_R}">` +
      `<cols><col min="3" max="3" hidden="1" width="10"/></cols>` +
      `<sheetData>` +
      `<row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1" t="s"><v>2</v></c></row>` +
      `<row r="2" hidden="1"><c r="A2" t="s"><v>1</v></c><c r="B2"><v>120000</v></c></row>` +
      `<row r="3"><c r="A3" t="s"><v>3</v></c></row>` +
      `</sheetData><pageSetup r:id="rId1"/></worksheet>`,
    'xl/worksheets/sheet2.xml':
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="${NS_S}"><sheetData>` +
      `<row r="1"><c r="A1"><v>0.42</v></c></row></sheetData></worksheet>`,
    'xl/sharedStrings.xml': sharedStrings,
    'xl/pivotCache/pivotCacheDefinition1.xml':
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><pivotCacheDefinition xmlns="${NS_S}" xmlns:r="${NS_R}" recordCount="3">` +
      `<cacheSource type="worksheet"><worksheetSource ref="A1:C4" sheet="Kalkulation intern"/></cacheSource>` +
      `<cacheFields count="1"><cacheField name="Kunde"><sharedItems><s v="Kunde Alpha"/><s v="Kunde Beta"/></sharedItems></cacheField></cacheFields>` +
      `</pivotCacheDefinition>`,
    'xl/pivotCache/pivotCacheRecords1.xml':
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><pivotCacheRecords xmlns="${NS_S}" count="3">` +
      `<r><s v="Kunde Alpha"/><n v="120000"/></r><r><s v="Kunde Beta"/><n v="98000"/></r><r><s v="Kunde Gamma"/><n v="45000"/></r>` +
      `</pivotCacheRecords>`,
    'xl/externalLinks/externalLink1.xml':
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><externalLink xmlns="${NS_S}"><externalBook/></externalLink>`,
    'xl/externalLinks/_rels/externalLink1.xml.rels': rels(
      rel('rId1', 'externalLinkPath', 'file:///Users/max.mustermann/Kalkulation.xlsx', true)
    ),
    'xl/printerSettings/printerSettings1.bin': 'Drucker Buchhaltung',
  })
}

/** A deck with a hidden slide, speaker notes and named comment authors. */
export function pptxEntries(): ZipEntry[] {
  return makeEntries({
    '[Content_Types].xml': types(
      override('ppt/presentation.xml', 'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml') +
        override('ppt/slides/slide1.xml', 'application/vnd.openxmlformats-officedocument.presentationml.slide+xml') +
        override('ppt/slides/slide2.xml', 'application/vnd.openxmlformats-officedocument.presentationml.slide+xml') +
        override('ppt/notesSlides/notesSlide1.xml', 'application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml') +
        override('ppt/commentAuthors.xml', 'application/vnd.openxmlformats-officedocument.presentationml.commentAuthors+xml')
    ),
    '_rels/.rels': rels(rel('rId1', 'officeDocument', 'ppt/presentation.xml')),
    'ppt/_rels/presentation.xml.rels': rels(
      rel('rId1', 'slide', 'slides/slide1.xml') +
        rel('rId2', 'slide', 'slides/slide2.xml') +
        rel('rId3', 'commentAuthors', 'commentAuthors.xml')
    ),
    'ppt/presentation.xml':
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:presentation xmlns:p="${NS_P}" xmlns:r="${NS_R}">` +
      `<p:sldIdLst><p:sldId id="256" r:id="rId1"/><p:sldId id="257" r:id="rId2"/></p:sldIdLst></p:presentation>`,
    'ppt/slides/_rels/slide1.xml.rels': rels(rel('rId1', 'notesSlide', '../notesSlides/notesSlide1.xml')),
    'ppt/slides/slide1.xml':
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sld xmlns:p="${NS_P}" xmlns:p14="http://schemas.microsoft.com/office/powerpoint/2010/main">` +
      `<p14:creationId val="1234567890"/><p:cSld><p:spTree/></p:cSld></p:sld>`,
    'ppt/slides/slide2.xml':
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sld xmlns:p="${NS_P}" show="0">` +
      `<p:cSld><p:spTree>Nicht gezeigte Zahlen</p:spTree></p:cSld></p:sld>`,
    'ppt/notesSlides/notesSlide1.xml':
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:notes xmlns:p="${NS_P}">` +
      `<p:cSld><p:spTree>Hier nicht erwähnen, dass der Vertrag noch nicht unterschrieben ist</p:spTree></p:cSld></p:notes>`,
    'ppt/commentAuthors.xml':
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:cmAuthorLst xmlns:p="${NS_P}">` +
      `<p:cmAuthor id="1" name="Dr. Beispiel" initials="DB"/></p:cmAuthorLst>`,
  })
}
