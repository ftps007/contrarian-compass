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
      const entry2 = offset + 2 + i * 12;
      if (entry2 + 12 > bytes2.length) return;
      const tag = u16(entry2);
      const type = u16(entry2 + 2);
      const num = u32(entry2 + 4);
      const size = (TYPE_SIZES[type] ?? 0) * num;
      const valueOffset = size > 4 ? base + u32(entry2 + 8) : entry2 + 8;
      if (tag === 34665) {
        readIfd(base + u32(entry2 + 8), EXIF_SUB_TAGS, depth + 1);
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

// lib/imageCrop.ts
var MIME = {
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp"
};
function canFlattenCrops() {
  return typeof createImageBitmap === "function" && typeof OffscreenCanvas === "function";
}
async function flattenCrop(bytes2, rect) {
  if (!canFlattenCrops()) return null;
  const mime = MIME[detectFormat(bytes2)];
  if (!mime) return null;
  const keptWidth = 1 - rect.left - rect.right;
  const keptHeight = 1 - rect.top - rect.bottom;
  if (keptWidth <= 0 || keptHeight <= 0 || keptWidth > 0.999 && keptHeight > 0.999) return null;
  try {
    const bitmap = await createImageBitmap(new Blob([bytes2], { type: mime }));
    const width = Math.max(1, Math.round(bitmap.width * keptWidth));
    const height = Math.max(1, Math.round(bitmap.height * keptHeight));
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext("2d");
    if (!context) return null;
    context.drawImage(
      bitmap,
      Math.round(bitmap.width * rect.left),
      Math.round(bitmap.height * rect.top),
      Math.round(bitmap.width * keptWidth),
      Math.round(bitmap.height * keptHeight),
      0,
      0,
      width,
      height
    );
    bitmap.close();
    const blob = await canvas.convertToBlob({ type: mime, quality: 0.92 });
    return new Uint8Array(await blob.arrayBuffer());
  } catch {
    return null;
  }
}

// lib/ooxmlPackage.ts
var NS = {
  cp: "http://schemas.openxmlformats.org/package/2006/metadata/core-properties",
  dc: "http://purl.org/dc/elements/1.1/",
  dcterms: "http://purl.org/dc/terms/",
  dcmitype: "http://purl.org/dc/dcmitype/",
  xsi: "http://www.w3.org/2001/XMLSchema-instance",
  ep: "http://schemas.openxmlformats.org/officeDocument/2006/extended-properties",
  vt: "http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes",
  ct: "http://schemas.openxmlformats.org/package/2006/content-types",
  rel: "http://schemas.openxmlformats.org/package/2006/relationships",
  custom: "http://schemas.openxmlformats.org/officeDocument/2006/custom-properties",
  w: "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
  r: "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
  sheet: "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
  p: "http://schemas.openxmlformats.org/presentationml/2006/main",
  chart: "http://schemas.openxmlformats.org/drawingml/2006/chart"
};
var CONTENT_TYPES = "[Content_Types].xml";
var decoder = new TextDecoder();
var encoder = new TextEncoder();
function findEntry(entries, name) {
  return entries.find((e) => e.name === name);
}
function textOf(entries, name) {
  const entry2 = findEntry(entries, name);
  return entry2 ? decoder.decode(entry2.data) : void 0;
}
var decodeText = (data) => decoder.decode(data);
var encodeText = (text) => encoder.encode(text);
function setText(entries, name, xml) {
  const entry2 = findEntry(entries, name);
  if (entry2) {
    entry2.data = encoder.encode(xml);
  } else {
    entries.push({ name, data: encoder.encode(xml), method: 8, dosTime: 0, dosDate: 33, externalAttr: 0 });
  }
}
function parseXml(xml, label) {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  if (doc.getElementsByTagName("parsererror").length > 0) {
    throw new Error(`XML konnte nicht gelesen werden: ${label}`);
  }
  return doc;
}
function serializeXml(doc) {
  const xml = new XMLSerializer().serializeToString(doc);
  if (xml.startsWith("<?xml")) return xml;
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n' + xml;
}
function editParts(entries, matches, edit) {
  const touched = [];
  for (const entry2 of entries) {
    if (!matches(entry2.name)) continue;
    const xml = decoder.decode(entry2.data);
    const next = edit(xml, entry2.name);
    if (next !== xml) {
      entry2.data = encoder.encode(next);
      touched.push(entry2.name);
    }
  }
  return touched;
}
function resolveTarget(relsPath, target) {
  if (target.startsWith("/")) return target.slice(1);
  const base = relsPath.replace(/_rels\/[^/]+$/, "");
  const segments = (base + target).split("/");
  const out = [];
  for (const segment of segments) {
    if (segment === "." || segment === "") continue;
    if (segment === "..") out.pop();
    else out.push(segment);
  }
  return out.join("/");
}
function relsPathFor(partName) {
  const slash = partName.lastIndexOf("/");
  const dir = slash < 0 ? "" : partName.slice(0, slash + 1);
  const file = slash < 0 ? partName : partName.slice(slash + 1);
  return `${dir}_rels/${file}.rels`;
}
function removeParts(entries, predicate) {
  const removed = entries.filter((e) => predicate(e.name)).map((e) => e.name);
  if (removed.length === 0) return [];
  const withRels = new Set(removed);
  for (const name of removed) {
    const rels2 = relsPathFor(name);
    if (findEntry(entries, rels2)) withRels.add(rels2);
  }
  for (const name of Array.from(withRels)) {
    const index = entries.findIndex((e) => e.name === name);
    if (index >= 0) entries.splice(index, 1);
  }
  const typesXml = textOf(entries, CONTENT_TYPES);
  if (typesXml) {
    const doc = parseXml(typesXml, CONTENT_TYPES);
    for (const override2 of Array.from(doc.getElementsByTagNameNS(NS.ct, "Override"))) {
      const partName = (override2.getAttribute("PartName") ?? "").replace(/^\//, "");
      if (withRels.has(partName)) override2.parentNode?.removeChild(override2);
    }
    setText(entries, CONTENT_TYPES, serializeXml(doc));
  }
  for (const entry2 of entries.filter((e) => e.name.endsWith(".rels"))) {
    const doc = parseXml(decoder.decode(entry2.data), entry2.name);
    let changed = false;
    for (const rel2 of Array.from(doc.getElementsByTagNameNS(NS.rel, "Relationship"))) {
      if (rel2.getAttribute("TargetMode") === "External") continue;
      if (withRels.has(resolveTarget(entry2.name, rel2.getAttribute("Target") ?? ""))) {
        rel2.parentNode?.removeChild(rel2);
        changed = true;
      }
    }
    if (changed) entry2.data = encoder.encode(serializeXml(doc));
  }
  return removed;
}
function removePartsAndReferences(entries, predicate) {
  const doomed = new Set(entries.filter((e) => predicate(e.name)).map((e) => e.name));
  if (doomed.size === 0) return [];
  const danglingByOwner = /* @__PURE__ */ new Map();
  for (const entry2 of entries.filter((e) => e.name.endsWith(".rels"))) {
    const ids2 = [];
    for (const rel2 of readRelationships(entries, entry2.name)) {
      if (rel2.external) continue;
      if (doomed.has(resolveTarget(entry2.name, rel2.target))) ids2.push(rel2.id);
    }
    if (ids2.length === 0) continue;
    const owner = entry2.name.replace(/_rels\/([^/]+)\.rels$/, "$1");
    danglingByOwner.set(owner, ids2);
  }
  const removed = removeParts(entries, predicate);
  for (const [owner, ids2] of Array.from(danglingByOwner.entries())) {
    const entry2 = findEntry(entries, owner);
    if (!entry2) continue;
    let xml = decoder.decode(entry2.data);
    for (const id of ids2) {
      xml = xml.replace(new RegExp(`<[^<>]*r:(?:id|embed)="${id}"[^<>]*/>`, "g"), "");
      xml = xml.replace(new RegExp(`\\sr:(?:id|embed)="${id}"`, "g"), "");
    }
    entry2.data = encoder.encode(xml);
  }
  return removed;
}
function readRelationships(entries, relsPath) {
  const xml = textOf(entries, relsPath);
  if (!xml) return [];
  const doc = parseXml(xml, relsPath);
  return Array.from(doc.getElementsByTagNameNS(NS.rel, "Relationship")).map((rel2) => ({
    id: rel2.getAttribute("Id") ?? "",
    type: rel2.getAttribute("Type") ?? "",
    target: rel2.getAttribute("Target") ?? "",
    external: rel2.getAttribute("TargetMode") === "External"
  }));
}

// lib/ooxmlDeepClean.ts
var DEFAULT_DEEP_OPTIONS = {
  stripImageMetadata: true,
  flattenCroppedImages: false,
  clearPivotCaches: true,
  removeHiddenSheets: false,
  clearHiddenRowsCols: false,
  removeHiddenSlides: false,
  removeSpeakerNotes: false,
  removePrinterSettings: true,
  removeExternalLinks: true,
  removeDocumentIds: true,
  removeChartWorkbooks: false,
  removeMacros: false,
  anonymizeAuthors: false
};
var MEDIA = /^(word|xl|ppt)\/media\//;
var isXml = (name) => name.endsWith(".xml");
function scanDeep(entries) {
  const findings = [];
  const names = entries.map((e) => e.name);
  const add = (f) => findings.push(f);
  const imageFindings = [];
  const imageParts = [];
  for (const entry2 of entries) {
    if (!MEDIA.test(entry2.name)) continue;
    const found = inspectImage(entry2.data);
    if (found.length === 0) continue;
    imageParts.push(entry2.name);
    for (const item of found) {
      const text = item.value ? `${item.label}: ${item.value}` : item.label;
      if (!imageFindings.includes(text)) imageFindings.push(text);
    }
  }
  if (imageParts.length > 0) {
    const hasGps = imageFindings.some((f) => f.startsWith("GPS"));
    add({
      id: "imageMetadata",
      label: `Metadaten in ${imageParts.length} eingebetteten Bild${imageParts.length === 1 ? "" : "ern"}`,
      detail: `Gefunden: ${imageFindings.join(", ")}.${hasGps ? " Die GPS-Position verr\xE4t den Aufnahmeort." : ""}`,
      severity: hasGps ? "hoch" : "mittel",
      option: "stripImageMetadata",
      parts: imageParts
    });
  }
  const crops = findCrops(entries);
  if (crops.length > 0) {
    add({
      id: "croppedImages",
      label: `${crops.length} zugeschnittene${crops.length === 1 ? "s" : ""} Bild${crops.length === 1 ? "" : "er"}`,
      detail: "Der weggeschnittene Teil ist weiterhin vollst\xE4ndig in der Datei enthalten und l\xE4sst sich durch Aufheben des Zuschnitts sichtbar machen.",
      severity: "hoch",
      option: "flattenCroppedImages",
      parts: crops.map((c) => c.mediaPart)
    });
  }
  const pivotRecords = names.filter((n) => /^xl\/pivotCache\/pivotCacheRecords/.test(n));
  if (pivotRecords.length > 0) {
    const rows = pivotRecords.reduce((sum, name) => {
      const xml = textOf(entries, name) ?? "";
      return sum + (xml.match(/<r>/g) ?? []).length;
    }, 0);
    add({
      id: "pivotCache",
      label: `Pivot-Cache mit ${rows} zwischengespeicherten Datens\xE4tzen`,
      detail: "Der Cache enth\xE4lt die vollst\xE4ndigen Quelldaten der Pivot-Tabelle \u2014 auch dann, wenn das Quellblatt gel\xF6scht wurde.",
      severity: "hoch",
      option: "clearPivotCaches",
      parts: pivotRecords
    });
  }
  const hiddenSheets = listHiddenSheets(entries);
  if (hiddenSheets.length > 0) {
    add({
      id: "hiddenSheets",
      label: `${hiddenSheets.length} ausgeblendete${hiddenSheets.length === 1 ? "s" : ""} Tabellenblatt${hiddenSheets.length === 1 ? "" : "bl\xE4tter"}`,
      detail: `Betroffen: ${hiddenSheets.map((s) => `\u201E${s.name}"${s.state === "veryHidden" ? " (nur per VBA sichtbar)" : ""}`).join(", ")}.`,
      severity: "hoch",
      option: "removeHiddenSheets"
    });
  }
  const hiddenCells = countHiddenRowsCols(entries);
  if (hiddenCells.rows > 0 || hiddenCells.cols > 0) {
    add({
      id: "hiddenRowsCols",
      label: `${hiddenCells.rows} ausgeblendete Zeilen, ${hiddenCells.cols} ausgeblendete Spalten`,
      detail: "Ausgeblendete Zellen enthalten weiterhin ihre Werte. Ein Empf\xE4nger blendet sie mit zwei Klicks wieder ein.",
      severity: "hoch",
      option: "clearHiddenRowsCols"
    });
  }
  const hiddenSlides = listHiddenSlides(entries);
  if (hiddenSlides.length > 0) {
    add({
      id: "hiddenSlides",
      label: `${hiddenSlides.length} ausgeblendete Folie${hiddenSlides.length === 1 ? "" : "n"}`,
      detail: "Ausgeblendete Folien werden nicht vorgef\xFChrt, sind in der Datei aber vollst\xE4ndig vorhanden.",
      severity: "mittel",
      option: "removeHiddenSlides",
      parts: hiddenSlides
    });
  }
  const notes = names.filter((n) => /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(n));
  if (notes.length > 0) {
    add({
      id: "speakerNotes",
      label: `${notes.length} Notizenseite${notes.length === 1 ? "" : "n"}`,
      detail: "Sprechernotizen sind f\xFCr das Publikum unsichtbar, in der Datei aber im Klartext lesbar.",
      severity: "mittel",
      option: "removeSpeakerNotes",
      parts: notes
    });
  }
  const printers = names.filter((n) => /printerSettings\/printerSettings\d*\.bin$/.test(n));
  if (printers.length > 0) {
    add({
      id: "printerSettings",
      label: `Druckereinstellungen (${printers.length} Teil${printers.length === 1 ? "" : "e"})`,
      detail: "Enthalten den Namen des zuletzt benutzten Druckers und dessen Treiberkonfiguration.",
      severity: "mittel",
      option: "removePrinterSettings",
      parts: printers
    });
  }
  const external = findExternalPaths(entries);
  if (external.length > 0) {
    add({
      id: "externalLinks",
      label: `${external.length} Verweis${external.length === 1 ? "" : "e"} auf lokale oder Netzwerkpfade`,
      detail: `Gefunden: ${external.slice(0, 6).map((e) => e.target).join(", ")}${external.length > 6 ? " \u2026" : ""}. Solche Pfade verraten Benutzernamen, Serverfreigaben und Ordnerstrukturen.`,
      severity: "hoch",
      option: "removeExternalLinks"
    });
  }
  if ((textOf(entries, "word/settings.xml") ?? "").includes("<w:mailMerge>")) {
    add({
      id: "mailMerge",
      label: "Seriendruck-Datenquelle",
      detail: "Die Verkn\xFCpfung zur Adressliste steht mit vollst\xE4ndigem Pfad in den Dokumenteinstellungen.",
      severity: "hoch",
      option: "removeExternalLinks",
      parts: ["word/settings.xml"]
    });
  }
  const idParts = entries.filter((e) => isXml(e.name)).filter((e) => /<w15:docId|w14:paraId=|p14:creationId|p14:modId/.test(decodeText(e.data))).map((e) => e.name);
  if (idParts.length > 0) {
    add({
      id: "documentIds",
      label: "Dauerhafte Dokument-Kennungen (GUIDs)",
      detail: "Word und PowerPoint vergeben eine Dokument-GUID und Absatz-IDs. \xDCber sie lassen sich Kopien und Ableitungen desselben Ausgangsdokuments einander zuordnen.",
      severity: "mittel",
      option: "removeDocumentIds",
      parts: idParts
    });
  }
  const chartWorkbooks = findChartWorkbooks(entries).map((c) => c.target);
  if (chartWorkbooks.length > 0) {
    add({
      id: "chartWorkbooks",
      label: `${chartWorkbooks.length} eingebettete Diagramm-Arbeitsmappe${chartWorkbooks.length === 1 ? "" : "n"}`,
      detail: "Hinter jedem Diagramm steckt eine vollst\xE4ndige Excel-Mappe. Sie enth\xE4lt oft mehr Spalten und Zeilen als das Diagramm zeigt.",
      severity: "hoch",
      option: "removeChartWorkbooks",
      parts: chartWorkbooks
    });
  }
  const ole = names.filter((n) => /embeddings\/.*\.(bin|doc|xls|ppt)$/i.test(n)).filter((n) => !chartWorkbooks.includes(n));
  if (ole.length > 0) {
    add({
      id: "oleObjects",
      label: `${ole.length} eingebettete${ole.length === 1 ? "s" : ""} OLE-Objekt${ole.length === 1 ? "" : "e"}`,
      detail: "Eingebettete Fremddokumente bringen ihre eigenen Metadaten mit. Sie lassen sich nicht entfernen, ohne die Einbettung im Text zu zerst\xF6ren \u2014 in Office \xF6ffnen, dort bereinigen und neu einf\xFCgen.",
      severity: "mittel",
      parts: ole
    });
  }
  const smartArt = names.filter((n) => /diagrams\/data\d*\.xml$/.test(n));
  if (smartArt.length > 0) {
    add({
      id: "smartArt",
      label: `SmartArt-Datenmodell (${smartArt.length} Teil${smartArt.length === 1 ? "" : "e"})`,
      detail: "Das Modell hinter einer SmartArt-Grafik kann gel\xF6schte Knoten und deren Text weiter enthalten. Automatisches Entfernen w\xFCrde die Grafik leeren \u2014 bitte in Office pr\xFCfen.",
      severity: "niedrig",
      parts: smartArt
    });
  }
  const macros = names.filter((n) => /vbaProject\.bin$|vbaData\.xml$/.test(n));
  if (macros.length > 0) {
    add({
      id: "macros",
      label: "Makros (VBA-Projekt)",
      detail: "Ein VBA-Projekt enth\xE4lt Quellcode samt Autorenspuren und ist zudem ein Sicherheitsrisiko beim Empf\xE4nger.",
      severity: "mittel",
      option: "removeMacros",
      parts: macros
    });
  }
  const authors = collectAuthors(entries);
  if (authors.length > 0) {
    add({
      id: "authors",
      label: `${authors.length} Personenname${authors.length === 1 ? "" : "n"} im Dokumentinhalt`,
      detail: `Gefunden: ${authors.join(", ")}. Diese Namen stehen in Kommentaren, \xC4nderungsverfolgung oder der Personenliste \u2014 nicht in den Dokumenteigenschaften.`,
      severity: "hoch",
      option: "anonymizeAuthors"
    });
  }
  const whiteText = entries.filter((e) => /^word\/document\.xml$|^ppt\/slides\/|^xl\/worksheets\//.test(e.name)).filter((e) => /w:color w:val="(FFFFFF|ffffff)"|srgbClr val="FFFFFF"/.test(decodeText(e.data))).map((e) => e.name);
  if (whiteText.length > 0) {
    add({
      id: "whiteText",
      label: "Wei\xDF formatierter Text",
      detail: "Text in Wei\xDF auf wei\xDFem Grund ist beim Lesen unsichtbar, beim Markieren und Kopieren aber sofort da. Automatisches Entfernen w\xE4re ein Eingriff in den Inhalt \u2014 bitte selbst pr\xFCfen (Strg+A und Textfarbe \xE4ndern).",
      severity: "mittel",
      parts: whiteText
    });
  }
  return findings;
}
function findCrops(entries) {
  const uses = [];
  for (const entry2 of entries) {
    if (!isXml(entry2.name) || entry2.name.endsWith(".rels")) continue;
    const xml = decodeText(entry2.data);
    if (!xml.includes("srcRect")) continue;
    const rels2 = readRelationships(entries, relsPathFor(entry2.name));
    const blipFills = xml.match(/<[a-z0-9]+:blipFill[\s\S]*?<\/[a-z0-9]+:blipFill>/g) ?? [];
    for (const fill of blipFills) {
      const srcRect = /<a:srcRect([^/>]*)\/>/.exec(fill);
      if (!srcRect) continue;
      const rect = parseCropRect(srcRect[1]);
      if (!rect) continue;
      const embed = /r:embed="([^"]+)"/.exec(fill);
      if (!embed) continue;
      const rel2 = rels2.find((r) => r.id === embed[1]);
      if (!rel2 || rel2.external) continue;
      uses.push({ ownerPart: entry2.name, mediaPart: resolveTarget(relsPathFor(entry2.name), rel2.target), rect });
    }
  }
  return uses;
}
function parseCropRect(attributes) {
  const value = (name) => {
    const match = new RegExp(`${name}="(-?\\d+)"`).exec(attributes);
    return match ? Number(match[1]) / 1e5 : 0;
  };
  const rect = { left: value("l"), top: value("t"), right: value("r"), bottom: value("b") };
  const cropped = rect.left > 0 || rect.top > 0 || rect.right > 0 || rect.bottom > 0;
  return cropped ? rect : null;
}
function listHiddenSheets(entries) {
  const xml = textOf(entries, "xl/workbook.xml");
  if (!xml) return [];
  const doc = parseXml(xml, "xl/workbook.xml");
  return Array.from(doc.getElementsByTagNameNS(NS.sheet, "sheet")).filter((sheet) => {
    const state = sheet.getAttribute("state");
    return state === "hidden" || state === "veryHidden";
  }).map((sheet) => ({
    name: sheet.getAttribute("name") ?? "",
    state: sheet.getAttribute("state") ?? "",
    relId: sheet.getAttributeNS(NS.r, "id") ?? sheet.getAttribute("r:id") ?? ""
  }));
}
function countHiddenRowsCols(entries) {
  let rows = 0;
  let cols = 0;
  for (const entry2 of entries) {
    if (!/^xl\/worksheets\/sheet\d+\.xml$/.test(entry2.name)) continue;
    const xml = decodeText(entry2.data);
    rows += (xml.match(/<row[^>]*\shidden="(1|true)"/g) ?? []).length;
    for (const col of xml.match(/<col[^>]*\shidden="(1|true)"[^>]*\/>/g) ?? []) {
      const min = Number(/min="(\d+)"/.exec(col)?.[1] ?? 0);
      const max = Number(/max="(\d+)"/.exec(col)?.[1] ?? 0);
      cols += Math.max(0, max - min + 1);
    }
  }
  return { rows, cols };
}
function listHiddenSlides(entries) {
  return entries.filter((e) => /^ppt\/slides\/slide\d+\.xml$/.test(e.name)).filter((e) => /<p:sld[^>]*\sshow="(0|false)"/.test(decodeText(e.data))).map((e) => e.name);
}
var LOCAL_PATH = /^(file:|\\\\|[A-Za-z]:[\\/])/;
function findExternalPaths(entries) {
  const found = [];
  for (const entry2 of entries) {
    if (!entry2.name.endsWith(".rels")) continue;
    for (const rel2 of readRelationships(entries, entry2.name)) {
      if (rel2.external && LOCAL_PATH.test(rel2.target)) found.push({ part: entry2.name, id: rel2.id, target: rel2.target });
    }
  }
  for (const entry2 of entries) {
    if (!/^xl\/externalLinks\/externalLink\d+\.xml$/.test(entry2.name)) continue;
    found.push({ part: entry2.name, id: "", target: entry2.name });
  }
  return found;
}
function findChartWorkbooks(entries) {
  const found = [];
  for (const entry2 of entries) {
    if (!/charts\/chart\d*\.xml$/.test(entry2.name)) continue;
    const xml = decodeText(entry2.data);
    const external = /<c:externalData[^>]*r:id="([^"]+)"/.exec(xml);
    if (!external) continue;
    const rel2 = readRelationships(entries, relsPathFor(entry2.name)).find((r) => r.id === external[1]);
    if (!rel2 || rel2.external) continue;
    found.push({ chartPart: entry2.name, relId: rel2.id, target: resolveTarget(relsPathFor(entry2.name), rel2.target) });
  }
  return found;
}
var AUTHOR_PATTERNS = [
  /\sw:author="([^"]+)"/g,
  /\sw15:author="([^"]+)"/g,
  /<p:cmAuthor[^>]*\sname="([^"]+)"/g,
  /<author>([^<]+)<\/author>/g
];
function collectAuthors(entries) {
  const authors = /* @__PURE__ */ new Set();
  for (const entry2 of entries) {
    if (!isXml(entry2.name)) continue;
    const xml = decodeText(entry2.data);
    for (const pattern of AUTHOR_PATTERNS) {
      pattern.lastIndex = 0;
      let match;
      while (match = pattern.exec(xml)) {
        const name = match[1].trim();
        if (name && name.toLowerCase() !== "author" && !/^Autor \d+$/.test(name)) authors.add(name);
      }
    }
  }
  return Array.from(authors);
}
async function applyDeepClean(entries, options) {
  const steps = [];
  const result = { steps };
  const log = (option, summary, parts) => steps.push({ option, summary, parts });
  if (options.flattenCroppedImages) await flattenCrops(entries, log);
  if (options.stripImageMetadata) cleanImages(entries, log);
  if (options.clearPivotCaches) clearPivotCaches(entries, log);
  if (options.removeHiddenSheets) removeHiddenSheets(entries, log);
  if (options.clearHiddenRowsCols) clearHiddenRowsCols(entries, log);
  if (options.removeHiddenSlides) removeHiddenSlides(entries, log);
  if (options.removeSpeakerNotes) removeSpeakerNotes(entries, log);
  if (options.removePrinterSettings) removePrinterSettings(entries, log);
  if (options.removeExternalLinks) removeExternalLinks(entries, log);
  if (options.removeDocumentIds) removeDocumentIds(entries, log);
  if (options.removeChartWorkbooks) removeChartWorkbooks(entries, log);
  if (options.removeMacros) result.newExtension = removeMacros(entries, log);
  if (options.anonymizeAuthors) anonymizeAuthors(entries, log);
  return result;
}
function cleanImages(entries, log) {
  const cleaned = [];
  let saved = 0;
  for (const entry2 of entries) {
    if (!MEDIA.test(entry2.name)) continue;
    const stripped = stripImageMetadata(entry2.data);
    if (stripped.length !== entry2.data.length) {
      saved += entry2.data.length - stripped.length;
      entry2.data = stripped;
      cleaned.push(entry2.name);
    }
  }
  if (cleaned.length > 0) {
    log("stripImageMetadata", `EXIF/XMP/IPTC aus ${cleaned.length} Bild(ern) entfernt (${Math.round(saved / 102.4) / 10} KB)`, cleaned);
  }
}
async function flattenCrops(entries, log) {
  const crops = findCrops(entries);
  if (crops.length === 0) return;
  const usage = /* @__PURE__ */ new Map();
  for (const entry2 of entries) {
    if (!isXml(entry2.name) || entry2.name.endsWith(".rels")) continue;
    const xml = decodeText(entry2.data);
    const rels2 = readRelationships(entries, relsPathFor(entry2.name));
    for (const match of xml.match(/r:embed="([^"]+)"/g) ?? []) {
      const id = /r:embed="([^"]+)"/.exec(match)?.[1];
      const rel2 = rels2.find((r) => r.id === id);
      if (!rel2 || rel2.external) continue;
      const part = resolveTarget(relsPathFor(entry2.name), rel2.target);
      usage.set(part, (usage.get(part) ?? 0) + 1);
    }
  }
  const done = [];
  const skipped = [];
  for (const crop of crops) {
    if ((usage.get(crop.mediaPart) ?? 0) > 1) {
      skipped.push(crop.mediaPart);
      continue;
    }
    const entry2 = findEntry(entries, crop.mediaPart);
    if (!entry2) continue;
    const cut = await flattenCrop(entry2.data, crop.rect);
    if (!cut) {
      skipped.push(crop.mediaPart);
      continue;
    }
    entry2.data = cut;
    done.push(crop.mediaPart);
    const owner = findEntry(entries, crop.ownerPart);
    if (owner) {
      const xml = decodeText(owner.data).replace(/<a:srcRect[^/>]*\/>/g, "");
      owner.data = encodeText(xml);
    }
  }
  if (done.length > 0) log("flattenCroppedImages", `${done.length} Bild(er) auf den sichtbaren Ausschnitt reduziert`, done);
  if (skipped.length > 0) {
    log(
      "flattenCroppedImages",
      `${skipped.length} Zuschnitt(e) \xFCbersprungen \u2014 Bild mehrfach verwendet oder Format nicht dekodierbar`,
      skipped
    );
  }
}
function clearPivotCaches(entries, log) {
  const touched = [];
  for (const entry2 of entries) {
    if (/^xl\/pivotCache\/pivotCacheRecords\d*\.xml$/.test(entry2.name)) {
      entry2.data = encodeText(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r
<pivotCacheRecords xmlns="${NS.sheet}" xmlns:r="${NS.r}" count="0"/>`
      );
      touched.push(entry2.name);
    }
  }
  const definitions = editParts(
    entries,
    (name) => /^xl\/pivotCache\/pivotCacheDefinition\d*\.xml$/.test(name),
    (xml) => xml.replace(/(<pivotCacheDefinition\b[^>]*?)\srefreshOnLoad="[^"]*"/g, "$1").replace(/(<pivotCacheDefinition\b)/, '$1 refreshOnLoad="1"').replace(/(<pivotCacheDefinition\b[^>]*?)\srecordCount="\d+"/g, '$1 recordCount="0"').replace(/<sharedItems[^>]*>[\s\S]*?<\/sharedItems>/g, "<sharedItems/>").replace(/<sharedItems[^/>]*\/>/g, "<sharedItems/>")
  );
  if (touched.length + definitions.length > 0) {
    log("clearPivotCaches", `Pivot-Cache geleert, Aktualisierung beim \xD6ffnen erzwungen`, [...touched, ...definitions]);
  }
}
function removeHiddenSheets(entries, log) {
  const hidden = listHiddenSheets(entries);
  if (hidden.length === 0) return;
  const workbookXml = textOf(entries, "xl/workbook.xml");
  if (!workbookXml) return;
  const doc = parseXml(workbookXml, "xl/workbook.xml");
  const rels2 = readRelationships(entries, "xl/_rels/workbook.xml.rels");
  const targets = [];
  for (const sheet of Array.from(doc.getElementsByTagNameNS(NS.sheet, "sheet"))) {
    const state = sheet.getAttribute("state");
    if (state !== "hidden" && state !== "veryHidden") continue;
    const relId = sheet.getAttributeNS(NS.r, "id") ?? sheet.getAttribute("r:id") ?? "";
    const rel2 = rels2.find((r) => r.id === relId);
    if (rel2) targets.push(resolveTarget("xl/_rels/workbook.xml.rels", rel2.target));
    sheet.parentNode?.removeChild(sheet);
  }
  const names = hidden.map((s) => s.name);
  for (const defined of Array.from(doc.getElementsByTagNameNS(NS.sheet, "definedName"))) {
    const text = defined.textContent ?? "";
    if (names.some((name) => text.includes(name))) defined.parentNode?.removeChild(defined);
  }
  setText(entries, "xl/workbook.xml", serializeXml(doc));
  const removed = removeParts(entries, (name) => targets.includes(name));
  log("removeHiddenSheets", `${hidden.length} ausgeblendete(s) Tabellenblatt/Bl\xE4tter gel\xF6scht: ${names.join(", ")}`, removed);
}
function clearHiddenRowsCols(entries, log) {
  let clearedRows = 0;
  let clearedCells = 0;
  const touched = [];
  for (const entry2 of entries) {
    if (!/^xl\/worksheets\/sheet\d+\.xml$/.test(entry2.name)) continue;
    const doc = parseXml(decodeText(entry2.data), entry2.name);
    const hiddenCols = /* @__PURE__ */ new Set();
    for (const col of Array.from(doc.getElementsByTagNameNS(NS.sheet, "col"))) {
      const hidden = col.getAttribute("hidden");
      if (hidden !== "1" && hidden !== "true") continue;
      const min = Number(col.getAttribute("min") ?? "0");
      const max = Number(col.getAttribute("max") ?? "0");
      for (let i = min; i <= max && i - min < 16384; i++) hiddenCols.add(i);
    }
    let changed = false;
    for (const row of Array.from(doc.getElementsByTagNameNS(NS.sheet, "row"))) {
      const hidden = row.getAttribute("hidden");
      const rowHidden = hidden === "1" || hidden === "true";
      for (const cell of Array.from(row.getElementsByTagNameNS(NS.sheet, "c"))) {
        const column = columnIndex(cell.getAttribute("r") ?? "");
        if (!rowHidden && !hiddenCols.has(column)) continue;
        cell.parentNode?.removeChild(cell);
        clearedCells++;
        changed = true;
      }
      if (rowHidden) clearedRows++;
    }
    if (changed) {
      setText(entries, entry2.name, serializeXml(doc));
      touched.push(entry2.name);
    }
  }
  if (clearedCells === 0) return;
  const pruned = pruneSharedStrings(entries);
  log(
    "clearHiddenRowsCols",
    `${clearedCells} Zellen in ausgeblendeten Zeilen/Spalten geleert (${clearedRows} Zeilen)${pruned > 0 ? `, ${pruned} verwaiste Texte aus der Zeichenkettentabelle entfernt` : ""}`,
    touched
  );
}
function columnIndex(reference) {
  let index = 0;
  for (const char of reference) {
    const code = char.charCodeAt(0);
    if (code < 65 || code > 90) break;
    index = index * 26 + (code - 64);
  }
  return index;
}
function pruneSharedStrings(entries) {
  const sharedXml = textOf(entries, "xl/sharedStrings.xml");
  if (!sharedXml) return 0;
  const doc = parseXml(sharedXml, "xl/sharedStrings.xml");
  const items = Array.from(doc.getElementsByTagNameNS(NS.sheet, "si"));
  if (items.length === 0) return 0;
  const used = /* @__PURE__ */ new Set();
  const sheets = entries.filter((e) => /^xl\/worksheets\/sheet\d+\.xml$/.test(e.name));
  const sheetDocs = sheets.map((entry2) => ({ entry: entry2, doc: parseXml(decodeText(entry2.data), entry2.name) }));
  for (const { doc: sheetDoc } of sheetDocs) {
    for (const cell of Array.from(sheetDoc.getElementsByTagNameNS(NS.sheet, "c"))) {
      if (cell.getAttribute("t") !== "s") continue;
      const value = cell.getElementsByTagNameNS(NS.sheet, "v")[0];
      if (value) used.add(Number(value.textContent));
    }
  }
  if (used.size === items.length) return 0;
  const remap = /* @__PURE__ */ new Map();
  let next = 0;
  items.forEach((item, index) => {
    if (used.has(index)) remap.set(index, next++);
    else item.parentNode?.removeChild(item);
  });
  const root = doc.documentElement;
  root.setAttribute("count", String(next));
  root.setAttribute("uniqueCount", String(next));
  setText(entries, "xl/sharedStrings.xml", serializeXml(doc));
  for (const { entry: entry2, doc: sheetDoc } of sheetDocs) {
    let changed = false;
    for (const cell of Array.from(sheetDoc.getElementsByTagNameNS(NS.sheet, "c"))) {
      if (cell.getAttribute("t") !== "s") continue;
      const value = cell.getElementsByTagNameNS(NS.sheet, "v")[0];
      if (!value) continue;
      const mapped = remap.get(Number(value.textContent));
      if (mapped === void 0) continue;
      if (String(mapped) !== value.textContent) {
        value.textContent = String(mapped);
        changed = true;
      }
    }
    if (changed) setText(entries, entry2.name, serializeXml(sheetDoc));
  }
  return items.length - next;
}
function removeHiddenSlides(entries, log) {
  const hidden = listHiddenSlides(entries);
  if (hidden.length === 0) return;
  const presentationXml = textOf(entries, "ppt/presentation.xml");
  if (presentationXml) {
    const doc = parseXml(presentationXml, "ppt/presentation.xml");
    const rels2 = readRelationships(entries, "ppt/_rels/presentation.xml.rels");
    for (const slideId of Array.from(doc.getElementsByTagNameNS(NS.p, "sldId"))) {
      const relId = slideId.getAttributeNS(NS.r, "id") ?? slideId.getAttribute("r:id") ?? "";
      const rel2 = rels2.find((r) => r.id === relId);
      if (!rel2) continue;
      if (hidden.includes(resolveTarget("ppt/_rels/presentation.xml.rels", rel2.target))) {
        slideId.parentNode?.removeChild(slideId);
      }
    }
    setText(entries, "ppt/presentation.xml", serializeXml(doc));
  }
  const removed = removeParts(entries, (name) => hidden.includes(name));
  log("removeHiddenSlides", `${hidden.length} ausgeblendete Folie(n) gel\xF6scht`, removed);
}
function removeSpeakerNotes(entries, log) {
  const removed = removeParts(entries, (name) => /^ppt\/notesSlides\//.test(name));
  if (removed.length > 0) log("removeSpeakerNotes", `${removed.length} Notizenseite(n) gel\xF6scht`, removed);
}
function removePrinterSettings(entries, log) {
  const removed = removePartsAndReferences(entries, (name) => /printerSettings\/printerSettings\d*\.bin$/.test(name));
  if (removed.length === 0) return;
  log("removePrinterSettings", `Druckereinstellungen entfernt (${removed.length} Teil(e))`, removed);
}
function removeExternalLinks(entries, log) {
  const external = findExternalPaths(entries);
  const removedIds = /* @__PURE__ */ new Map();
  for (const entry2 of entries.filter((e) => e.name.endsWith(".rels"))) {
    const doc = parseXml(decodeText(entry2.data), entry2.name);
    const ids2 = [];
    for (const rel2 of Array.from(doc.getElementsByTagNameNS(NS.rel, "Relationship"))) {
      if (rel2.getAttribute("TargetMode") !== "External") continue;
      if (!LOCAL_PATH.test(rel2.getAttribute("Target") ?? "")) continue;
      ids2.push(rel2.getAttribute("Id") ?? "");
      rel2.parentNode?.removeChild(rel2);
    }
    if (ids2.length === 0) continue;
    entry2.data = encodeText(serializeXml(doc));
    const owner = entry2.name.replace(/_rels\/([^/]+)\.rels$/, "$1");
    removedIds.set(owner, ids2);
  }
  for (const [owner, ids2] of Array.from(removedIds.entries())) {
    const entry2 = findEntry(entries, owner);
    if (!entry2) continue;
    let xml = decodeText(entry2.data);
    for (const id of ids2) {
      xml = xml.replace(new RegExp(`\\sr:id="${id}"`, "g"), "").replace(new RegExp(`\\sr:embed="${id}"`, "g"), "");
    }
    entry2.data = encodeText(xml);
  }
  const mailMerge = editParts(
    entries,
    (name) => name === "word/settings.xml",
    (xml) => xml.replace(/<w:mailMerge>[\s\S]*?<\/w:mailMerge>/g, "")
  );
  const links = removePartsAndReferences(entries, (name) => /^xl\/externalLinks\//.test(name) || name === "xl/connections.xml");
  if (links.length > 0) {
    editParts(
      entries,
      (name) => name === "xl/workbook.xml",
      (xml) => xml.replace(/<externalReferences>[\s\S]*?<\/externalReferences>/g, "")
    );
  }
  const total = external.length + mailMerge.length + links.length;
  if (total > 0) {
    log(
      "removeExternalLinks",
      `${external.length} Pfadverweis(e), ${links.length} externe Verkn\xFCpfung(en)${mailMerge.length > 0 ? " und die Seriendruckquelle" : ""} entfernt`,
      links
    );
  }
}
function removeDocumentIds(entries, log) {
  const touched = editParts(
    entries,
    isXml,
    (xml) => xml.replace(/<w15:docId[^/>]*\/>/g, "").replace(/\sw14:paraId="[^"]*"/g, "").replace(/\sw14:textId="[^"]*"/g, "").replace(/<p14:creationId[^/>]*\/>/g, "").replace(/<p14:modId[^/>]*\/>/g, "").replace(/\sw14:anchorId="[^"]*"/g, "")
  );
  if (touched.length > 0) log("removeDocumentIds", `Dokument-GUIDs und Absatz-IDs aus ${touched.length} Teil(en) entfernt`, touched);
}
function removeChartWorkbooks(entries, log) {
  const charts = findChartWorkbooks(entries);
  if (charts.length === 0) return;
  for (const chart of charts) {
    const entry2 = findEntry(entries, chart.chartPart);
    if (!entry2) continue;
    entry2.data = encodeText(
      decodeText(entry2.data).replace(/<c:externalData[\s\S]*?<\/c:externalData>/g, "").replace(/<c:externalData[^/>]*\/>/g, "")
    );
  }
  const removed = removePartsAndReferences(entries, (name) => charts.some((c) => c.target === name));
  log("removeChartWorkbooks", `${removed.length} eingebettete Diagramm-Arbeitsmappe(n) entfernt`, removed);
}
var MACRO_CONTENT_TYPES = {
  "application/vnd.ms-word.document.macroEnabled.main+xml": "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml",
  "application/vnd.ms-word.template.macroEnabledTemplate.main+xml": "application/vnd.openxmlformats-officedocument.wordprocessingml.template.main+xml",
  "application/vnd.ms-excel.sheet.macroEnabled.main+xml": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml",
  "application/vnd.ms-excel.template.macroEnabled.main+xml": "application/vnd.openxmlformats-officedocument.spreadsheetml.template.main+xml",
  "application/vnd.ms-powerpoint.presentation.macroEnabled.main+xml": "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml",
  "application/vnd.ms-powerpoint.slideshow.macroEnabled.main+xml": "application/vnd.openxmlformats-officedocument.presentationml.slideshow.main+xml",
  "application/vnd.ms-powerpoint.template.macroEnabled.main+xml": "application/vnd.openxmlformats-officedocument.presentationml.template.main+xml"
};
var NEW_EXTENSION = { docm: "docx", dotm: "dotx", xlsm: "xlsx", xltm: "xltx", pptm: "pptx", potm: "potx", ppsm: "ppsx" };
function removeMacros(entries, log) {
  const removed = removeParts(entries, (name) => /vbaProject\.bin$|vbaData\.xml$/.test(name));
  if (removed.length === 0) return void 0;
  let converted = false;
  editParts(
    entries,
    (name) => name === "[Content_Types].xml",
    (xml) => {
      let next = xml;
      for (const [macro, plain] of Object.entries(MACRO_CONTENT_TYPES)) {
        if (next.includes(macro)) {
          next = next.split(macro).join(plain);
          converted = true;
        }
      }
      return next;
    }
  );
  log("removeMacros", `VBA-Projekt entfernt${converted ? ", Datei in ein makrofreies Format \xFCberf\xFChrt" : ""}`, removed);
  return converted ? "auto" : void 0;
}
function macroFreeExtension(fileName) {
  const extension = fileName.split(".").pop()?.toLowerCase() ?? "";
  return NEW_EXTENSION[extension];
}
function anonymizeAuthors(entries, log) {
  const authors = collectAuthors(entries);
  const core = textOf(entries, "docProps/core.xml") ?? "";
  for (const pattern of [/<dc:creator>([^<]+)<\/dc:creator>/, /<cp:lastModifiedBy>([^<]+)<\/cp:lastModifiedBy>/]) {
    const name = pattern.exec(core)?.[1]?.trim();
    if (name && !/^Autor \d+$/.test(name) && !authors.includes(name)) authors.push(name);
  }
  if (authors.length === 0) return;
  const mapping = /* @__PURE__ */ new Map();
  authors.forEach((name, index) => mapping.set(name, `Autor ${index + 1}`));
  const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const xmlEscape = (text) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const touched = editParts(entries, isXml, (xml) => {
    let next = xml;
    for (const [name, replacement] of Array.from(mapping.entries())) {
      const escaped = escape(xmlEscape(name));
      next = next.replace(new RegExp(`(\\sw:author=")${escaped}(")`, "g"), `$1${replacement}$2`).replace(new RegExp(`(\\sw15:author=")${escaped}(")`, "g"), `$1${replacement}$2`).replace(new RegExp(`(<p:cmAuthor[^>]*\\sname=")${escaped}(")`, "g"), `$1${replacement}$2`).replace(new RegExp(`(<author>)${escaped}(</author>)`, "g"), `$1${replacement}$2`).replace(new RegExp(`(<dc:creator>)${escaped}(</dc:creator>)`, "g"), `$1${replacement}$2`).replace(new RegExp(`(<cp:lastModifiedBy>)${escaped}(</cp:lastModifiedBy>)`, "g"), `$1${replacement}$2`);
    }
    next = next.replace(/(\sw:initials=")[^"]*(")/g, "$1A$2").replace(/(<p:cmAuthor[^>]*\sinitials=")[^"]*(")/g, "$1A$2").replace(/<w15:presenceInfo[^/>]*\/>/g, "");
    return next;
  });
  log(
    "anonymizeAuthors",
    `${mapping.size} Name(n) ersetzt: ${Array.from(mapping.entries()).map(([from, to]) => `${from} \u2192 ${to}`).join(", ")}`,
    touched
  );
}

// lib/zip.ts
var SIG_LOCAL = 67324752;
var SIG_CENTRAL = 33639248;
var SIG_EOCD = 101010256;
var CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 3988292384 ^ c >>> 1 : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();
function crc32(bytes2) {
  let c = 4294967295;
  for (let i = 0; i < bytes2.length; i++) c = CRC_TABLE[(c ^ bytes2[i]) & 255] ^ c >>> 8;
  return (c ^ 4294967295) >>> 0;
}
async function inflateRaw(bytes2) {
  const stream = new Blob([bytes2]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
async function deflateRaw(bytes2) {
  const stream = new Blob([bytes2]).stream().pipeThrough(new CompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
function toDosDateTime(date) {
  const year = Math.max(1980, date.getFullYear());
  const dosDate = year - 1980 << 9 | date.getMonth() + 1 << 5 | date.getDate();
  const dosTime = date.getHours() << 11 | date.getMinutes() << 5 | date.getSeconds() >> 1;
  return { dosTime, dosDate };
}
async function readZip(buffer) {
  const view = new DataView(buffer);
  const bytes2 = new Uint8Array(buffer);
  let eocd = -1;
  const scanStart = Math.max(0, bytes2.length - 65535 - 22);
  for (let i = bytes2.length - 22; i >= scanStart; i--) {
    if (view.getUint32(i, true) === SIG_EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("Keine g\xFCltige ZIP-Struktur gefunden \u2014 ist das wirklich eine Office-Datei?");
  const entryCount = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);
  if (offset === 4294967295) throw new Error("ZIP64-Archive werden nicht unterst\xFCtzt.");
  const entries = [];
  for (let i = 0; i < entryCount; i++) {
    if (view.getUint32(offset, true) !== SIG_CENTRAL) throw new Error("Besch\xE4digtes Central Directory.");
    const method = view.getUint16(offset + 10, true);
    const dosTime = view.getUint16(offset + 12, true);
    const dosDate = view.getUint16(offset + 14, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const externalAttr = view.getUint32(offset + 38, true);
    const localOffset = view.getUint32(offset + 42, true);
    const name = new TextDecoder().decode(bytes2.subarray(offset + 46, offset + 46 + nameLength));
    if (view.getUint32(localOffset, true) !== SIG_LOCAL) throw new Error(`Besch\xE4digter Local Header: ${name}`);
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const raw = bytes2.subarray(dataStart, dataStart + compressedSize);
    if (!name.endsWith("/")) {
      entries.push({
        name,
        data: method === 8 ? await inflateRaw(raw) : new Uint8Array(raw),
        method,
        dosTime,
        dosDate,
        externalAttr
      });
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}
async function writeZip(entries, timestamp) {
  const encoder4 = new TextEncoder();
  const localChunks = [];
  const centralChunks = [];
  let offset = 0;
  for (const entry2 of entries) {
    const nameBytes = encoder4.encode(entry2.name);
    const crc = crc32(entry2.data);
    const deflated = entry2.data.length > 0 ? await deflateRaw(entry2.data) : new Uint8Array(0);
    const useDeflate = entry2.method !== 0 && deflated.length < entry2.data.length;
    const payload = useDeflate ? deflated : entry2.data;
    const method = useDeflate ? 8 : 0;
    const { dosTime, dosDate } = timestamp ? toDosDateTime(timestamp) : { dosTime: entry2.dosTime, dosDate: entry2.dosDate };
    const local = new Uint8Array(30 + nameBytes.length);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, SIG_LOCAL, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(6, 2048, true);
    localView.setUint16(8, method, true);
    localView.setUint16(10, dosTime, true);
    localView.setUint16(12, dosDate, true);
    localView.setUint32(14, crc, true);
    localView.setUint32(18, payload.length, true);
    localView.setUint32(22, entry2.data.length, true);
    localView.setUint16(26, nameBytes.length, true);
    localView.setUint16(28, 0, true);
    local.set(nameBytes, 30);
    const central = new Uint8Array(46 + nameBytes.length);
    const centralView = new DataView(central.buffer);
    centralView.setUint32(0, SIG_CENTRAL, true);
    centralView.setUint16(4, 20, true);
    centralView.setUint16(6, 20, true);
    centralView.setUint16(8, 2048, true);
    centralView.setUint16(10, method, true);
    centralView.setUint16(12, dosTime, true);
    centralView.setUint16(14, dosDate, true);
    centralView.setUint32(16, crc, true);
    centralView.setUint32(20, payload.length, true);
    centralView.setUint32(24, entry2.data.length, true);
    centralView.setUint16(28, nameBytes.length, true);
    centralView.setUint32(38, entry2.externalAttr, true);
    centralView.setUint32(42, offset, true);
    central.set(nameBytes, 46);
    localChunks.push(local, payload);
    centralChunks.push(central);
    offset += local.length + payload.length;
  }
  const centralSize = centralChunks.reduce((sum, c) => sum + c.length, 0);
  const eocd = new Uint8Array(22);
  const eocdView = new DataView(eocd.buffer);
  eocdView.setUint32(0, SIG_EOCD, true);
  eocdView.setUint16(8, entries.length, true);
  eocdView.setUint16(10, entries.length, true);
  eocdView.setUint32(12, centralSize, true);
  eocdView.setUint32(16, offset, true);
  return new Blob([...localChunks, ...centralChunks, eocd], {
    type: "application/octet-stream"
  });
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
var encoder2 = new TextEncoder();
var bytes = (text) => encoder2.encode(text);
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
  entries.forEach((entry2, index) => {
    const at2 = ifd0Start + 2 + index * 12;
    view.setUint16(at2, entry2.tag);
    view.setUint16(at2 + 2, entry2.type);
    view.setUint32(at2 + 4, entry2.count);
    view.setUint32(at2 + 8, entry2.value);
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

// tests/fixtures.ts
var encoder3 = new TextEncoder();
function entry(name, data) {
  return {
    name,
    data: typeof data === "string" ? encoder3.encode(data) : data,
    method: 8,
    dosTime: 0,
    dosDate: 33,
    externalAttr: 0
  };
}
var makeEntries = (files) => Object.entries(files).map(([name, data]) => entry(name, data));
async function toZip(entries) {
  const blob = await writeZip(entries);
  return new Uint8Array(await blob.arrayBuffer());
}
var fromZip = (bytes2) => readZip(bytes2.buffer);
var NS_W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
var NS_R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
var NS_A = "http://schemas.openxmlformats.org/drawingml/2006/main";
var NS_S = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
var NS_P = "http://schemas.openxmlformats.org/presentationml/2006/main";
var RELS = "http://schemas.openxmlformats.org/package/2006/relationships";
var rels = (items) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${RELS}">${items}</Relationships>`;
var rel = (id, type, target, external = false) => `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${target}"${external ? ' TargetMode="External"' : ""}/>`;
var types = (overrides) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="jpeg" ContentType="image/jpeg"/><Default Extension="bin" ContentType="application/vnd.openxmlformats-officedocument.oleObject"/>${overrides}</Types>`;
var override = (part, contentType) => `<Override PartName="/${part}" ContentType="${contentType}"/>`;
function docxEntries() {
  return makeEntries({
    "[Content_Types].xml": types(
      override("word/document.xml", "application/vnd.ms-word.document.macroEnabled.main+xml") + override("word/settings.xml", "application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml") + override("word/comments.xml", "application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml") + override("word/people.xml", "application/vnd.openxmlformats-officedocument.wordprocessingml.people+xml") + override("word/charts/chart1.xml", "application/vnd.openxmlformats-officedocument.drawingml.chart+xml") + override("docProps/core.xml", "application/vnd.openxmlformats-package.core-properties+xml")
    ),
    "_rels/.rels": rels(
      rel("rId1", "officeDocument", "word/document.xml") + `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>`
    ),
    "word/_rels/document.xml.rels": rels(
      rel("rId1", "settings", "settings.xml") + rel("rId2", "comments", "comments.xml") + rel("rId3", "people", "people.xml") + rel("rId4", "image", "media/image1.jpeg") + rel("rId5", "chart", "charts/chart1.xml") + rel("rId6", "hyperlink", "\\\\fileserver\\abteilung\\geheim.docx", true) + rel("rId7", "printerSettings", "printerSettings/printerSettings1.bin") + rel("rId8", "vbaProject", "vbaProject.bin")
    ),
    "word/document.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="${NS_W}" xmlns:r="${NS_R}" xmlns:a="${NS_A}" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml"><w:body><w:p w:rsidR="00A1B2C3" w14:paraId="12345678" w14:textId="87654321"><w:commentRangeStart w:id="1"/><w:r><w:t>Sichtbarer Text.</w:t></w:r><w:commentRangeEnd w:id="1"/><w:r><w:commentReference w:id="1"/></w:r></w:p><w:p><w:ins w:id="9" w:author="Dr. Beispiel" w:date="2024-02-01T10:00:00Z"><w:r><w:t>Eingef\xFCgt.</w:t></w:r></w:ins></w:p><w:p><w:r><w:rPr><w:color w:val="FFFFFF"/></w:rPr><w:t>Unsichtbarer Hinweis</w:t></w:r></w:p><w:p><w:hyperlink r:id="rId6"><w:r><w:t>Netzlaufwerk</w:t></w:r></w:hyperlink></w:p><w:p><w:r><w:drawing><pic:pic><pic:blipFill><a:blip r:embed="rId4"/><a:srcRect l="25000" t="0" r="25000" b="10000"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill></pic:pic></w:drawing></w:r></w:p><w:p><w:r><w:t>Diagramm folgt</w:t></w:r></w:p><w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pageSetup r:id="rId7"/></w:sectPr></w:body></w:document>`,
    "word/settings.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:settings xmlns:w="${NS_W}" xmlns:w15="http://schemas.microsoft.com/office/word/2012/wordml"><w:proofState w:spelling="clean"/><w:mailMerge><w:mainDocumentType w:val="formLetters"/><w:dataSource r:id="rId20" xmlns:r="${NS_R}"/><w:query w:val="SELECT * FROM /Users/max.mustermann/Adressen.xlsx"/></w:mailMerge><w15:docId w15:val="{8A1B2C3D-4E5F-6789-ABCD-EF0123456789}"/><w:rsids><w:rsidRoot w:val="00A1B2C3"/><w:rsid w:val="00A1B2C3"/></w:rsids></w:settings>`,
    "word/comments.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:comments xmlns:w="${NS_W}"><w:comment w:id="1" w:author="Erika Musterfrau" w:initials="EM" w:date="2024-02-01T10:00:00Z"><w:p><w:r><w:t>Bitte pr\xFCfen.</w:t></w:r></w:p></w:comment></w:comments>`,
    "word/people.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w15:people xmlns:w15="http://schemas.microsoft.com/office/word/2012/wordml"><w15:person w15:author="Erika Musterfrau"><w15:presenceInfo w15:providerId="AD" w15:userId="S-1-5-21-1234567890-erika.musterfrau@firma.de"/></w15:person></w15:people>`,
    "word/charts/chart1.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:r="${NS_R}"><c:chart><c:plotArea/></c:chart><c:externalData r:id="rId1"><c:autoUpdate val="0"/></c:externalData></c:chartSpace>`,
    "word/charts/_rels/chart1.xml.rels": rels(
      `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/package" Target="../embeddings/Microsoft_Excel_Worksheet1.xlsx"/>`
    ),
    "word/embeddings/Microsoft_Excel_Worksheet1.xlsx": "PK Umsatzzahlen 2024 Q1 vertraulich",
    "word/media/image1.jpeg": jpegWithMetadata(),
    "word/printerSettings/printerSettings1.bin": "HP LaserJet 4000 im 3. OG, Abteilung Recht",
    "word/vbaProject.bin": "VBA-Modul von Max Mustermann",
    "docProps/core.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:creator>Max Mustermann</dc:creator><cp:lastModifiedBy>Erika Musterfrau</cp:lastModifiedBy></cp:coreProperties>`
  });
}
function xlsxEntries() {
  const sharedStrings = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><sst xmlns="${NS_S}" count="5" uniqueCount="5"><si><t>Sichtbar</t></si><si><t>Gehalt 120000</t></si><si><t>Interne Marge</t></si><si><t>Auch sichtbar</t></si><si><t>Nur im Pivot-Cache</t></si></sst>`;
  return makeEntries({
    "[Content_Types].xml": types(
      override("xl/workbook.xml", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml") + override("xl/worksheets/sheet1.xml", "application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml") + override("xl/worksheets/sheet2.xml", "application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml") + override("xl/sharedStrings.xml", "application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml")
    ),
    "_rels/.rels": rels(rel("rId1", "officeDocument", "xl/workbook.xml")),
    "xl/_rels/workbook.xml.rels": rels(
      rel("rId1", "worksheet", "worksheets/sheet1.xml") + rel("rId2", "worksheet", "worksheets/sheet2.xml") + rel("rId3", "sharedStrings", "sharedStrings.xml") + rel("rId4", "pivotCacheDefinition", "pivotCache/pivotCacheDefinition1.xml") + rel("rId5", "externalLink", "externalLinks/externalLink1.xml")
    ),
    "xl/workbook.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="${NS_S}" xmlns:r="${NS_R}"><sheets><sheet name="Bericht" sheetId="1" r:id="rId1"/><sheet name="Kalkulation intern" sheetId="2" state="veryHidden" r:id="rId2"/></sheets><definedNames><definedName name="Marge">'Kalkulation intern'!$A$1</definedName></definedNames><externalReferences><externalReference r:id="rId5"/></externalReferences></workbook>`,
    "xl/worksheets/_rels/sheet1.xml.rels": rels(rel("rId1", "printerSettings", "../printerSettings/printerSettings1.bin")),
    "xl/worksheets/sheet1.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="${NS_S}" xmlns:r="${NS_R}"><cols><col min="3" max="3" hidden="1" width="10"/></cols><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1" t="s"><v>2</v></c></row><row r="2" hidden="1"><c r="A2" t="s"><v>1</v></c><c r="B2"><v>120000</v></c></row><row r="3"><c r="A3" t="s"><v>3</v></c></row></sheetData><pageSetup r:id="rId1"/></worksheet>`,
    "xl/worksheets/sheet2.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="${NS_S}"><sheetData><row r="1"><c r="A1"><v>0.42</v></c></row></sheetData></worksheet>`,
    "xl/sharedStrings.xml": sharedStrings,
    "xl/pivotCache/pivotCacheDefinition1.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><pivotCacheDefinition xmlns="${NS_S}" xmlns:r="${NS_R}" recordCount="3"><cacheSource type="worksheet"><worksheetSource ref="A1:C4" sheet="Kalkulation intern"/></cacheSource><cacheFields count="1"><cacheField name="Kunde"><sharedItems><s v="Kunde Alpha"/><s v="Kunde Beta"/></sharedItems></cacheField></cacheFields></pivotCacheDefinition>`,
    "xl/pivotCache/pivotCacheRecords1.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><pivotCacheRecords xmlns="${NS_S}" count="3"><r><s v="Kunde Alpha"/><n v="120000"/></r><r><s v="Kunde Beta"/><n v="98000"/></r><r><s v="Kunde Gamma"/><n v="45000"/></r></pivotCacheRecords>`,
    "xl/externalLinks/externalLink1.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><externalLink xmlns="${NS_S}"><externalBook/></externalLink>`,
    "xl/externalLinks/_rels/externalLink1.xml.rels": rels(
      rel("rId1", "externalLinkPath", "file:///Users/max.mustermann/Kalkulation.xlsx", true)
    ),
    "xl/printerSettings/printerSettings1.bin": "Drucker Buchhaltung"
  });
}
function pptxEntries() {
  return makeEntries({
    "[Content_Types].xml": types(
      override("ppt/presentation.xml", "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml") + override("ppt/slides/slide1.xml", "application/vnd.openxmlformats-officedocument.presentationml.slide+xml") + override("ppt/slides/slide2.xml", "application/vnd.openxmlformats-officedocument.presentationml.slide+xml") + override("ppt/notesSlides/notesSlide1.xml", "application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml") + override("ppt/commentAuthors.xml", "application/vnd.openxmlformats-officedocument.presentationml.commentAuthors+xml")
    ),
    "_rels/.rels": rels(rel("rId1", "officeDocument", "ppt/presentation.xml")),
    "ppt/_rels/presentation.xml.rels": rels(
      rel("rId1", "slide", "slides/slide1.xml") + rel("rId2", "slide", "slides/slide2.xml") + rel("rId3", "commentAuthors", "commentAuthors.xml")
    ),
    "ppt/presentation.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:presentation xmlns:p="${NS_P}" xmlns:r="${NS_R}"><p:sldIdLst><p:sldId id="256" r:id="rId1"/><p:sldId id="257" r:id="rId2"/></p:sldIdLst></p:presentation>`,
    "ppt/slides/_rels/slide1.xml.rels": rels(rel("rId1", "notesSlide", "../notesSlides/notesSlide1.xml")),
    "ppt/slides/slide1.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sld xmlns:p="${NS_P}" xmlns:p14="http://schemas.microsoft.com/office/powerpoint/2010/main"><p14:creationId val="1234567890"/><p:cSld><p:spTree/></p:cSld></p:sld>`,
    "ppt/slides/slide2.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sld xmlns:p="${NS_P}" show="0"><p:cSld><p:spTree>Nicht gezeigte Zahlen</p:spTree></p:cSld></p:sld>`,
    "ppt/notesSlides/notesSlide1.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:notes xmlns:p="${NS_P}"><p:cSld><p:spTree>Hier nicht erw\xE4hnen, dass der Vertrag noch nicht unterschrieben ist</p:spTree></p:cSld></p:notes>`,
    "ppt/commentAuthors.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:cmAuthorLst xmlns:p="${NS_P}"><p:cmAuthor id="1" name="Dr. Beispiel" initials="DB"/></p:cmAuthorLst>`
  });
}

