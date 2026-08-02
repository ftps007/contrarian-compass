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
    const fourcc2 = ascii(bytes2, offset, 4);
    const size = view.getUint32(offset + 4, true);
    const padded = size + size % 2;
    const chunk = bytes2.subarray(offset, offset + 8 + padded);
    if (fourcc2 === "EXIF" || fourcc2 === "XMP ") sawMetadata = true;
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
    const rels = relsPathFor(name);
    if (findEntry(entries, rels)) withRels.add(rels);
  }
  for (const name of Array.from(withRels)) {
    const index = entries.findIndex((e) => e.name === name);
    if (index >= 0) entries.splice(index, 1);
  }
  const typesXml = textOf(entries, CONTENT_TYPES);
  if (typesXml) {
    const doc = parseXml(typesXml, CONTENT_TYPES);
    for (const override of Array.from(doc.getElementsByTagNameNS(NS.ct, "Override"))) {
      const partName = (override.getAttribute("PartName") ?? "").replace(/^\//, "");
      if (withRels.has(partName)) override.parentNode?.removeChild(override);
    }
    setText(entries, CONTENT_TYPES, serializeXml(doc));
  }
  for (const entry2 of entries.filter((e) => e.name.endsWith(".rels"))) {
    const doc = parseXml(decoder.decode(entry2.data), entry2.name);
    let changed = false;
    for (const rel of Array.from(doc.getElementsByTagNameNS(NS.rel, "Relationship"))) {
      if (rel.getAttribute("TargetMode") === "External") continue;
      if (withRels.has(resolveTarget(entry2.name, rel.getAttribute("Target") ?? ""))) {
        rel.parentNode?.removeChild(rel);
        changed = true;
      }
    }
    if (changed) entry2.data = encoder.encode(serializeXml(doc));
  }
  return removed;
}

// lib/odf.ts
var ODF_NS = {
  office: "urn:oasis:names:tc:opendocument:xmlns:office:1.0",
  meta: "urn:oasis:names:tc:opendocument:xmlns:meta:1.0",
  dc: "http://purl.org/dc/elements/1.1/",
  text: "urn:oasis:names:tc:opendocument:xmlns:text:1.0"
};
var META_PART = "meta.xml";
var PICTURES = /^Pictures\//;
var ODF_FIELDS = [
  { key: "title", label: "Titel", ns: ODF_NS.dc, prefix: "dc", tag: "title", kind: "text" },
  { key: "subject", label: "Thema", ns: ODF_NS.dc, prefix: "dc", tag: "subject", kind: "text" },
  { key: "description", label: "Kommentare", ns: ODF_NS.dc, prefix: "dc", tag: "description", kind: "text" },
  { key: "keyword", label: "Stichw\xF6rter", ns: ODF_NS.meta, prefix: "meta", tag: "keyword", kind: "text" },
  { key: "initial-creator", label: "Autor", ns: ODF_NS.meta, prefix: "meta", tag: "initial-creator", kind: "text" },
  { key: "creator", label: "Zuletzt ge\xE4ndert von", ns: ODF_NS.dc, prefix: "dc", tag: "creator", kind: "text" },
  { key: "creation-date", label: "Erstellt am", ns: ODF_NS.meta, prefix: "meta", tag: "creation-date", kind: "datetime" },
  { key: "date", label: "Ge\xE4ndert am", ns: ODF_NS.dc, prefix: "dc", tag: "date", kind: "datetime" },
  { key: "print-date", label: "Zuletzt gedruckt", ns: ODF_NS.meta, prefix: "meta", tag: "print-date", kind: "datetime" },
  { key: "printed-by", label: "Gedruckt von", ns: ODF_NS.meta, prefix: "meta", tag: "printed-by", kind: "text" },
  { key: "generator", label: "Erstellt mit", ns: ODF_NS.meta, prefix: "meta", tag: "generator", kind: "text" },
  { key: "editing-cycles", label: "Bearbeitungszyklen", ns: ODF_NS.meta, prefix: "meta", tag: "editing-cycles", kind: "number" },
  { key: "editing-duration", label: "Bearbeitungsdauer", ns: ODF_NS.meta, prefix: "meta", tag: "editing-duration", kind: "text" }
];
function isOdfPackage(entries) {
  const mimetype = textOf(entries, "mimetype") ?? "";
  return mimetype.startsWith("application/vnd.oasis.opendocument") || Boolean(findEntry(entries, META_PART));
}
function readOdfFields(entries) {
  const values = {};
  const xml = textOf(entries, META_PART);
  if (!xml) return values;
  const doc = parseXml(xml, META_PART);
  for (const field of ODF_FIELDS) {
    const nodes = doc.getElementsByTagNameNS(field.ns, field.tag);
    values[field.key] = nodes.length > 0 ? nodes[0].textContent ?? "" : "";
  }
  return values;
}
function writeOdfFields(entries, values) {
  const xml = textOf(entries, META_PART);
  if (!xml) return;
  const doc = parseXml(xml, META_PART);
  const meta = doc.getElementsByTagNameNS(ODF_NS.office, "meta")[0] ?? doc.documentElement;
  for (const field of ODF_FIELDS) {
    const value = (values[field.key] ?? "").trim();
    const nodes = Array.from(doc.getElementsByTagNameNS(field.ns, field.tag));
    if (value === "") {
      for (const node2 of nodes) node2.parentNode?.removeChild(node2);
      continue;
    }
    const node = nodes[0] ?? meta.appendChild(doc.createElementNS(field.ns, `${field.prefix}:${field.tag}`));
    node.textContent = value;
  }
  for (const stat of Array.from(doc.getElementsByTagNameNS(ODF_NS.meta, "document-statistic"))) {
    stat.parentNode?.removeChild(stat);
  }
  setText(entries, META_PART, serializeXml(doc));
}
var DEFAULT_ODF_CLEAN = {
  removeThumbnail: true,
  stripImageMetadata: true,
  anonymizeAuthors: false,
  removeUserFields: true
};
function scanOdf(entries) {
  const findings = [];
  const names = entries.map((e) => e.name);
  const images = entries.filter((e) => PICTURES.test(e.name) && inspectImage(e.data).length > 0);
  if (images.length > 0) {
    findings.push({
      id: "imageMetadata",
      label: `Metadaten in ${images.length} eingebetteten Bild(ern)`,
      detail: "Auch LibreOffice \xFCbernimmt EXIF-Daten samt GPS-Position unver\xE4ndert in das Dokument.",
      severity: "hoch"
    });
  }
  if (names.some((n) => n.startsWith("Thumbnails/"))) {
    findings.push({
      id: "thumbnail",
      label: "Vorschaubild",
      detail: "Zeigt die erste Seite in einem m\xF6glicherweise \xE4lteren Stand.",
      severity: "mittel"
    });
  }
  const content = textOf(entries, "content.xml") ?? "";
  const authors = Array.from(content.matchAll(/<dc:creator>([^<]+)<\/dc:creator>/g)).map((m) => m[1]);
  if (authors.length > 0) {
    findings.push({
      id: "authors",
      label: `${new Set(authors).size} Personenname(n) in Kommentaren und \xC4nderungen`,
      detail: `Gefunden: ${Array.from(new Set(authors)).join(", ")}.`,
      severity: "hoch"
    });
  }
  if (content.includes("<text:tracked-changes")) {
    findings.push({
      id: "trackedChanges",
      label: "Nachverfolgte \xC4nderungen",
      detail: 'Enthalten Autorennamen und Zeitpunkte. In LibreOffice \xFCber \u201EBearbeiten \u2192 \xC4nderungen \u2192 Alle akzeptieren" bereinigen.',
      severity: "hoch"
    });
  }
  const meta = textOf(entries, META_PART) ?? "";
  if (meta.includes("<meta:user-defined")) {
    findings.push({
      id: "userFields",
      label: "Benutzerdefinierte Felder",
      detail: "Freie Felder in meta.xml, oft von Vorlagen mit Aktenzeichen oder K\xFCrzeln gef\xFCllt.",
      severity: "mittel"
    });
  }
  return findings;
}
function cleanOdf(entries, options) {
  const steps = [];
  if (options.removeThumbnail) {
    const removed = removeParts(entries, (name) => name.startsWith("Thumbnails/"));
    if (removed.length > 0) steps.push("Vorschaubild entfernt");
  }
  if (options.stripImageMetadata) {
    let cleaned = 0;
    for (const entry2 of entries) {
      if (!PICTURES.test(entry2.name)) continue;
      const stripped = stripImageMetadata(entry2.data);
      if (stripped.length !== entry2.data.length) {
        entry2.data = stripped;
        cleaned++;
      }
    }
    if (cleaned > 0) steps.push(`EXIF/XMP aus ${cleaned} Bild(ern) entfernt`);
  }
  if (options.removeUserFields) {
    const touched = editParts(
      entries,
      (name) => name === META_PART,
      (xml) => xml.replace(/<meta:user-defined[\s\S]*?<\/meta:user-defined>/g, "").replace(/<meta:user-defined[^/>]*\/>/g, "")
    );
    if (touched.length > 0) steps.push("Benutzerdefinierte Felder entfernt");
  }
  if (options.anonymizeAuthors) {
    const content = textOf(entries, "content.xml") ?? "";
    const authors = Array.from(new Set(Array.from(content.matchAll(/<dc:creator>([^<]+)<\/dc:creator>/g)).map((m) => m[1]))).filter((name) => !/^Autor \d+$/.test(name));
    if (authors.length > 0) {
      const mapping = new Map(authors.map((name, index) => [name, `Autor ${index + 1}`]));
      editParts(
        entries,
        (name) => name.endsWith(".xml"),
        (xml) => {
          let next = xml;
          for (const [from, to] of Array.from(mapping.entries())) {
            const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            next = next.replace(new RegExp(`(<dc:creator>)${escaped}(</dc:creator>)`, "g"), `$1${to}$2`);
          }
          return next;
        }
      );
      steps.push(`${mapping.size} Name(n) ersetzt: ${Array.from(mapping.entries()).map(([f, t]) => `${f} \u2192 ${t}`).join(", ")}`);
    }
  }
  return steps;
}

