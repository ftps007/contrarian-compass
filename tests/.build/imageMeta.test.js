// lib/imageMeta.ts
var dec = new TextDecoder();
function ascii(bytes2, start, length) {
  return dec.decode(bytes2.subarray(start, start + length));
}
function detectFormat(bytes2) {
  if (bytes2.length < 12) return "unknown";
  if (bytes2[0] === 255 && bytes2[1] === 216) return "jpeg";
  if (bytes2[0] === 137 && ascii(bytes2, 1, 3) === "PNG") return "png";
  if (ascii(bytes2, 0, 3) === "GIF") return "gif";
  if (ascii(bytes2, 0, 4) === "RIFF" && ascii(bytes2, 8, 4) === "WEBP") return "webp";
  if (bytes2[0] === 73 && bytes2[1] === 73 || bytes2[0] === 77 && bytes2[1] === 77) return "tiff";
  if (bytes2[0] === 66 && bytes2[1] === 77) return "bmp";
  return "unknown";
}
var EXIF_TAGS = {
  271: "Kamera-Hersteller",
  272: "Kamera-Modell",
  305: "Software",
  306: "Aufnahmedatum",
  315: "Fotograf",
  33432: "Copyright"
};
var EXIF_SUB_TAGS = {
  36867: "Aufnahmedatum",
  42032: "Kamerabesitzer",
  42033: "Seriennummer der Kamera",
  42035: "Objektiv-Hersteller",
  42037: "Objektiv-Seriennummer"
};
var TYPE_SIZES = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };
function readTiff(bytes2, base) {
  const findings = [];
  if (base + 8 > bytes2.length) return findings;
  const little = bytes2[base] === 73 && bytes2[base + 1] === 73;
  const view = new DataView(bytes2.buffer, bytes2.byteOffset, bytes2.byteLength);
  const u16 = (o) => view.getUint16(o, little);
  const u32 = (o) => view.getUint32(o, little);
  if (u16(base + 2) !== 42) return findings;
  const readIfd = (offset, tags, depth) => {
    if (offset <= 0 || offset + 2 > bytes2.length || depth > 3) return;
    const count = u16(offset);
    if (count > 512) return;
    for (let i = 0; i < count; i++) {
      const entry = offset + 2 + i * 12;
      if (entry + 12 > bytes2.length) return;
      const tag = u16(entry);
      const type = u16(entry + 2);
      const num = u32(entry + 4);
      const size = (TYPE_SIZES[type] ?? 0) * num;
      const valueOffset = size > 4 ? base + u32(entry + 8) : entry + 8;
      if (tag === 34665) {
        readIfd(base + u32(entry + 8), EXIF_SUB_TAGS, depth + 1);
        continue;
      }
      if (tag === 34853) {
        findings.push({ label: "GPS-Position" });
        continue;
      }
      const name = tags[tag];
      if (!name) continue;
      let value;
      if (type === 2 && size > 0 && valueOffset + size <= bytes2.length) {
        value = ascii(bytes2, valueOffset, size).replace(/\0.*$/, "").trim() || void 0;
      }
      if (name && !findings.some((f) => f.label === name)) findings.push({ label: name, value });
    }
  };
  readIfd(base + u32(base + 4), EXIF_TAGS, 0);
  return findings;
}
function inspectImage(bytes2) {
  const format = detectFormat(bytes2);
  const findings = [];
  if (format === "jpeg") {
    let offset = 2;
    while (offset + 4 <= bytes2.length) {
      if (bytes2[offset] !== 255) break;
      const marker = bytes2[offset + 1];
      if (marker === 216 || marker === 1 || marker >= 208 && marker <= 215) {
        offset += 2;
        continue;
      }
      if (marker === 218 || marker === 217) break;
      const length = bytes2[offset + 2] << 8 | bytes2[offset + 3];
      const dataStart = offset + 4;
      if (marker === 225) {
        if (ascii(bytes2, dataStart, 6) === "Exif\0\0") {
          findings.push(...readTiff(bytes2, dataStart + 6));
        } else if (ascii(bytes2, dataStart, 28).startsWith("http://ns.adobe.com/xap")) {
          findings.push({ label: "XMP-Block (Bearbeitungsverlauf)" });
        }
      } else if (marker === 237) {
        findings.push({ label: "IPTC-Block (Bildagentur-Daten)" });
      } else if (marker === 254) {
        findings.push({ label: "JPEG-Kommentar" });
      }
      offset += 2 + length;
    }
  } else if (format === "png") {
    let offset = 8;
    const view = new DataView(bytes2.buffer, bytes2.byteOffset, bytes2.byteLength);
    while (offset + 8 <= bytes2.length) {
      const length = view.getUint32(offset);
      const type = ascii(bytes2, offset + 4, 4);
      if (type === "eXIf") findings.push(...readTiff(bytes2, offset + 8));
      else if (type === "tEXt" || type === "zTXt") findings.push({ label: "PNG-Textfeld" });
      else if (type === "iTXt") findings.push({ label: "XMP-Block (Bearbeitungsverlauf)" });
      else if (type === "tIME") findings.push({ label: "\xC4nderungszeitstempel im Bild" });
      if (type === "IEND") break;
      offset += 12 + length;
    }
  } else if (format === "tiff") {
    findings.push(...readTiff(bytes2, 0));
  } else if (format === "webp" || format === "gif") {
    if (stripImageMetadata(bytes2).length !== bytes2.length) {
      findings.push({ label: "Eingebettete Metadaten" });
    }
  }
  const seen = /* @__PURE__ */ new Set();
  return findings.filter((f) => seen.has(f.label) ? false : (seen.add(f.label), true));
}
function concat(chunks) {
  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}
