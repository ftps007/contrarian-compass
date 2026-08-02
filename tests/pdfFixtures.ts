/**
 * Hand-written PDFs. Built as text with real byte offsets so the cross
 * reference table is genuine — the cleaner has to survive a correct file, and
 * the tests have to be able to check the one it writes.
 */

const encoder = new TextEncoder()

interface Obj {
  num: number
  body: string
}

function assemble(objects: Obj[], trailerExtra: string, prefix = '%PDF-1.7\n'): string {
  let out = prefix
  const offsets = new Map<number, number>()
  for (const object of objects) {
    offsets.set(object.num, out.length)
    out += `${object.num} 0 obj\n${object.body}\nendobj\n`
  }
  const size = Math.max(...objects.map((o) => o.num)) + 1
  const xref = out.length
  out += `xref\n0 ${size}\n0000000000 65535 f \n`
  for (let i = 1; i < size; i++) {
    const at = offsets.get(i)
    out += at === undefined ? '0000000000 65535 f \n' : `${String(at).padStart(10, '0')} 00000 n \n`
  }
  out += `trailer\n<< /Size ${size} ${trailerExtra} >>\nstartxref\n${xref}\n%%EOF\n`
  return out
}

const CONTENT = 'BT /F1 24 Tf 72 700 Td (Sichtbarer Seitentext) Tj ET'

const baseObjects = (infoTitle: string, infoAuthor: string): Obj[] => [
  { num: 1, body: '<< /Type /Catalog /Pages 2 0 R >>' },
  { num: 2, body: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>' },
  { num: 3, body: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 6 0 R >> >> >>' },
  { num: 4, body: `<< /Length ${CONTENT.length} >>\nstream\n${CONTENT}\nendstream` },
  { num: 5, body: `<< /Title (${infoTitle}) /Author (${infoAuthor}) /Producer (Testprogramm 1.0) /CreationDate (D:20240201100000Z) >>` },
  { num: 6, body: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>' },
]

/** One revision, one page, a filled Info dictionary. */
export function simplePdf(): Uint8Array {
  return encoder.encode(assemble(baseObjects('Interner Entwurf', 'Max Mustermann'), '/Root 1 0 R /Info 5 0 R'))
}

/**
 * Two revisions: the visible title is harmless, but the first revision — with
 * the real author and a paragraph that was later removed — is still in the
 * file and recoverable.
 */
export function incrementalPdf(): Uint8Array {
  const first = assemble(
    [
      ...baseObjects('Geheimer Erstentwurf', 'Max Mustermann'),
      { num: 7, body: '<< /Length 44 >>\nstream\nBT (Dieser Absatz wurde geloescht) Tj ET\nendstream' },
    ],
    '/Root 1 0 R /Info 5 0 R'
  )

  // Incremental update: a new Info object appended after the first %%EOF.
  const updateStart = first.length
  const newInfo = `5 0 obj\n<< /Title (Freigegebene Fassung) /Producer (Testprogramm 1.0) >>\nendobj\n`
  const xref = updateStart + newInfo.length
  const update =
    newInfo +
    `xref\n0 1\n0000000000 65535 f \n5 1\n${String(updateStart).padStart(10, '0')} 00000 n \n` +
    `trailer\n<< /Size 8 /Root 1 0 R /Info 5 0 R /Prev 0 >>\nstartxref\n${xref}\n%%EOF\n`

  return encoder.encode(first + update)
}

/** Objects packed into an object stream, as produced by modern writers. */
export function objectStreamPdf(): Uint8Array {
  const packed = [
    { num: 1, body: '<< /Type /Catalog /Pages 2 0 R >>' },
    { num: 2, body: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>' },
    {
      num: 3,
      body: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>',
    },
  ]

  let payload = ''
  const pairs: string[] = []
  for (const object of packed) {
    pairs.push(`${object.num} ${payload.length}`)
    payload += object.body + ' '
  }
  const header = pairs.join(' ') + '\n'
  const streamData = header + payload

  return encoder.encode(
    assemble(
      [
        { num: 4, body: `<< /Length ${CONTENT.length} >>\nstream\n${CONTENT}\nendstream` },
        {
          num: 7,
          body: `<< /Type /ObjStm /N ${packed.length} /First ${header.length} /Length ${streamData.length} >>\nstream\n${streamData}\nendstream`,
        },
      ],
      '/Root 1 0 R'
    )
  )
}

/** Carries an attachment and a script — both should be reported and removed. */
export function pdfWithExtras(): Uint8Array {
  return encoder.encode(
    assemble(
      [
        { num: 1, body: '<< /Type /Catalog /Pages 2 0 R /Names << /EmbeddedFiles 8 0 R >> /OpenAction << /S /JavaScript /JS (app.alert\\("hallo"\\)) >> >>' },
        { num: 2, body: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>' },
        { num: 3, body: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Annots [9 0 R] >>' },
        { num: 4, body: `<< /Length ${CONTENT.length} >>\nstream\n${CONTENT}\nendstream` },
        { num: 5, body: '<< /Title (Mit Anhang) /Author (Max Mustermann) >>' },
        { num: 8, body: '<< /Names [(anhang.txt) 10 0 R] >>' },
        { num: 9, body: '<< /Type /Annot /Subtype /FileAttachment /T (Max Mustermann) /FS 10 0 R >>' },
        { num: 10, body: '<< /Type /Filespec /F (anhang.txt) /EF << /F 11 0 R >> >>' },
        { num: 11, body: '<< /Type /EmbeddedFile /Length 28 >>\nstream\nGeheime Anhangsdaten hier!!!\nendstream' },
      ],
      '/Root 1 0 R /Info 5 0 R'
    )
  )
}

export function encryptedPdf(): Uint8Array {
  return encoder.encode(
    assemble(
      [
        { num: 1, body: '<< /Type /Catalog /Pages 2 0 R >>' },
        { num: 2, body: '<< /Type /Pages /Kids [] /Count 0 >>' },
        { num: 9, body: '<< /Filter /Standard /V 2 /R 3 /Length 128 >>' },
      ],
      '/Root 1 0 R /Encrypt 9 0 R'
    )
  )
}

/** Independent structural check of a cross-reference table. */
export function verifyXref(bytes: Uint8Array): string {
  const text = new TextDecoder('latin1').decode(bytes)
  if (!text.startsWith('%PDF-')) return 'kein PDF-Header'
  const startxref = Number(/startxref\s+(\d+)\s*%%EOF\s*$/.exec(text)?.[1] ?? -1)
  if (startxref < 0) return 'kein startxref am Dateiende'
  const table = text.slice(startxref)
  if (!table.startsWith('xref')) return 'startxref zeigt nicht auf die Tabelle'
  const header = /^xref\s+0\s+(\d+)\s/.exec(table)
  if (!header) return 'Tabellenkopf unlesbar'
  const entries = Array.from(table.matchAll(/(\d{10}) (\d{5}) ([nf])/g))
  if (entries.length !== Number(header[1])) return `Tabelle hat ${entries.length} Einträge, Kopf sagt ${header[1]}`
  for (let i = 1; i < entries.length; i++) {
    if (entries[i][3] !== 'n') continue
    const at = Number(entries[i][1])
    if (!new RegExp(`^${i} 0 obj`).test(text.slice(at, at + 24))) {
      return `Eintrag ${i} zeigt auf "${text.slice(at, at + 20)}"`
    }
  }
  return 'ok'
}