// lib/rtf.ts
var RTF_FIELDS = [
  { key: "title", label: "Titel", control: "title", kind: "text" },
  { key: "subject", label: "Thema", control: "subject", kind: "text" },
  { key: "author", label: "Autor", control: "author", kind: "text" },
  { key: "operator", label: "Zuletzt ge\xE4ndert von", control: "operator", kind: "text" },
  { key: "keywords", label: "Stichw\xF6rter", control: "keywords", kind: "text" },
  { key: "comment", label: "Kommentare", control: "doccomm", kind: "text" },
  { key: "company", label: "Firma", control: "company", kind: "text" },
  { key: "category", label: "Kategorie", control: "category", kind: "text" },
  { key: "manager", label: "Vorgesetzter", control: "manager", kind: "text" },
  { key: "version", label: "Version", control: "vern", kind: "number" },
  { key: "editingTime", label: "Bearbeitungszeit (Min.)", control: "edmins", kind: "number" },
  { key: "revisions", label: "Revisionsnummer", control: "nofrev", kind: "number" }
];
var isRtf = (text) => text.trimStart().startsWith("{\\rtf");
function groupEnd(text, start) {
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    const char = text[i];
    if (char === "\\") {
      i++;
      continue;
    }
    if (char === "{") depth++;
    else if (char === "}") {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return text.length;
}
function findGroup(text, control) {
  const marker = `{\\${control}`;
  const start = text.indexOf(marker);
  if (start < 0) return null;
  const next = text[start + marker.length];
  if (next && /[a-z0-9]/i.test(next)) return null;
  return { start, end: groupEnd(text, start) };
}
function readRtfFields(text) {
  const values = {};
  const info = findGroup(text, "info");
  if (!info) return values;
  const block = text.slice(info.start, info.end);
  for (const field of RTF_FIELDS) {
    if (field.kind === "number") {
      const match = new RegExp(`\\\\${field.control}(-?\\d+)`).exec(block);
      values[field.key] = match ? match[1] : "";
      continue;
    }
    const group = findGroup(block, field.control);
    if (!group) {
      values[field.key] = "";
      continue;
    }
    const inner = block.slice(group.start, group.end).replace(new RegExp(`^\\{\\\\${field.control}\\s?`), "").replace(/\}$/, "");
    values[field.key] = decodeRtfText(inner);
  }
  return values;
}
function decodeRtfText(input) {
  let out = "";
  let i = 0;
  while (i < input.length) {
    const char = input[i];
    if (char !== "\\") {
      out += char;
      i++;
      continue;
    }
    const next = input[i + 1];
    if (next === "\\" || next === "{" || next === "}") {
      out += next;
      i += 2;
      continue;
    }
    if (next === "'") {
      out += String.fromCharCode(parseInt(input.substr(i + 2, 2), 16));
      i += 4;
      continue;
    }
    const unicode = /^\\u(-?\d+)\s?\??/.exec(input.slice(i));
    if (unicode) {
      const code = Number(unicode[1]);
      out += String.fromCharCode(code < 0 ? code + 65536 : code);
      i += unicode[0].length;
      continue;
    }
    const control = /^\\([a-z]+)(-?\d+)?\s?/i.exec(input.slice(i));
    if (control) {
      i += control[0].length;
      continue;
    }
    i += 2;
  }
  return out.trim();
}
function escapeRtf(value) {
  return value.replace(/[\\{}]/g, (char) => `\\${char}`).replace(/[^\x20-\x7e]/g, (char) => `\\u${char.charCodeAt(0)}?`);
}
function writeRtfFields(text, values) {
  const parts = [];
  for (const field of RTF_FIELDS) {
    const value = (values[field.key] ?? "").trim();
    if (value === "") continue;
    if (field.kind === "number") {
      if (/^-?\d+$/.test(value)) parts.push(`\\${field.control}${value}`);
    } else {
      parts.push(`{\\${field.control} ${escapeRtf(value)}}`);
    }
  }
  const info = parts.length > 0 ? `{\\info${parts.join("")}}` : "";
  const existing = findGroup(text, "info");
  if (existing) return text.slice(0, existing.start) + info + text.slice(existing.end);
  if (!info) return text;
  const insertAt = text.indexOf("{\\fonttbl") >= 0 ? text.indexOf("{\\fonttbl") : text.indexOf("}") + 1;
  return text.slice(0, insertAt) + info + text.slice(insertAt);
}
function scanRtf(text) {
  const findings = [];
  const revisionAuthors = collectRevisionAuthors(text);
  if (revisionAuthors.length > 0) {
    findings.push({
      id: "authors",
      label: `${revisionAuthors.length} Name(n) in der Revisionstabelle`,
      detail: `Gefunden: ${revisionAuthors.join(", ")}. RTF f\xFChrt jede Person, die je im Dokument gespeichert hat.`,
      severity: "hoch"
    });
  }
  if (/\\\*\\generator/.test(text)) {
    findings.push({
      id: "generator",
      label: "Erzeugerkennung",
      detail: "Nennt Programm und Version, mit denen die Datei geschrieben wurde.",
      severity: "niedrig"
    });
  }
  if (/\\\*\\atnauthor|\\annotation/.test(text)) {
    findings.push({
      id: "annotations",
      label: "Kommentare mit Autorennamen",
      detail: "RTF speichert Kommentarautoren im Klartext neben dem Text.",
      severity: "hoch"
    });
  }
  if (/\\revised|\\deleted/.test(text)) {
    findings.push({
      id: "trackedChanges",
      label: "Nachverfolgte \xC4nderungen",
      detail: "Gel\xF6schter Text bleibt als \\deleted im Dokument stehen und ist lesbar.",
      severity: "hoch"
    });
  }
  return findings;
}
function collectRevisionAuthors(text) {
  const table = findGroup(text, "*\\revtbl");
  const authors = /* @__PURE__ */ new Set();
  if (table) {
    const block = text.slice(table.start, table.end);
    for (const match of Array.from(block.matchAll(/\{([^{}\\;]+);?\}/g))) {
      const name = match[1].trim();
      if (name && name !== "Unknown") authors.add(name);
    }
  }
  for (const match of Array.from(text.matchAll(/\\\*\\atnauthor\s+([^\\{}]+)/g))) {
    const name = match[1].trim();
    if (name) authors.add(name);
  }
  return Array.from(authors);
}
var DEFAULT_RTF_CLEAN = {
  removeGenerator: true,
  removeRevisionTable: true,
  anonymizeAuthors: false
};
function cleanRtf(text, options) {
  let out = text;
  const steps = [];
  if (options.removeGenerator) {
    const generator = findGroup(out, "*\\generator");
    if (generator) {
      out = out.slice(0, generator.start) + out.slice(generator.end);
      steps.push("Erzeugerkennung entfernt");
    }
  }
  if (options.removeRevisionTable) {
    const table = findGroup(out, "*\\revtbl");
    if (table) {
      out = out.slice(0, table.start) + out.slice(table.end);
      steps.push("Revisionstabelle entfernt");
    }
  }
  if (options.anonymizeAuthors) {
    const authors = collectRevisionAuthors(out).filter((name) => !/^Autor \d+$/.test(name));
    if (authors.length > 0) {
      authors.forEach((name, index) => {
        const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        out = out.replace(new RegExp(`(\\\\\\*\\\\atnauthor\\s+)${escaped}`, "g"), `$1Autor ${index + 1}`);
      });
      steps.push(`${authors.length} Name(n) in Kommentaren ersetzt`);
    }
  }
  return { text: out, steps };
}