var PNG_KEEP = /* @__PURE__ */ new Set(["IHDR", "PLTE", "IDAT", "IEND", "tRNS", "gAMA", "cHRM", "sRGB", "iCCP", "bKGD", "pHYs", "sBIT", "hIST", "sPLT"]);
function stripImageMetadata(bytes2) {
  switch (detectFormat(bytes2)) {
    case "jpeg":
      return stripJpeg(bytes2);
    case "png":
      return stripPng(bytes2);
    case "webp":
      return stripWebp(bytes2);
    case "gif":
      return stripGif(bytes2);
    default:
      return bytes2;
  }
}
function stripJpeg(bytes2) {
  const out = [bytes2.subarray(0, 2)];
  let offset = 2;
  while (offset + 4 <= bytes2.length) {
    if (bytes2[offset] !== 255) break;
    const marker = bytes2[offset + 1];
    if (marker === 1 || marker >= 208 && marker <= 215) {
      out.push(bytes2.subarray(offset, offset + 2));
      offset += 2;
      continue;
    }
    if (marker === 218) {
      out.push(bytes2.subarray(offset));
      return concat(out);
    }
    const length = bytes2[offset + 2] << 8 | bytes2[offset + 3];
    const segment = bytes2.subarray(offset, offset + 2 + length);
    const dataStart = offset + 4;
    const isExifOrXmp = marker === 225;
    const isIptc = marker === 237;
    const isComment = marker === 254;
    const isIcc = marker === 226 && ascii(bytes2, dataStart, 11) === "ICC_PROFILE";
    const isJfif = marker === 224;
    const isOtherApp = marker >= 224 && marker <= 239 && !isJfif && !isIcc;
    if (!isExifOrXmp && !isIptc && !isComment && !isOtherApp) out.push(segment);
    offset += 2 + length;
  }
  return concat(out);
}
function stripPng(bytes2) {
  const view = new DataView(bytes2.buffer, bytes2.byteOffset, bytes2.byteLength);
  const out = [bytes2.subarray(0, 8)];
  let offset = 8;
  while (offset + 12 <= bytes2.length) {
    const length = view.getUint32(offset);
    const type = ascii(bytes2, offset + 4, 4);
    const end = offset + 12 + length;
    if (PNG_KEEP.has(type)) out.push(bytes2.subarray(offset, end));
    if (type === "IEND") break;
    offset = end;
  }
  return concat(out);
}
function stripWebp(bytes2) {
  const view = new DataView(bytes2.buffer, bytes2.byteOffset, bytes2.byteLength);
  const kept = [];
  let offset = 12;
  let sawMetadata = false;
  while (offset + 8 <= bytes2.length) {
    const fourcc = ascii(bytes2, offset, 4);
    const size = view.getUint32(offset + 4, true);
    const padded = size + size % 2;
    const chunk = bytes2.subarray(offset, offset + 8 + padded);
    if (fourcc === "EXIF" || fourcc === "XMP ") sawMetadata = true;
    else kept.push(chunk);
    offset += 8 + padded;
  }
  if (!sawMetadata) return bytes2;
  const body = concat(kept);
  if (ascii(body, 0, 4) === "VP8X" && body.length > 12) body[8] &= ~12;
  const out = new Uint8Array(12 + body.length);
  out.set(bytes2.subarray(0, 12));
  out.set(body, 12);
  new DataView(out.buffer).setUint32(4, out.length - 8, true);
  return out;
}
function stripGif(bytes2) {
  let offset = 13;
  if (bytes2[10] & 128) offset += 3 * (1 << (bytes2[10] & 7) + 1);
  const out = [bytes2.subarray(0, offset)];
  let changed = false;
  const skipBlocks = (start) => {
    let position = start;
    while (position < bytes2.length && bytes2[position] !== 0) position += bytes2[position] + 1;
    return position + 1;
  };
  while (offset < bytes2.length) {
    const marker = bytes2[offset];
    if (marker === 59) {
      out.push(bytes2.subarray(offset, offset + 1));
      break;
    }
    if (marker === 33) {
      const label = bytes2[offset + 1];
      const end = skipBlocks(offset + 2);
      if (label === 254 || label === 255) changed = true;
      else out.push(bytes2.subarray(offset, end));
      offset = end;
      continue;
    }
    if (marker === 44) {
      let position = offset + 10;
      if (bytes2[offset + 9] & 128) position += 3 * (1 << (bytes2[offset + 9] & 7) + 1);
      position = skipBlocks(position + 1);
      out.push(bytes2.subarray(offset, position));
      offset = position;
      continue;
    }
    break;
  }
  return changed ? concat(out) : bytes2;
}