// tests/ooxmlDeepClean.test.ts
var allOn = Object.fromEntries(
  Object.keys(DEFAULT_DEEP_OPTIONS).map((key) => [key, true])
);
var ids = (entries) => scanDeep(entries).map((f) => f.id);
var packageText = (entries) => entries.map((e) => decodeText(e.data)).join("\n");
await test("Word: alle Fundstellen werden erkannt", () => {
  const found = ids(docxEntries());
  for (const expected of [
    "imageMetadata",
    "croppedImages",
    "printerSettings",
    "externalLinks",
    "mailMerge",
    "documentIds",
    "chartWorkbooks",
    "macros",
    "authors",
    "whiteText"
  ]) {
    assert(found.includes(expected), `"${expected}" fehlt, gefunden: ${found.join(", ")}`);
  }
  const images = scanDeep(docxEntries()).find((f) => f.id === "imageMetadata");
  includes(images?.detail ?? "", "GPS", "GPS-Fund nicht im Bericht");
  equal(images?.severity, "hoch", "GPS muss hohe Einstufung haben");
  const authors = scanDeep(docxEntries()).find((f) => f.id === "authors");
  includes(authors?.detail ?? "", "Erika Musterfrau", "Kommentarautorin nicht gefunden");
  includes(authors?.detail ?? "", "Dr. Beispiel", "Autor der \xC4nderungsverfolgung nicht gefunden");
});
await test("Excel: versteckte Bl\xE4tter, Zeilen und Pivot-Cache werden erkannt", () => {
  const findings = scanDeep(xlsxEntries());
  const found = findings.map((f) => f.id);
  for (const expected of ["hiddenSheets", "hiddenRowsCols", "pivotCache", "externalLinks", "printerSettings"]) {
    assert(found.includes(expected), `"${expected}" fehlt, gefunden: ${found.join(", ")}`);
  }
  includes(findings.find((f) => f.id === "hiddenSheets")?.detail ?? "", "Kalkulation intern", "Blattname fehlt");
  includes(findings.find((f) => f.id === "pivotCache")?.label ?? "", "3", "Datensatzzahl fehlt");
  includes(findings.find((f) => f.id === "hiddenRowsCols")?.label ?? "", "1 ausgeblendete Zeilen", "Zeilenzahl falsch");
});
await test("PowerPoint: ausgeblendete Folien und Notizen werden erkannt", () => {
  const found = ids(pptxEntries());
  for (const expected of ["hiddenSlides", "speakerNotes", "documentIds", "authors"]) {
    assert(found.includes(expected), `"${expected}" fehlt, gefunden: ${found.join(", ")}`);
  }
});
await test("Eine saubere Datei meldet nichts", () => {
  const clean = [
    { name: "[Content_Types].xml", data: new TextEncoder().encode("<Types/>"), method: 8, dosTime: 0, dosDate: 33, externalAttr: 0 }
  ];
  equal(scanDeep(clean).length, 0, "Falscher Alarm bei sauberer Datei");
});
await test("Word: Bereinigung entfernt jede gefundene Spur", async () => {
  const entries = docxEntries();
  const { steps } = await applyDeepClean(entries, allOn);
  const text = packageText(entries);
  excludes(text, "ACME Cameras", "Kamera-Metadaten im Bild geblieben");
  excludes(text, "SN-12345678", "Seriennummer im Bild geblieben");
  excludes(text, "HP LaserJet", "Druckereinstellungen geblieben");
  excludes(text, "fileserver", "Netzwerkpfad geblieben");
  excludes(text, "Adressen.xlsx", "Seriendruckquelle geblieben");
  excludes(text, "8A1B2C3D", "Dokument-GUID geblieben");
  excludes(text, "w14:paraId", "Absatz-IDs geblieben");
  excludes(text, "Umsatzzahlen 2024", "Diagramm-Arbeitsmappe geblieben");
  excludes(text, "VBA-Modul", "Makro geblieben");
  excludes(text, "Erika Musterfrau", "Autorenname geblieben");
  excludes(text, "Dr. Beispiel", "Autorenname geblieben");
  excludes(text, "erika.musterfrau@firma.de", "Pr\xE4senzinfo mit E-Mail geblieben");
  includes(text, "Sichtbarer Text", "Inhalt wurde zerst\xF6rt");
  includes(text, "Autor 1", "Ersatzname nicht gesetzt");
  assert(steps.length >= 8, `Zu wenige Schritte protokolliert: ${steps.length}`);
  const macroStep = steps.find((s) => s.option === "removeMacros");
  includes(macroStep?.summary ?? "", "makrofrei", "Formatwechsel nicht protokolliert");
});
await test("Word: Makroentfernung korrigiert Inhaltstyp und Dateiendung", async () => {
  const entries = docxEntries();
  await applyDeepClean(entries, { ...DEFAULT_DEEP_OPTIONS, removeMacros: true });
  const types2 = textOf(entries, "[Content_Types].xml") ?? "";
  excludes(types2, "macroEnabled", "Makro-Inhaltstyp geblieben");
  includes(types2, "wordprocessingml.document.main+xml", "Ersatz-Inhaltstyp fehlt");
  equal(findEntry(entries, "word/vbaProject.bin"), void 0, "VBA-Teil noch vorhanden");
  equal(macroFreeExtension("Bericht.docm"), "docx", "Endung nicht umgesetzt");
  equal(macroFreeExtension("Bericht.docx"), void 0, "Endung f\xE4lschlich ge\xE4ndert");
});
await test("Word: entfernte Verweise hinterlassen keine toten Relationship-IDs", async () => {
  const entries = docxEntries();
  await applyDeepClean(entries, allOn);
  const documentRels = textOf(entries, "word/_rels/document.xml.rels") ?? "";
  const document = textOf(entries, "word/document.xml") ?? "";
  const declared = Array.from(documentRels.matchAll(/Id="([^"]+)"/g)).map((m) => m[1]);
  const referenced = Array.from(document.matchAll(/r:(?:id|embed)="([^"]+)"/g)).map((m) => m[1]);
  for (const id of referenced) {
    assert(declared.includes(id), `Verweis ${id} zeigt ins Leere`);
  }
  excludes(document, "rId6", "Hyperlink-Verweis nicht entfernt");
  excludes(document, "rId7", "Druckerverweis nicht entfernt");
});
await test("Word: Bildbereinigung l\xE4sst das Bild selbst intakt", async () => {
  const entries = docxEntries();
  await applyDeepClean(entries, { ...DEFAULT_DEEP_OPTIONS, stripImageMetadata: true });
  const image = findEntry(entries, "word/media/image1.jpeg");
  assert(image, "Bild wurde entfernt");
  equal(image.data[0], true ? 255 : 0, "JPEG-Signatur zerst\xF6rt");
  equal(image.data[1], 216, "JPEG-Signatur zerst\xF6rt");
});
await test("Zuschnitt kann in Node nicht entfernt werden und wird als \xFCbersprungen gemeldet", async () => {
  const entries = docxEntries();
  const { steps } = await applyDeepClean(entries, { ...DEFAULT_DEEP_OPTIONS, flattenCroppedImages: true });
  const step = steps.find((s) => s.option === "flattenCroppedImages");
  assert(step, "Kein Protokolleintrag zum Zuschnitt");
  includes(step.summary, "\xFCbersprungen", "\xDCbersprungener Zuschnitt nicht als solcher gemeldet");
});
await test("Excel: Pivot-Cache wird geleert und Aktualisierung erzwungen", async () => {
  const entries = xlsxEntries();
  await applyDeepClean(entries, { ...DEFAULT_DEEP_OPTIONS, clearPivotCaches: true });
  const records = textOf(entries, "xl/pivotCache/pivotCacheRecords1.xml") ?? "";
  excludes(records, "Kunde Alpha", "Cache-Datens\xE4tze geblieben");
  includes(records, 'count="0"', "Datensatzzahl nicht zur\xFCckgesetzt");
  const definition = textOf(entries, "xl/pivotCache/pivotCacheDefinition1.xml") ?? "";
  excludes(definition, "Kunde Beta", "sharedItems geblieben");
  includes(definition, 'refreshOnLoad="1"', "Aktualisierung nicht erzwungen");
  includes(definition, 'recordCount="0"', "recordCount nicht zur\xFCckgesetzt");
});
await test("Excel: ausgeblendetes Blatt wird samt Namensverweis gel\xF6scht", async () => {
  const entries = xlsxEntries();
  await applyDeepClean(entries, { ...DEFAULT_DEEP_OPTIONS, removeHiddenSheets: true });
  equal(findEntry(entries, "xl/worksheets/sheet2.xml"), void 0, "Blattdatei noch vorhanden");
  const workbook = textOf(entries, "xl/workbook.xml") ?? "";
  excludes(workbook, "Kalkulation intern", "Blattname noch in der Mappe");
  const workbookRels = textOf(entries, "xl/_rels/workbook.xml.rels") ?? "";
  excludes(workbookRels, "worksheets/sheet2.xml", "Beziehung zum Blatt geblieben");
  includes(workbook, "Bericht", "Sichtbares Blatt wurde mitgel\xF6scht");
});
await test("Excel: ausgeblendete Zeilen und Spalten werden geleert, Texttabelle bereinigt", async () => {
  const entries = xlsxEntries();
  const { steps } = await applyDeepClean(entries, { ...DEFAULT_DEEP_OPTIONS, clearHiddenRowsCols: true });
  const sheet = textOf(entries, "xl/worksheets/sheet1.xml") ?? "";
  excludes(sheet, 'r="A2"', "Zelle der ausgeblendeten Zeile geblieben");
  excludes(sheet, 'r="B2"', "Zelle der ausgeblendeten Zeile geblieben");
  excludes(sheet, 'r="C1"', "Zelle der ausgeblendeten Spalte geblieben");
  includes(sheet, 'r="A1"', "Sichtbare Zelle wurde gel\xF6scht");
  includes(sheet, 'r="A3"', "Sichtbare Zelle wurde gel\xF6scht");
  const shared = textOf(entries, "xl/sharedStrings.xml") ?? "";
  excludes(shared, "Gehalt 120000", "Text der ausgeblendeten Zeile noch in der Texttabelle");
  excludes(shared, "Interne Marge", "Text der ausgeblendeten Spalte noch in der Texttabelle");
  includes(shared, "Sichtbar", "Sichtbarer Text verloren");
  includes(shared, "Auch sichtbar", "Sichtbarer Text verloren");
  const remaining = Array.from(shared.matchAll(/<t>([^<]*)<\/t>/g)).map((m) => m[1]);
  const a1 = /<c r="A1" t="s"><v>(\d+)<\/v>/.exec(sheet)?.[1];
  const a3 = /<c r="A3" t="s"><v>(\d+)<\/v>/.exec(sheet)?.[1];
  equal(remaining[Number(a1)], "Sichtbar", "A1 zeigt auf den falschen Text");
  equal(remaining[Number(a3)], "Auch sichtbar", "A3 zeigt auf den falschen Text");
  const step = steps.find((s) => s.option === "clearHiddenRowsCols");
  includes(step?.summary ?? "", "Zeichenkettentabelle", "Bereinigung der Texttabelle nicht protokolliert");
});
await test("Excel: externe Verkn\xFCpfungen und Druckereinstellungen verschwinden", async () => {
  const entries = xlsxEntries();
  await applyDeepClean(entries, { ...DEFAULT_DEEP_OPTIONS, removeExternalLinks: true, removePrinterSettings: true });
  const text = packageText(entries);
  excludes(text, "max.mustermann", "Benutzerpfad geblieben");
  excludes(text, "Drucker Buchhaltung", "Druckereinstellungen geblieben");
  excludes(textOf(entries, "xl/workbook.xml") ?? "", "externalReferences", "Verweisblock geblieben");
  excludes(textOf(entries, "xl/worksheets/sheet1.xml") ?? "", "r:id", "pageSetup-Verweis zeigt ins Leere");
});
await test("PowerPoint: ausgeblendete Folie und Notizen werden entfernt", async () => {
  const entries = pptxEntries();
  await applyDeepClean(entries, allOn);
  const text = packageText(entries);
  excludes(text, "Nicht gezeigte Zahlen", "Ausgeblendete Folie geblieben");
  excludes(text, "noch nicht unterschrieben", "Notizen geblieben");
  excludes(text, "Dr. Beispiel", "Kommentarautor geblieben");
  excludes(text, "p14:creationId", "Folien-GUID geblieben");
  const presentation = textOf(entries, "ppt/presentation.xml") ?? "";
  excludes(presentation, "rId2", "Verweis auf die gel\xF6schte Folie geblieben");
  includes(presentation, "rId1", "Verweis auf die sichtbare Folie verloren");
});
await test("Bereinigtes Paket \xFCberlebt einen ZIP-Umlauf", async () => {
  const entries = docxEntries();
  await applyDeepClean(entries, allOn);
  const roundTripped = await fromZip(await toZip(entries));
  equal(roundTripped.length, entries.length, "Teilanzahl nach ZIP-Umlauf verschieden");
  const text = packageText(roundTripped);
  excludes(text, "Erika Musterfrau", "Name nach ZIP-Umlauf wieder da");
  includes(text, "Sichtbarer Text", "Inhalt nach ZIP-Umlauf verloren");
});
await test("Zweiter Durchlauf findet nichts mehr", async () => {
  const entries = docxEntries();
  await applyDeepClean(entries, allOn);
  const remaining = scanDeep(entries).filter((f) => f.option).filter((f) => f.id !== "croppedImages");
  equal(remaining.length, 0, `Nach der Bereinigung bleiben Funde: ${remaining.map((f) => f.id).join(", ")}`);
});