// lib/mediaMeta.ts
var dec2 = new TextDecoder("latin1");
var fourcc = (bytes2, at) => dec2.decode(bytes2.subarray(at, at + 4));
function detectMedia(bytes2) {
  if (bytes2.length > 12 && fourcc(bytes2, 4) === "ftyp") return "mp4";
  if (bytes2.length > 10 && dec2.decode(bytes2.subarray(0, 3)) === "ID3") return "mp3";
  if (bytes2.length > 2 && bytes2[0] === 255 && (bytes2[1] & 224) === 224) return "mp3";
  return "unknown";
}
function syncSafe(bytes2, at) {
  return bytes2[at] << 21 | bytes2[at + 1] << 14 | bytes2[at + 2] << 7 | bytes2[at + 3];
}
function id3v2Length(bytes2) {
  if (bytes2.length < 10 || dec2.decode(bytes2.subarray(0, 3)) !== "ID3") return 0;
  const footer = (bytes2[5] & 16) !== 0 ? 10 : 0;
  return 10 + syncSafe(bytes2, 6) + footer;
}
var hasId3v1 = (bytes2) => bytes2.length > 128 && dec2.decode(bytes2.subarray(bytes2.length - 128, bytes2.length - 125)) === "TAG";
function inspectMedia(bytes2) {
  const findings = [];
  const format = detectMedia(bytes2);
  if (format === "mp3") {
    const length = id3v2Length(bytes2);
    if (length > 0) {
      findings.push({ label: "ID3v2-Tag", value: `${Math.round(length / 1024)} KB` });
      const head = dec2.decode(bytes2.subarray(0, Math.min(length, 4096)));
      if (/TPE1|TCOM|TOPE/.test(head)) findings.push({ label: "Interpret-/Urheberangaben" });
      if (/COMM|TXXX/.test(head)) findings.push({ label: "Freitext-Kommentare" });
      if (/PRIV/.test(head)) findings.push({ label: "Programmspezifische Daten (PRIV)" });
    }
    if (hasId3v1(bytes2)) findings.push({ label: "ID3v1-Tag" });
    return findings;
  }
  if (format === "mp4") {
    for (const box of findBoxes(bytes2)) {
      if (box.type === "udta") findings.push({ label: "Benutzerdaten (udta)" });
      else if (box.type === "meta") findings.push({ label: "Metadaten-Box (meta)" });
      else if (box.type === "uuid") findings.push({ label: "XMP-Block" });
      const text = dec2.decode(bytes2.subarray(box.start, Math.min(box.end, box.start + 2048)));
      if (/©xyz|loci/.test(text)) findings.push({ label: "GPS-Position" });
      if (/©too|©swr/.test(text)) findings.push({ label: "Aufnahme-Software" });
    }
    const seen = /* @__PURE__ */ new Set();
    return findings.filter((f) => seen.has(f.label) ? false : (seen.add(f.label), true));
  }
  return findings;
}
function findBoxes(bytes2) {
  const view = new DataView(bytes2.buffer, bytes2.byteOffset, bytes2.byteLength);
  const boxes = [];
  const walk = (from, to, depth) => {
    let offset = from;
    while (offset + 8 <= to) {
      let size = view.getUint32(offset);
      let headerSize = 8;
      if (size === 1) {
        if (offset + 16 > to) break;
        size = Number(view.getBigUint64(offset + 8));
        headerSize = 16;
      } else if (size === 0) {
        size = to - offset;
      }
      if (size < headerSize || offset + size > to) break;
      const type = fourcc(bytes2, offset + 4);
      boxes.push({ type, start: offset, end: offset + size, headerSize });
      if ((type === "moov" || type === "trak" || type === "mdia") && depth < 3) {
        walk(offset + headerSize, offset + size, depth + 1);
      }
      offset += size;
    }
  };
  walk(0, bytes2.length, 0);
  return boxes;
}
function stripMediaMetadata(bytes2) {
  const format = detectMedia(bytes2);
  if (format === "mp3") {
    const start = id3v2Length(bytes2);
    const end = hasId3v1(bytes2) ? bytes2.length - 128 : bytes2.length;
    if (start === 0 && end === bytes2.length) return bytes2;
    return bytes2.slice(start, end);
  }
  if (format === "mp4") {
    const boxes = findBoxes(bytes2).filter((b) => b.type === "udta" || b.type === "meta" || b.type === "uuid");
    const outer = boxes.filter((box) => !boxes.some((other) => other !== box && box.start > other.start && box.end <= other.end));
    if (outer.length === 0) return bytes2;
    const out = bytes2.slice();
    const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
    for (const box of outer) {
      out.fill(0, box.start + 8, box.end);
      view.setUint32(box.start, box.end - box.start);
      out.set(new TextEncoder().encode("free"), box.start + 4);
    }
    return out;
  }
  return bytes2;
}