// tests/helpers.ts
var test = (name, fn) => __test(name, fn);
function assert(condition, message) {
  if (!condition) throw new Error(message);
}
function equal(actual, expected, message) {
  if (actual !== expected) throw new Error(`${message}
  erwartet: ${String(expected)}
  bekommen: ${String(actual)}`);
}
function includes(haystack, needle, message) {
  if (!haystack.includes(needle)) throw new Error(`${message}
  "${needle}" fehlt in: ${haystack.slice(0, 200)}\u2026`);
}
function excludes(haystack, needle, message) {
  if (haystack.includes(needle)) throw new Error(`${message}
  "${needle}" ist noch enthalten`);
}
var encoder = new TextEncoder();
var bytes = (text) => encoder.encode(text);
function concatBytes(chunks) {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}
function exifBlock() {
  const entries = [];
  const strings = [];
  const ifd0Tags = [
    { tag: 271, text: "ACME Cameras" },
    { tag: 272, text: "X-1000" },
    { tag: 305, text: "Bildbearbeitung 3.0" },
    { tag: 306, text: "2024:02:01 10:00:00" },
    { tag: 315, text: "Max Mustermann" }
  ];
  const exifSub = [{ tag: 42033, text: "SN-12345678" }];
  const ifd0Count = ifd0Tags.length + 2;
  const ifd0Start = 8;
  const ifd0Size = 2 + ifd0Count * 12 + 4;
  const subStart = ifd0Start + ifd0Size;
  const subSize = 2 + exifSub.length * 12 + 4;
  const gpsStart = subStart + subSize;
  const gpsSize = 2 + 1 * 12 + 4;
  let valueOffset = gpsStart + gpsSize;
  for (const { tag, text } of ifd0Tags) {
    const padded = text + "\0";
    strings.push({ offset: valueOffset, text: padded });
    entries.push({ tag, type: 2, count: padded.length, value: valueOffset });
    valueOffset += padded.length + padded.length % 2;
  }
  const serial = exifSub[0].text + "\0";
  const serialOffset = valueOffset;
  const total = valueOffset + serial.length;
  const buffer = new Uint8Array(total);
  const view = new DataView(buffer.buffer);
  const enc = new TextEncoder();
  buffer[0] = 77;
  buffer[1] = 77;
  view.setUint16(2, 42);
  view.setUint32(4, ifd0Start);
  view.setUint16(ifd0Start, ifd0Count);
  entries.forEach((entry, index) => {
    const at2 = ifd0Start + 2 + index * 12;
    view.setUint16(at2, entry.tag);
    view.setUint16(at2 + 2, entry.type);
    view.setUint32(at2 + 4, entry.count);
    view.setUint32(at2 + 8, entry.value);
  });
  let at = ifd0Start + 2 + entries.length * 12;
  view.setUint16(at, 34665);
  view.setUint16(at + 2, 4);
  view.setUint32(at + 4, 1);
  view.setUint32(at + 8, subStart);
  at += 12;
  view.setUint16(at, 34853);
  view.setUint16(at + 2, 4);
  view.setUint32(at + 4, 1);
  view.setUint32(at + 8, gpsStart);
  view.setUint32(ifd0Start + 2 + ifd0Count * 12, 0);
  view.setUint16(subStart, exifSub.length);
  view.setUint16(subStart + 2, exifSub[0].tag);
  view.setUint16(subStart + 4, 2);
  view.setUint32(subStart + 6, serial.length);
  view.setUint32(subStart + 10, serialOffset);
  view.setUint32(subStart + 2 + 12, 0);
  view.setUint16(gpsStart, 1);
  view.setUint16(gpsStart + 2, 1);
  view.setUint16(gpsStart + 4, 2);
  view.setUint32(gpsStart + 6, 2);
  buffer.set(enc.encode("N\0"), gpsStart + 10);
  view.setUint32(gpsStart + 2 + 12, 0);
  for (const { offset, text } of strings) buffer.set(enc.encode(text), offset);
  buffer.set(enc.encode(serial), serialOffset);
  return buffer;
}
function jpegSegment(marker, payload) {
  const out = new Uint8Array(4 + payload.length);
  out[0] = 255;
  out[1] = marker;
  out[2] = payload.length + 2 >> 8 & 255;
  out[3] = payload.length + 2 & 255;
  out.set(payload, 4);
  return out;
}
function jpegWithMetadata() {
  const exif = concatBytes([bytes("Exif\0\0"), exifBlock()]);
  const xmp = bytes("http://ns.adobe.com/xap/1.0/\0<x:xmpmeta>Bearbeitet von Max</x:xmpmeta>");
  const iptc = bytes("Photoshop 3.0\0IPTC-Daten");
  const jfif = bytes("JFIF\0\0\0\0\0\0");
  const icc = concatBytes([bytes("ICC_PROFILE\0"), new Uint8Array([1, 1, 0, 0])]);
  return concatBytes([
    new Uint8Array([255, 216]),
    jpegSegment(224, jfif),
    jpegSegment(225, exif),
    jpegSegment(225, xmp),
    jpegSegment(226, icc),
    jpegSegment(237, iptc),
    jpegSegment(254, bytes("Internes Foto, nicht weitergeben")),
    jpegSegment(219, new Uint8Array(64).fill(16)),
    // quantisation table
    new Uint8Array([255, 218, 0, 8, 1, 1, 0, 0, 63, 0]),
    // SOS
    new Uint8Array([18, 52, 86, 120]),
    // "pixel data"
    new Uint8Array([255, 217])
  ]);
}
function crc32(buf) {
  let c = 4294967295;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = c & 1 ? 3988292384 ^ c >>> 1 : c >>> 1;
  }
  return (c ^ 4294967295) >>> 0;
}
function pngChunk(type, data) {
  const body = concatBytes([bytes(type), data]);
  const out = new Uint8Array(8 + data.length + 4);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(body, 4);
  view.setUint32(8 + data.length, crc32(body));
  return out;
}
function pngWithMetadata() {
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, 1);
  view.setUint32(4, 1);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return concatBytes([
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", ihdr),
    pngChunk("tEXt", bytes("Author\0Max Mustermann")),
    pngChunk("iTXt", bytes("XML:com.adobe.xmp\0\0\0\0\0<x:xmpmeta/>")),
    pngChunk("eXIf", exifBlock()),
    pngChunk("tIME", new Uint8Array([7, 232, 2, 1, 10, 0, 0])),
    pngChunk("pHYs", new Uint8Array([0, 0, 11, 19, 0, 0, 11, 19, 1])),
    pngChunk("IDAT", new Uint8Array([120, 156, 98, 0, 0, 0, 2, 0, 1])),
    pngChunk("IEND", new Uint8Array(0))
  ]);
}

