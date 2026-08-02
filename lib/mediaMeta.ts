/**
 * Audio and video containers.
 *
 * MP3: ID3v2 at the front, ID3v1 in the last 128 bytes — both are cut off.
 * MP4/M4A/MOV: the tags sit in `udta`, `meta` and XMP `uuid` boxes. Those are
 * overwritten with a same-sized `free` box instead of being cut out, because
 * the sample tables store absolute file offsets that would otherwise all shift.
 */

// Box names and tag payloads are byte-oriented: MP4 writes the copyright sign
// of tags like ©nam as the single byte 0xA9, which is not valid UTF-8.
const dec = new TextDecoder('latin1')
const fourcc = (bytes: Uint8Array, at: number) => dec.decode(bytes.subarray(at, at + 4))

export type MediaFormat = 'mp3' | 'mp4' | 'unknown'

export interface MediaFinding {
  label: string
  value?: string
}

export function detectMedia(bytes: Uint8Array): MediaFormat {
  if (bytes.length > 12 && fourcc(bytes, 4) === 'ftyp') return 'mp4'
  if (bytes.length > 10 && dec.decode(bytes.subarray(0, 3)) === 'ID3') return 'mp3'
  if (bytes.length > 2 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) return 'mp3'
  return 'unknown'
}

/** ID3v2 sizes are stored with seven bits per byte. */
function syncSafe(bytes: Uint8Array, at: number): number {
  return (bytes[at] << 21) | (bytes[at + 1] << 14) | (bytes[at + 2] << 7) | bytes[at + 3]
}

function id3v2Length(bytes: Uint8Array): number {
  if (bytes.length < 10 || dec.decode(bytes.subarray(0, 3)) !== 'ID3') return 0
  const footer = (bytes[5] & 0x10) !== 0 ? 10 : 0
  return 10 + syncSafe(bytes, 6) + footer
}

const hasId3v1 = (bytes: Uint8Array) =>
  bytes.length > 128 && dec.decode(bytes.subarray(bytes.length - 128, bytes.length - 125)) === 'TAG'

export function inspectMedia(bytes: Uint8Array): MediaFinding[] {
  const findings: MediaFinding[] = []
  const format = detectMedia(bytes)

  if (format === 'mp3') {
    const length = id3v2Length(bytes)
    if (length > 0) {
      findings.push({ label: 'ID3v2-Tag', value: `${Math.round(length / 1024)} KB` })
      // TPE1/TCOM etc. can name a person; report the free-text comment frames.
      const head = dec.decode(bytes.subarray(0, Math.min(length, 4096)))
      if (/TPE1|TCOM|TOPE/.test(head)) findings.push({ label: 'Interpret-/Urheberangaben' })
      if (/COMM|TXXX/.test(head)) findings.push({ label: 'Freitext-Kommentare' })
      if (/PRIV/.test(head)) findings.push({ label: 'Programmspezifische Daten (PRIV)' })
    }
    if (hasId3v1(bytes)) findings.push({ label: 'ID3v1-Tag' })
    return findings
  }

  if (format === 'mp4') {
    for (const box of findBoxes(bytes)) {
      if (box.type === 'udta') findings.push({ label: 'Benutzerdaten (udta)' })
      else if (box.type === 'meta') findings.push({ label: 'Metadaten-Box (meta)' })
      else if (box.type === 'uuid') findings.push({ label: 'XMP-Block' })
      const text = dec.decode(bytes.subarray(box.start, Math.min(box.end, box.start + 2048)))
      if (/©xyz|loci/.test(text)) findings.push({ label: 'GPS-Position' })
      if (/©too|©swr/.test(text)) findings.push({ label: 'Aufnahme-Software' })
    }
    const seen = new Set<string>()
    return findings.filter((f) => (seen.has(f.label) ? false : (seen.add(f.label), true)))
  }

  return findings
}

interface Box {
  type: string
  start: number
  end: number
  headerSize: number
}

/** Top-level boxes plus the children of moov, which is where the tags live. */
function findBoxes(bytes: Uint8Array): Box[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const boxes: Box[] = []

  const walk = (from: number, to: number, depth: number): void => {
    let offset = from
    while (offset + 8 <= to) {
      let size = view.getUint32(offset)
      let headerSize = 8
      if (size === 1) {
        if (offset + 16 > to) break
        // 64-bit size: the high word is always 0 for files we can hold anyway.
        size = Number(view.getBigUint64(offset + 8))
        headerSize = 16
      } else if (size === 0) {
        size = to - offset
      }
      if (size < headerSize || offset + size > to) break

      const type = fourcc(bytes, offset + 4)
      boxes.push({ type, start: offset, end: offset + size, headerSize })
      if ((type === 'moov' || type === 'trak' || type === 'mdia') && depth < 3) {
        walk(offset + headerSize, offset + size, depth + 1)
      }
      offset += size
    }
  }

  walk(0, bytes.length, 0)
  return boxes
}

export function stripMediaMetadata(bytes: Uint8Array): Uint8Array {
  const format = detectMedia(bytes)

  if (format === 'mp3') {
    const start = id3v2Length(bytes)
    const end = hasId3v1(bytes) ? bytes.length - 128 : bytes.length
    if (start === 0 && end === bytes.length) return bytes
    return bytes.slice(start, end)
  }

  if (format === 'mp4') {
    const boxes = findBoxes(bytes).filter((b) => b.type === 'udta' || b.type === 'meta' || b.type === 'uuid')
    // Skip a 'meta' that is itself inside a box we already blank out.
    const outer = boxes.filter((box) => !boxes.some((other) => other !== box && box.start > other.start && box.end <= other.end))
    if (outer.length === 0) return bytes

    const out = bytes.slice()
    const view = new DataView(out.buffer, out.byteOffset, out.byteLength)
    for (const box of outer) {
      out.fill(0, box.start + 8, box.end)
      view.setUint32(box.start, box.end - box.start)
      out.set(new TextEncoder().encode('free'), box.start + 4)
    }
    return out
  }

  return bytes
}