// lib/ole2.ts
var SIGNATURE = [208, 207, 17, 224, 161, 177, 26, 225];
var SUMMARY = "SummaryInformation";
var DOC_SUMMARY = "DocumentSummaryInformation";
var FMTID_SUMMARY = "f29f85e0-4ff9-1068-ab91-08002b27b3d9";
var FMTID_DOC_SUMMARY = "d5cdd502-2e9c-101b-9397-08002b2cf9ae";
var VT_I4 = 3;
var VT_LPSTR = 30;
var VT_FILETIME = 64;
var OLE2_FIELDS = [
  { key: "title", label: "Titel", stream: "summary", id: 2, kind: "text" },
  { key: "subject", label: "Thema", stream: "summary", id: 3, kind: "text" },
  { key: "creator", label: "Autor", stream: "summary", id: 4, kind: "text" },
  { key: "keywords", label: "Stichw\xF6rter", stream: "summary", id: 5, kind: "text" },
  { key: "description", label: "Kommentare", stream: "summary", id: 6, kind: "text" },
  { key: "template", label: "Vorlage", stream: "summary", id: 7, kind: "text" },
  { key: "lastModifiedBy", label: "Zuletzt ge\xE4ndert von", stream: "summary", id: 8, kind: "text" },
  { key: "revision", label: "Revisionsnummer", stream: "summary", id: 9, kind: "text" },
  { key: "TotalTime", label: "Bearbeitungszeit (Min.)", stream: "summary", id: 10, kind: "number" },
  { key: "lastPrinted", label: "Zuletzt gedruckt", stream: "summary", id: 11, kind: "datetime" },
  { key: "created", label: "Erstellt am", stream: "summary", id: 12, kind: "datetime" },
  { key: "modified", label: "Ge\xE4ndert am", stream: "summary", id: 13, kind: "datetime" },
  { key: "Application", label: "Erstellt mit", stream: "summary", id: 18, kind: "text" },
  { key: "category", label: "Kategorie", stream: "docSummary", id: 2, kind: "text" },
  { key: "Manager", label: "Vorgesetzter", stream: "docSummary", id: 14, kind: "text" },
  { key: "Company", label: "Firma", stream: "docSummary", id: 15, kind: "text" }
];
var isOle2 = (bytes2) => SIGNATURE.every((byte, index) => bytes2[index] === byte);
function readCompound(bytes2) {
  if (!isOle2(bytes2) || bytes2.length < 512) return null;
  const view = new DataView(bytes2.buffer, bytes2.byteOffset, bytes2.byteLength);
  const sectorSize = 1 << view.getUint16(30, true);
  const miniSectorSize = 1 << view.getUint16(32, true);
  const directoryStart = view.getUint32(48, true);
  const miniCutoff = view.getUint32(56, true);
  const miniFatStart = view.getUint32(60, true);
  const difatStart = view.getUint32(68, true);
  const sectorOffset = (sector) => (sector + 1) * sectorSize;
  const sectorEnd = (sector) => sectorOffset(sector) + sectorSize;
  if (sectorSize < 128) return null;
  const fatSectors = [];
  for (let i = 0; i < 109; i++) {
    const sector = view.getUint32(76 + i * 4, true);
    if (sector === 4294967295) break;
    fatSectors.push(sector);
  }
  let difat = difatStart;
  let guard = 0;
  while (difat !== 4294967295 && difat !== 4294967294 && guard++ < 1024) {
    const base = sectorOffset(difat);
    if (base + sectorSize > bytes2.length) break;
    const perSector = sectorSize / 4 - 1;
    for (let i = 0; i < perSector; i++) {
      const sector = view.getUint32(base + i * 4, true);
      if (sector === 4294967295) break;
      fatSectors.push(sector);
    }
    difat = view.getUint32(base + sectorSize - 4, true);
  }
  const fat = [];
  for (const sector of fatSectors) {
    const base = sectorOffset(sector);
    if (base + sectorSize > bytes2.length) break;
    for (let i = 0; i < sectorSize / 4; i++) fat.push(view.getUint32(base + i * 4, true));
  }
  if (fat.length === 0) return null;
  const chain = (start, limit = 1 << 20) => {
    const out = [];
    let sector = start;
    while (sector !== 4294967294 && sector !== 4294967295 && out.length < limit) {
      if (sector < 0 || sector >= fat.length) break;
      out.push(sector);
      sector = fat[sector];
    }
    return out;
  };
  const miniFat = [];
  for (const sector of chain(miniFatStart)) {
    const base = sectorOffset(sector);
    if (base + sectorSize > bytes2.length) break;
    for (let i = 0; i < sectorSize / 4; i++) miniFat.push(view.getUint32(base + i * 4, true));
  }
  const directorySectors = chain(directoryStart);
  const entries = [];
  for (const sector of directorySectors) {
    const base = sectorOffset(sector);
    for (let offset = base; offset + 128 <= base + sectorSize && offset + 128 <= bytes2.length; offset += 128) {
      const nameLength = view.getUint16(offset + 64, true);
      if (nameLength < 2) continue;
      let name = "";
      for (let i = 0; i < nameLength - 2; i += 2) name += String.fromCharCode(view.getUint16(offset + i, true));
      entries.push({
        name,
        type: bytes2[offset + 66],
        start: view.getUint32(offset + 116, true),
        size: view.getUint32(offset + 120, true)
      });
    }
  }
  const root = entries.find((e) => e.type === 5);
  const miniStreamSectors = root ? chain(root.start) : [];
  const streams = /* @__PURE__ */ new Map();
  for (const item of entries) {
    if (item.type !== 2) continue;
    const ranges = [];
    if (item.size < miniCutoff) {
      let mini = item.start;
      let count = 0;
      while (mini !== 4294967294 && mini !== 4294967295 && count++ < 1 << 16) {
        const byteOffset = mini * miniSectorSize;
        const hostIndex = Math.floor(byteOffset / sectorSize);
        const hostSector = miniStreamSectors[hostIndex];
        if (hostSector === void 0) break;
        const start = sectorOffset(hostSector) + byteOffset % sectorSize;
        ranges.push({ start, end: start + miniSectorSize });
        if (mini >= miniFat.length) break;
        mini = miniFat[mini];
      }
    } else {
      for (const sector of chain(item.start)) ranges.push({ start: sectorOffset(sector), end: sectorEnd(sector) });
    }
    if (ranges.length > 0) streams.set(item.name, { name: item.name, ranges, size: item.size });
  }
  return { streams };
}
function readStream(bytes2, location) {
  const out = new Uint8Array(location.ranges.reduce((sum, r) => sum + (r.end - r.start), 0));
  let offset = 0;
  for (const range of location.ranges) {
    const slice = bytes2.subarray(range.start, Math.min(range.end, bytes2.length));
    out.set(slice, offset);
    offset += range.end - range.start;
  }
  return out.subarray(0, Math.max(location.size, 0) || out.length);
}
function writeStream(bytes2, location, data) {
  const capacity = location.ranges.reduce((sum, r) => sum + (r.end - r.start), 0);
  if (data.length > capacity) return false;
  let offset = 0;
  for (const range of location.ranges) {
    const length = range.end - range.start;
    for (let i = 0; i < length; i++) {
      const target = range.start + i;
      if (target >= bytes2.length) break;
      bytes2[target] = offset + i < data.length ? data[offset + i] : 0;
    }
    offset += length;
  }
  return true;
}
var FILETIME_EPOCH = -116444736e5;
function parsePropertySet(stream) {
  const values = /* @__PURE__ */ new Map();
  if (stream.length < 48) return values;
  const view = new DataView(stream.buffer, stream.byteOffset, stream.byteLength);
  if (view.getUint16(0, true) !== 65534) return values;
  const sectionOffset = view.getUint32(44, true);
  if (sectionOffset + 8 > stream.length) return values;
  const count = view.getUint32(sectionOffset + 4, true);
  for (let i = 0; i < count && i < 256; i++) {
    const entry2 = sectionOffset + 8 + i * 8;
    if (entry2 + 8 > stream.length) break;
    const id = view.getUint32(entry2, true);
    const offset = sectionOffset + view.getUint32(entry2 + 4, true);
    if (offset + 4 > stream.length) continue;
    const type = view.getUint32(offset, true);
    if (type === VT_LPSTR || type === 31) {
      const length = view.getUint32(offset + 4, true);
      if (offset + 8 + length > stream.length) continue;
      const raw = stream.subarray(offset + 8, offset + 8 + length);
      const text = type === 31 ? Array.from({ length: Math.floor(length / 2) }, (_, k) => String.fromCharCode(view.getUint16(offset + 8 + k * 2, true))).join("") : new TextDecoder("windows-1252").decode(raw);
      values.set(id, text.replace(/\0.*$/, ""));
    } else if (type === VT_I4) {
      values.set(id, view.getInt32(offset + 4, true));
    } else if (type === VT_FILETIME) {
      const low = view.getUint32(offset + 4, true);
      const high = view.getUint32(offset + 8, true);
      const ticks = high * 4294967296 + low;
      if (ticks > 0) values.set(id, new Date(ticks / 1e4 + FILETIME_EPOCH));
    }
  }
  return values;
}
function buildPropertySet(fmtid, values) {
  const encoder4 = new TextEncoder();
  const properties = [];
  const codePage = new Uint8Array(8);
  new DataView(codePage.buffer).setUint32(0, 2, true);
  new DataView(codePage.buffer).setUint16(4, 65001, true);
  properties.push({ id: 1, body: codePage });
  for (const [id, value] of Array.from(values.entries())) {
    if (id === 1) continue;
    if (typeof value === "string") {
      if (value === "") continue;
      const text = encoder4.encode(value + "\0");
      const padded = Math.ceil(text.length / 4) * 4;
      const body = new Uint8Array(8 + padded);
      const view2 = new DataView(body.buffer);
      view2.setUint32(0, VT_LPSTR, true);
      view2.setUint32(4, text.length, true);
      body.set(text, 8);
      properties.push({ id, body });
    } else if (typeof value === "number") {
      const body = new Uint8Array(8);
      const view2 = new DataView(body.buffer);
      view2.setUint32(0, VT_I4, true);
      view2.setInt32(4, value, true);
      properties.push({ id, body });
    } else if (value instanceof Date) {
      const body = new Uint8Array(12);
      const view2 = new DataView(body.buffer);
      view2.setUint32(0, VT_FILETIME, true);
      const ticks = (value.getTime() - FILETIME_EPOCH) * 1e4;
      view2.setUint32(4, ticks % 4294967296, true);
      view2.setUint32(8, Math.floor(ticks / 4294967296), true);
      properties.push({ id, body });
    }
  }
  const tableSize = 8 + properties.length * 8;
  const sectionSize = tableSize + properties.reduce((sum, p) => sum + p.body.length, 0);
  const out = new Uint8Array(48 + sectionSize);
  const view = new DataView(out.buffer);
  view.setUint16(0, 65534, true);
  view.setUint16(2, 0, true);
  view.setUint32(4, 131078, true);
  out.set(uuidToBytes("00000000-0000-0000-0000-000000000000"), 8);
  view.setUint32(24, 1, true);
  out.set(uuidToBytes(fmtid), 28);
  view.setUint32(44, 48, true);
  view.setUint32(48, sectionSize, true);
  view.setUint32(52, properties.length, true);
  let valueOffset = tableSize;
  properties.forEach((property, index) => {
    view.setUint32(56 + index * 8, property.id, true);
    view.setUint32(56 + index * 8 + 4, valueOffset, true);
    out.set(property.body, 48 + valueOffset);
    valueOffset += property.body.length;
  });
  return out;
}
function uuidToBytes(uuid) {
  const hex = uuid.replace(/-/g, "");
  const bytes2 = new Uint8Array(16);
  for (let i = 0; i < 16; i++) bytes2[i] = parseInt(hex.substr(i * 2, 2), 16);
  const swap = (a, b) => {
    const tmp = bytes2[a];
    bytes2[a] = bytes2[b];
    bytes2[b] = tmp;
  };
  swap(0, 3);
  swap(1, 2);
  swap(4, 5);
  swap(6, 7);
  return bytes2;
}
function readOle2(bytes2) {
  const compound = readCompound(bytes2);
  if (!compound) return null;
  const summary = compound.streams.get(SUMMARY);
  const docSummary = compound.streams.get(DOC_SUMMARY);
  const summaryValues = summary ? parsePropertySet(readStream(bytes2, summary)) : /* @__PURE__ */ new Map();
  const docValues = docSummary ? parsePropertySet(readStream(bytes2, docSummary)) : /* @__PURE__ */ new Map();
  const values = {};
  for (const field of OLE2_FIELDS) {
    const source = field.stream === "summary" ? summaryValues : docValues;
    const value = source.get(field.id);
    if (value === void 0) values[field.key] = "";
    else if (value instanceof Date) values[field.key] = value.toISOString().replace(/\.\d{3}Z$/, "Z");
    else values[field.key] = String(value);
  }
  const findings = [];
  const streamNames = Array.from(compound.streams.keys());
  findings.push({
    id: "legacyFormat",
    label: "Altes Bin\xE4rformat",
    detail: 'Diese Formate speichern beim \u201Eschnellen Speichern" gel\xF6schten Text weiter in der Datei. Das l\xE4sst sich nicht zuverl\xE4ssig entfernen \u2014 f\xFCr heikle Dokumente in Word \xF6ffnen und als .docx neu speichern.',
    severity: "hoch"
  });
  if (streamNames.some((n) => /Macros|VBA|_VBA_PROJECT/i.test(n))) {
    findings.push({
      id: "macros",
      label: "Makros (VBA-Projekt)",
      detail: "Das VBA-Projekt enth\xE4lt Quellcode samt Autorenspuren. Entfernen geht in dieser Datei nur \xFCber Office.",
      severity: "mittel"
    });
  }
  if (streamNames.some((n) => /ObjectPool|Ole/i.test(n))) {
    findings.push({
      id: "oleObjects",
      label: "Eingebettete Objekte",
      detail: "Eingebettete Fremddokumente bringen eigene Metadaten mit.",
      severity: "mittel"
    });
  }
  return { values, findings };
}
function writeOle2(bytes2, values) {
  const compound = readCompound(bytes2);
  if (!compound) return { bytes: bytes2, steps: [], error: "Datei ist kein g\xFCltiges OLE2-Dokument." };
  const out = bytes2.slice();
  const steps = [];
  for (const [streamName, fmtid, group] of [
    [SUMMARY, FMTID_SUMMARY, "summary"],
    [DOC_SUMMARY, FMTID_DOC_SUMMARY, "docSummary"]
  ]) {
    const location = compound.streams.get(streamName);
    if (!location) continue;
    const properties = /* @__PURE__ */ new Map();
    for (const field of OLE2_FIELDS.filter((f) => f.stream === group)) {
      const value = (values[field.key] ?? "").trim();
      if (value === "") continue;
      if (field.kind === "number") {
        if (/^-?\d+$/.test(value)) properties.set(field.id, Number(value));
      } else if (field.kind === "datetime") {
        const date = new Date(value);
        if (!Number.isNaN(date.getTime())) properties.set(field.id, date);
      } else {
        properties.set(field.id, value);
      }
    }
    const built = buildPropertySet(fmtid, properties);
    if (!writeStream(out, location, built)) {
      return {
        bytes: bytes2,
        steps,
        error: "Die neuen Werte brauchen mehr Platz, als das alte Format in dieser Datei vorsieht. K\xFCrzere Texte verwenden oder die Datei als .docx/.xlsx speichern."
      };
    }
    steps.push(`${streamName.slice(1)} neu geschrieben (${properties.size} Eigenschaft(en))`);
  }
  return { bytes: out, steps };
}