// tests/imageMeta.test.ts
var asText = (bytes2) => new TextDecoder("latin1").decode(bytes2);
var labels = (bytes2) => inspectImage(bytes2).map((f) => f.label);
await test("JPEG wird erkannt und vollst\xE4ndig ausgelesen", () => {
  const jpeg = jpegWithMetadata();
  equal(detectFormat(jpeg), "jpeg", "Format nicht erkannt");
  const found = labels(jpeg);
  for (const expected of [
    "Kamera-Hersteller",
    "Kamera-Modell",
    "Software",
    "Aufnahmedatum",
    "Fotograf",
    "GPS-Position",
    "Seriennummer der Kamera",
    "XMP-Block (Bearbeitungsverlauf)",
    "IPTC-Block (Bildagentur-Daten)",
    "JPEG-Kommentar"
  ]) {
    assert(found.includes(expected), `"${expected}" nicht gefunden, nur: ${found.join(", ")}`);
  }
  const details = inspectImage(jpeg);
  equal(details.find((f) => f.label === "Kamera-Modell")?.value, "X-1000", "Modell falsch gelesen");
  equal(details.find((f) => f.label === "Fotograf")?.value, "Max Mustermann", "Fotograf falsch gelesen");
});
await test("JPEG-Bereinigung entfernt alle Metadaten, beh\xE4lt Bilddaten und ICC", () => {
  const jpeg = jpegWithMetadata();
  const cleaned = stripImageMetadata(jpeg);
  const text = asText(cleaned);
  excludes(text, "Max Mustermann", "Fotograf noch enthalten");
  excludes(text, "ACME Cameras", "Kamera noch enthalten");
  excludes(text, "SN-12345678", "Seriennummer noch enthalten");
  excludes(text, "xmpmeta", "XMP noch enthalten");
  excludes(text, "IPTC-Daten", "IPTC noch enthalten");
  excludes(text, "nicht weitergeben", "Kommentar noch enthalten");
  includes(text, "ICC_PROFILE", "ICC-Profil wurde f\xE4lschlich entfernt");
  includes(text, "JFIF", "JFIF-Header wurde f\xE4lschlich entfernt");
  equal(labels(cleaned).length, 0, "Nach der Bereinigung wird noch etwas gefunden");
  assert(cleaned.length < jpeg.length, "Datei wurde nicht kleiner");
  const sos = (b) => {
    for (let i = 2; i < b.length - 1; i++) if (b[i] === 255 && b[i + 1] === 218) return b.subarray(i);
    throw new Error("kein SOS gefunden");
  };
  const before = sos(jpeg);
  const after = sos(cleaned);
  equal(after.length, before.length, "Bilddaten haben andere L\xE4nge");
  for (let i = 0; i < before.length; i++) equal(after[i], before[i], `Bilddaten unterscheiden sich bei Byte ${i}`);
});
await test("PNG-Bereinigung entfernt Text-, XMP-, EXIF- und Zeitchunks", () => {
  const png = pngWithMetadata();
  const found = labels(png);
  assert(found.includes("PNG-Textfeld"), `tEXt nicht erkannt: ${found.join(", ")}`);
  assert(found.includes("XMP-Block (Bearbeitungsverlauf)"), "iTXt nicht erkannt");
  assert(found.includes("GPS-Position"), "eXIf-GPS nicht erkannt");
  assert(found.includes("\xC4nderungszeitstempel im Bild"), "tIME nicht erkannt");
  const cleaned = stripImageMetadata(png);
  const text = asText(cleaned);
  excludes(text, "Max Mustermann", "tEXt noch enthalten");
  excludes(text, "xmpmeta", "iTXt noch enthalten");
  excludes(text, "eXIf", "eXIf-Chunk noch enthalten");
  excludes(text, "tIME", "tIME-Chunk noch enthalten");
  includes(text, "IHDR", "IHDR fehlt");
  includes(text, "IDAT", "IDAT fehlt");
  includes(text, "IEND", "IEND fehlt");
  includes(text, "pHYs", "pHYs wurde f\xE4lschlich entfernt");
  equal(labels(cleaned).length, 0, "Nach der Bereinigung wird noch etwas gefunden");
});
await test("Bilder ohne Metadaten bleiben unver\xE4ndert", () => {
  const clean = stripImageMetadata(pngWithMetadata());
  const again = stripImageMetadata(clean);
  equal(again.length, clean.length, "Zweiter Durchlauf \xE4ndert die Datei");
});
await test("Unbekannte Formate werden unver\xE4ndert durchgereicht", () => {
  const junk = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  equal(detectFormat(junk), "unknown", "Format f\xE4lschlich erkannt");
  equal(stripImageMetadata(junk), junk, "Unbekanntes Format wurde ver\xE4ndert");
});