// lib/zip.ts
var CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 3988292384 ^ c >>> 1 : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

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

// tests/formats.test.ts
var odfEntries = () => makeEntries({
  mimetype: "application/vnd.oasis.opendocument.text",
  "META-INF/manifest.xml": '<?xml version="1.0"?><manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0"/>',
  "meta.xml": `<?xml version="1.0" encoding="UTF-8"?><office:document-meta xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:meta="urn:oasis:names:tc:opendocument:xmlns:meta:1.0" xmlns:dc="http://purl.org/dc/elements/1.1/"><office:meta><dc:title>Interner Entwurf</dc:title><meta:initial-creator>Max Mustermann</meta:initial-creator><dc:creator>Erika Musterfrau</dc:creator><meta:creation-date>2024-01-15T08:30:00</meta:creation-date><meta:generator>LibreOffice/7.4</meta:generator><meta:editing-cycles>17</meta:editing-cycles><meta:printed-by>Max Mustermann</meta:printed-by><meta:document-statistic meta:word-count="820"/><meta:user-defined meta:name="Aktenzeichen">AZ-2024-0815</meta:user-defined></office:meta></office:document-meta>`,
  "content.xml": `<?xml version="1.0" encoding="UTF-8"?><office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:dc="http://purl.org/dc/elements/1.1/"><office:body><office:text><text:p>Sichtbarer Text</text:p><office:annotation><dc:creator>Dr. Beispiel</dc:creator><text:p>Bitte pr\xFCfen</text:p></office:annotation><text:tracked-changes/></office:text></office:body></office:document-content>`,
  "Pictures/bild.jpg": jpegWithMetadata(),
  "Thumbnails/thumbnail.png": pngWithMetadata()
});
await test("ODF: Paket wird erkannt und Felder gelesen", () => {
  const entries = odfEntries();
  assert(isOdfPackage(entries), "ODF-Paket nicht erkannt");
  const values = readOdfFields(entries);
  equal(values.title, "Interner Entwurf", "Titel falsch");
  equal(values["initial-creator"], "Max Mustermann", "Autor falsch");
  equal(values.creator, "Erika Musterfrau", "Letzter Bearbeiter falsch");
  equal(values["editing-cycles"], "17", "Bearbeitungszyklen falsch");
});
await test("ODF: Funde werden gemeldet", () => {
  const found = scanOdf(odfEntries()).map((f) => f.id);
  for (const expected of ["imageMetadata", "thumbnail", "authors", "trackedChanges", "userFields"]) {
    assert(found.includes(expected), `"${expected}" fehlt, gefunden: ${found.join(", ")}`);
  }
});
await test("ODF: Schreiben und Bereinigen", () => {
  const entries = odfEntries();
  writeOdfFields(entries, { title: "Freigabe", "initial-creator": "Anon", creator: "", generator: "" });
  const meta = textOf(entries, "meta.xml") ?? "";
  includes(meta, "<dc:title>Freigabe</dc:title>", "Titel nicht geschrieben");
  includes(meta, "Anon", "Autor nicht geschrieben");
  excludes(meta, "Erika Musterfrau", "Geleertes Feld noch vorhanden");
  excludes(meta, "LibreOffice/7.4", "Erzeuger nicht entfernt");
  excludes(meta, "document-statistic", "Statistik nicht entfernt");
  const steps = cleanOdf(entries, { ...DEFAULT_ODF_CLEAN, anonymizeAuthors: true });
  const all = entries.map((e) => new TextDecoder("latin1").decode(e.data)).join("\n");
  excludes(all, "AZ-2024-0815", "Benutzerfeld nicht entfernt");
  excludes(all, "Dr. Beispiel", "Kommentarautor nicht ersetzt");
  excludes(all, "ACME Cameras", "Bildmetadaten nicht entfernt");
  includes(all, "Sichtbarer Text", "Inhalt zerst\xF6rt");
  assert(!entries.some((e) => e.name.startsWith("Thumbnails/")), "Vorschaubild nicht entfernt");
  assert(steps.length >= 3, `Zu wenige Schritte: ${steps.join(", ")}`);
});
var RTF_SAMPLE = "{\\rtf1\\ansi\\deff0{\\fonttbl{\\f0 Times;}}{\\info{\\title Interner Entwurf}{\\author Max Mustermann}{\\operator Erika Musterfrau}{\\company Beispiel GmbH}{\\doccomm Erster Entwurf}\\vern1\\edmins412\\nofrev17}{\\*\\generator Riched20 10.0.19041;}{\\*\\revtbl{Unknown;}{Max Mustermann;}{Erika Musterfrau;}}\\pard Sichtbarer Text\\par {\\*\\atnauthor Dr. Beispiel}{\\annotation Bitte pruefen}\\revised Nachverfolgt\\par}";
await test("RTF: Felder werden gelesen", () => {
  assert(isRtf(RTF_SAMPLE), "RTF nicht erkannt");
  const values = readRtfFields(RTF_SAMPLE);
  equal(values.title, "Interner Entwurf", "Titel falsch");
  equal(values.author, "Max Mustermann", "Autor falsch");
  equal(values.operator, "Erika Musterfrau", "Bearbeiter falsch");
  equal(values.company, "Beispiel GmbH", "Firma falsch");
  equal(values.editingTime, "412", "Bearbeitungszeit falsch");
  equal(values.revisions, "17", "Revisionen falsch");
});
await test("RTF: Funde werden gemeldet", () => {
  const found = scanRtf(RTF_SAMPLE).map((f) => f.id);
  for (const expected of ["authors", "generator", "annotations", "trackedChanges"]) {
    assert(found.includes(expected), `"${expected}" fehlt, gefunden: ${found.join(", ")}`);
  }
  includes(scanRtf(RTF_SAMPLE).find((f) => f.id === "authors")?.detail ?? "", "Max Mustermann", "Name fehlt im Bericht");
});
await test("RTF: Schreiben ersetzt den Info-Block vollst\xE4ndig", () => {
  const written = writeRtfFields(RTF_SAMPLE, { title: "Freigabe", author: "", company: "Andere GmbH" });
  excludes(written, "Max Mustermann}", "Autor nicht entfernt");
  excludes(written, "Interner Entwurf", "Alter Titel geblieben");
  includes(written, "{\\title Freigabe}", "Neuer Titel fehlt");
  includes(written, "{\\company Andere GmbH}", "Firma fehlt");
  includes(written, "Sichtbarer Text", "Inhalt zerst\xF6rt");
  const read = readRtfFields(written);
  equal(read.title, "Freigabe", "R\xFCcklesen fehlgeschlagen");
  equal(read.author, "", "Autor ist zur\xFCck");
});
await test("RTF: Bereinigung entfernt Erzeuger und Revisionstabelle", () => {
  const { text, steps } = cleanRtf(RTF_SAMPLE, { ...DEFAULT_RTF_CLEAN, anonymizeAuthors: true });
  excludes(text, "Riched20", "Erzeuger geblieben");
  excludes(text, "revtbl", "Revisionstabelle geblieben");
  excludes(text, "Dr. Beispiel", "Kommentarautor geblieben");
  includes(text, "Sichtbarer Text", "Inhalt zerst\xF6rt");
  assert(steps.length >= 2, `Zu wenige Schritte: ${steps.join(", ")}`);
});
await test("RTF: geschweifte Klammern in Werten werden maskiert", () => {
  const written = writeRtfFields(RTF_SAMPLE, { title: "Titel {mit} \\Klammern" });
  const read = readRtfFields(written);
  equal(read.title, "Titel {mit} \\Klammern", "Maskierung kaputt");
});
function mp3WithTags() {
  const frames = concatBytes([
    bytes("TPE1"),
    new Uint8Array([0, 0, 0, 16, 0, 0]),
    bytes("\0Max Mustermann\0"),
    bytes("COMM"),
    new Uint8Array([0, 0, 0, 20, 0, 0]),
    bytes("\0deuInternes Material")
  ]);
  const size = frames.length;
  const header = concatBytes([
    bytes("ID3"),
    new Uint8Array([3, 0, 0, size >> 21 & 127, size >> 14 & 127, size >> 7 & 127, size & 127])
  ]);
  const audio = new Uint8Array([255, 251, 144, 0, 1, 2, 3, 4, 5, 6, 7, 8]);
  const id3v1 = concatBytes([bytes("TAG"), bytes("Titel".padEnd(30, "\0")), bytes("Max Mustermann".padEnd(95, "\0"))]);
  return concatBytes([header, frames, audio, id3v1]);
}
function mp4WithTags() {
  const box = (type, payload) => {
    const out = new Uint8Array(8 + payload.length);
    new DataView(out.buffer).setUint32(0, out.length);
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i) & 255;
    out.set(payload, 8);
    return out;
  };
  const udta = box("udta", concatBytes([box("\xA9nam", bytes("Internes Video")), box("\xA9xyz", bytes("+52.5200+13.4050/"))]));
  const moov = box("moov", concatBytes([box("mvhd", new Uint8Array(24)), udta]));
  return concatBytes([box("ftyp", bytes("isom")), moov, box("mdat", bytes("AUDIOVIDEODATEN"))]);
}
await test("MP3: Tags werden erkannt und entfernt, Audio bleibt", () => {
  const mp3 = mp3WithTags();
  equal(detectMedia(mp3), "mp3", "Format nicht erkannt");
  const found = inspectMedia(mp3).map((f) => f.label);
  assert(found.some((f) => f.startsWith("ID3v2")), `ID3v2 nicht erkannt: ${found.join(", ")}`);
  assert(found.includes("ID3v1-Tag"), "ID3v1 nicht erkannt");
  const cleaned = stripMediaMetadata(mp3);
  const text = new TextDecoder("latin1").decode(cleaned);
  excludes(text, "Max Mustermann", "Name geblieben");
  excludes(text, "Internes Material", "Kommentar geblieben");
  equal(cleaned[0], 255, "Audio beginnt nicht mit einem Frame-Header");
  equal(inspectMedia(cleaned).length, 0, "Nach der Bereinigung wird noch etwas gefunden");
});
await test("MP4: Tags werden \xFCberschrieben, Dateigr\xF6\xDFe bleibt gleich", () => {
  const mp4 = mp4WithTags();
  equal(detectMedia(mp4), "mp4", "Format nicht erkannt");
  const found = inspectMedia(mp4).map((f) => f.label);
  assert(found.includes("Benutzerdaten (udta)"), `udta nicht erkannt: ${found.join(", ")}`);
  assert(found.includes("GPS-Position"), "GPS nicht erkannt");
  const cleaned = stripMediaMetadata(mp4);
  const text = new TextDecoder("latin1").decode(cleaned);
  excludes(text, "Internes Video", "Titel geblieben");
  excludes(text, "+52.5200", "GPS geblieben");
  includes(text, "AUDIOVIDEODATEN", "Mediendaten verloren");
  equal(cleaned.length, mp4.length, "Dateigr\xF6\xDFe ver\xE4ndert");
  includes(text, "free", "Platzhalter-Box fehlt");
});
function ole2Fixture() {
  const SECTOR = 512;
  const sectors = 18;
  const out = new Uint8Array(SECTOR * (sectors + 1));
  const view = new DataView(out.buffer);
  out.set(new Uint8Array([208, 207, 17, 224, 161, 177, 26, 225]), 0);
  view.setUint16(30, 9, true);
  view.setUint16(32, 6, true);
  view.setUint32(44, 1, true);
  view.setUint32(48, 1, true);
  view.setUint32(56, 4096, true);
  view.setUint32(60, 4294967294, true);
  view.setUint32(68, 4294967294, true);
  view.setUint32(76, 0, true);
  for (let i = 1; i < 109; i++) view.setUint32(76 + i * 4, 4294967295, true);
  const fat = SECTOR;
  const setFat = (index, value) => view.setUint32(fat + index * 4, value, true);
  for (let i = 0; i < SECTOR / 4; i++) setFat(i, 4294967295);
  setFat(0, 4294967293);
  setFat(1, 4294967294);
  for (let i = 2; i < 9; i++) setFat(i, i + 1);
  setFat(9, 4294967294);
  for (let i = 10; i < 17; i++) setFat(i, i + 1);
  setFat(17, 4294967294);
  const directory = SECTOR * 2;
  const writeEntry = (index, name, type, start, size) => {
    const at = directory + index * 128;
    for (let i = 0; i < name.length; i++) view.setUint16(at + i * 2, name.charCodeAt(i), true);
    view.setUint16(at + 64, name.length * 2 + 2, true);
    out[at + 66] = type;
    view.setUint32(at + 116, start, true);
    view.setUint32(at + 120, size, true);
  };
  writeEntry(0, "Root Entry", 5, 4294967294, 0);
  writeEntry(1, "SummaryInformation", 2, 2, 4096);
  writeEntry(2, "DocumentSummaryInformation", 2, 10, 4096);
  for (const [start, fmtid] of [
    [2, "e0859ff2f94f6810ab9108002b27b3d9"],
    [10, "02d5cdd59c2e1b1093970800 2b2cf9ae".replace(/ /g, "")]
  ]) {
    const at = SECTOR * (start + 1);
    view.setUint16(at, 65534, true);
    view.setUint32(at + 4, 131078, true);
    view.setUint32(at + 24, 1, true);
    for (let i = 0; i < 16; i++) out[at + 28 + i] = parseInt(fmtid.substr(i * 2, 2), 16);
    view.setUint32(at + 44, 48, true);
    view.setUint32(at + 48, 8, true);
    view.setUint32(at + 52, 0, true);
  }
  return out;
}
await test("OLE2: Datei wird erkannt und gelesen", () => {
  const file = ole2Fixture();
  assert(isOle2(file), "OLE2 nicht erkannt");
  const document = readOle2(file);
  assert(document, "Datei nicht lesbar");
  equal(document.values.title, "", "Leeres Feld liefert nicht leer");
  assert(
    document.findings.some((f) => f.id === "legacyFormat"),
    "Hinweis auf das alte Format fehlt"
  );
});
await test("OLE2: Schreiben und R\xFCcklesen der Eigenschaften", () => {
  const file = ole2Fixture();
  const written = writeOle2(file, {
    title: "Freigegebener Bericht",
    creator: "Anon",
    Company: "Beispiel GmbH",
    TotalTime: "42",
    created: "2020-03-05T09:15:00Z"
  });
  equal(written.error, void 0, `Fehler: ${written.error}`);
  equal(written.bytes.length, file.length, "Dateigr\xF6\xDFe ver\xE4ndert \u2014 die Struktur muss erhalten bleiben");
  const document = readOle2(written.bytes);
  assert(document, "Ergebnis nicht mehr lesbar");
  equal(document.values.title, "Freigegebener Bericht", "Titel falsch zur\xFCckgelesen");
  equal(document.values.creator, "Anon", "Autor falsch zur\xFCckgelesen");
  equal(document.values.Company, "Beispiel GmbH", "Firma falsch zur\xFCckgelesen");
  equal(document.values.TotalTime, "42", "Zahl falsch zur\xFCckgelesen");
  includes(document.values.created, "2020-03-05", "Datum falsch zur\xFCckgelesen");
});
await test("OLE2: zu lange Werte werden abgelehnt statt die Datei zu zerst\xF6ren", () => {
  const file = ole2Fixture();
  const result = writeOle2(file, { title: "x".repeat(5e3) });
  assert(result.error, "\xDCberlanger Wert wurde nicht abgelehnt");
  equal(result.bytes, file, "Datei wurde trotz Ablehnung ver\xE4ndert");
});
await test("OLE2: Leeren entfernt alle Eigenschaften", () => {
  const file = ole2Fixture();
  const filled = writeOle2(file, { title: "Geheim", creator: "Max Mustermann" }).bytes;
  includes(new TextDecoder("latin1").decode(filled), "Max Mustermann", "Testaufbau falsch");
  const cleared = writeOle2(filled, {});
  equal(cleared.error, void 0, `Fehler: ${cleared.error}`);
  excludes(new TextDecoder("latin1").decode(cleared.bytes), "Max Mustermann", "Autor nicht entfernt");
  excludes(new TextDecoder("latin1").decode(cleared.bytes), "Geheim", "Titel nicht entfernt");
});
