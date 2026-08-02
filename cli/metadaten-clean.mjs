#!/usr/bin/env node

// cli/main.ts
import { readdir, readFile, stat, writeFile, mkdir } from "node:fs/promises";
import { dirname, extname, join, resolve as resolve2 } from "node:path";
import { DOMParser as DOMParser2, XMLSerializer as XMLSerializer2 } from "@xmldom/xmldom";

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
function crc32(bytes) {
  let c = 4294967295;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 255] ^ c >>> 8;
  return (c ^ 4294967295) >>> 0;
}
async function inflateRaw(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
async function deflateRaw(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("deflate-raw"));
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
  const bytes = new Uint8Array(buffer);
  let eocd = -1;
  const scanStart = Math.max(0, bytes.length - 65535 - 22);
  for (let i = bytes.length - 22; i >= scanStart; i--) {
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
    const name = new TextDecoder().decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
    if (view.getUint32(localOffset, true) !== SIG_LOCAL) throw new Error(`Besch\xE4digter Local Header: ${name}`);
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const raw = bytes.subarray(dataStart, dataStart + compressedSize);
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
  const encoder2 = new TextEncoder();
  const localChunks = [];
  const centralChunks = [];
  let offset = 0;
  for (const entry of entries) {
    const nameBytes = encoder2.encode(entry.name);
    const crc = crc32(entry.data);
    const deflated = entry.data.length > 0 ? await deflateRaw(entry.data) : new Uint8Array(0);
    const useDeflate = entry.method !== 0 && deflated.length < entry.data.length;
    const payload = useDeflate ? deflated : entry.data;
    const method = useDeflate ? 8 : 0;
    const { dosTime, dosDate } = timestamp ? toDosDateTime(timestamp) : { dosTime: entry.dosTime, dosDate: entry.dosDate };
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
    localView.setUint32(22, entry.data.length, true);
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
    centralView.setUint32(24, entry.data.length, true);
    centralView.setUint16(28, nameBytes.length, true);
    centralView.setUint32(38, entry.externalAttr, true);
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
var ROOT_RELS = "_rels/.rels";
var decoder = new TextDecoder();
var encoder = new TextEncoder();
function findEntry(entries, name) {
  return entries.find((e) => e.name === name);
}
function textOf(entries, name) {
  const entry = findEntry(entries, name);
  return entry ? decoder.decode(entry.data) : void 0;
}
var decodeText = (data) => decoder.decode(data);
var encodeText = (text) => encoder.encode(text);
function setText(entries, name, xml) {
  const entry = findEntry(entries, name);
  if (entry) {
    entry.data = encoder.encode(xml);
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
function firstByTag(doc, ns, tag) {
  const list = doc.getElementsByTagNameNS(ns, tag);
  return list.length > 0 ? list[0] : null;
}
function editParts(entries, matches, edit) {
  const touched = [];
  for (const entry of entries) {
    if (!matches(entry.name)) continue;
    const xml = decoder.decode(entry.data);
    const next = edit(xml, entry.name);
    if (next !== xml) {
      entry.data = encoder.encode(next);
      touched.push(entry.name);
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
  for (const entry of entries.filter((e) => e.name.endsWith(".rels"))) {
    const doc = parseXml(decoder.decode(entry.data), entry.name);
    let changed = false;
    for (const rel of Array.from(doc.getElementsByTagNameNS(NS.rel, "Relationship"))) {
      if (rel.getAttribute("TargetMode") === "External") continue;
      if (withRels.has(resolveTarget(entry.name, rel.getAttribute("Target") ?? ""))) {
        rel.parentNode?.removeChild(rel);
        changed = true;
      }
    }
    if (changed) entry.data = encoder.encode(serializeXml(doc));
  }
  return removed;
}
function removePartsAndReferences(entries, predicate) {
  const doomed = new Set(entries.filter((e) => predicate(e.name)).map((e) => e.name));
  if (doomed.size === 0) return [];
  const danglingByOwner = /* @__PURE__ */ new Map();
  for (const entry of entries.filter((e) => e.name.endsWith(".rels"))) {
    const ids = [];
    for (const rel of readRelationships(entries, entry.name)) {
      if (rel.external) continue;
      if (doomed.has(resolveTarget(entry.name, rel.target))) ids.push(rel.id);
    }
    if (ids.length === 0) continue;
    const owner = entry.name.replace(/_rels\/([^/]+)\.rels$/, "$1");
    danglingByOwner.set(owner, ids);
  }
  const removed = removeParts(entries, predicate);
  for (const [owner, ids] of Array.from(danglingByOwner.entries())) {
    const entry = findEntry(entries, owner);
    if (!entry) continue;
    let xml = decoder.decode(entry.data);
    for (const id of ids) {
      xml = xml.replace(new RegExp(`<[^<>]*r:(?:id|embed)="${id}"[^<>]*/>`, "g"), "");
      xml = xml.replace(new RegExp(`\\sr:(?:id|embed)="${id}"`, "g"), "");
    }
    entry.data = encoder.encode(xml);
  }
  return removed;
}
function readRelationships(entries, relsPath) {
  const xml = textOf(entries, relsPath);
  if (!xml) return [];
  const doc = parseXml(xml, relsPath);
  return Array.from(doc.getElementsByTagNameNS(NS.rel, "Relationship")).map((rel) => ({
    id: rel.getAttribute("Id") ?? "",
    type: rel.getAttribute("Type") ?? "",
    target: rel.getAttribute("Target") ?? "",
    external: rel.getAttribute("TargetMode") === "External"
  }));
}
function setContentTypeOverride(entries, partName, contentType) {
  const xml = textOf(entries, CONTENT_TYPES);
  if (!xml) return;
  const doc = parseXml(xml, CONTENT_TYPES);
  for (const override2 of Array.from(doc.getElementsByTagNameNS(NS.ct, "Override"))) {
    if (override2.getAttribute("PartName") === `/${partName}`) {
      override2.setAttribute("ContentType", contentType);
      setText(entries, CONTENT_TYPES, serializeXml(doc));
      return;
    }
  }
  const override = doc.createElementNS(NS.ct, "Override");
  override.setAttribute("PartName", `/${partName}`);
  override.setAttribute("ContentType", contentType);
  doc.documentElement.appendChild(override);
  setText(entries, CONTENT_TYPES, serializeXml(doc));
}

// lib/officeMetadata.ts
var CORE_PART = "docProps/core.xml";
var APP_PART = "docProps/app.xml";
var CUSTOM_PART = "docProps/custom.xml";
var FIELDS = [
  { key: "title", label: "Titel", kind: "text", part: "core", ns: NS.dc, prefix: "dc", tag: "title" },
  { key: "subject", label: "Thema", kind: "text", part: "core", ns: NS.dc, prefix: "dc", tag: "subject" },
  { key: "creator", label: "Autor", hint: "dc:creator \u2014 der urspr\xFCngliche Verfasser", kind: "text", part: "core", ns: NS.dc, prefix: "dc", tag: "creator" },
  { key: "lastModifiedBy", label: "Zuletzt ge\xE4ndert von", kind: "text", part: "core", ns: NS.cp, prefix: "cp", tag: "lastModifiedBy" },
  { key: "keywords", label: "Stichw\xF6rter", kind: "text", part: "core", ns: NS.cp, prefix: "cp", tag: "keywords" },
  { key: "description", label: "Kommentare", kind: "longtext", part: "core", ns: NS.dc, prefix: "dc", tag: "description" },
  { key: "category", label: "Kategorie", kind: "text", part: "core", ns: NS.cp, prefix: "cp", tag: "category" },
  { key: "contentStatus", label: "Status", kind: "text", part: "core", ns: NS.cp, prefix: "cp", tag: "contentStatus" },
  { key: "revision", label: "Revisionsnummer", hint: "Wie oft das Dokument gespeichert wurde", kind: "number", part: "core", ns: NS.cp, prefix: "cp", tag: "revision" },
  { key: "version", label: "Version", kind: "text", part: "core", ns: NS.cp, prefix: "cp", tag: "version" },
  { key: "language", label: "Sprache", kind: "text", part: "core", ns: NS.dc, prefix: "dc", tag: "language" },
  { key: "created", label: "Erstellt am", kind: "datetime", part: "core", ns: NS.dcterms, prefix: "dcterms", tag: "created", w3cdtf: true },
  { key: "modified", label: "Ge\xE4ndert am", kind: "datetime", part: "core", ns: NS.dcterms, prefix: "dcterms", tag: "modified", w3cdtf: true },
  { key: "lastPrinted", label: "Zuletzt gedruckt", kind: "datetime", part: "core", ns: NS.cp, prefix: "cp", tag: "lastPrinted" },
  { key: "Company", label: "Firma", kind: "text", part: "app", ns: NS.ep, prefix: "", tag: "Company" },
  { key: "Manager", label: "Vorgesetzter", kind: "text", part: "app", ns: NS.ep, prefix: "", tag: "Manager" },
  { key: "Application", label: "Erstellt mit", hint: 'z. B. "Microsoft Office Word"', kind: "text", part: "app", ns: NS.ep, prefix: "", tag: "Application" },
  { key: "AppVersion", label: "Programmversion", hint: "Format: 16.0000", kind: "text", part: "app", ns: NS.ep, prefix: "", tag: "AppVersion" },
  { key: "Template", label: "Vorlage", kind: "text", part: "app", ns: NS.ep, prefix: "", tag: "Template" },
  { key: "TotalTime", label: "Bearbeitungszeit (Min.)", kind: "number", part: "app", ns: NS.ep, prefix: "", tag: "TotalTime" },
  { key: "HyperlinkBase", label: "Hyperlink-Basis", hint: "Enth\xE4lt oft lokale Pfade", kind: "text", part: "app", ns: NS.ep, prefix: "", tag: "HyperlinkBase" }
];
var DEFAULT_CLEANUP = {
  stripRsids: true,
  stripCustomProps: false,
  stripThumbnail: true,
  stripComments: false,
  normalizeZipTimestamps: true
};
var CORE_TEMPLATE = `<cp:coreProperties xmlns:cp="${NS.cp}" xmlns:dc="${NS.dc}" xmlns:dcterms="${NS.dcterms}" xmlns:dcmitype="${NS.dcmitype}" xmlns:xsi="${NS.xsi}"/>`;
var APP_TEMPLATE = `<Properties xmlns="${NS.ep}" xmlns:vt="${NS.vt}"/>`;
function readOfficeFields(entries) {
  const values = {};
  const coreXml = textOf(entries, CORE_PART);
  const appXml = textOf(entries, APP_PART);
  const coreDoc = coreXml ? parseXml(coreXml, CORE_PART) : null;
  const appDoc = appXml ? parseXml(appXml, APP_PART) : null;
  for (const field of FIELDS) {
    const doc = field.part === "core" ? coreDoc : appDoc;
    const el = doc ? firstByTag(doc, field.ns, field.tag) : null;
    values[field.key] = el?.textContent ?? "";
  }
  return values;
}
function readCustomProps(entries) {
  const xml = textOf(entries, CUSTOM_PART);
  if (!xml) return [];
  const doc = parseXml(xml, CUSTOM_PART);
  const props = [];
  const nodes = doc.getElementsByTagNameNS(NS.custom, "property");
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    const valueEl = Array.from(node.children).find((c) => c.namespaceURI === NS.vt);
    props.push({
      name: node.getAttribute("name") ?? `Eigenschaft ${i + 1}`,
      value: valueEl?.textContent ?? "",
      type: valueEl?.localName ?? "lpwstr"
    });
  }
  return props;
}
function scanTraces(entries) {
  const traces = [];
  const names = entries.map((e) => e.name);
  const settings = textOf(entries, "word/settings.xml") ?? "";
  const documentXml = textOf(entries, "word/document.xml") ?? "";
  const rsidCount = (settings.match(/<w:rsid\b/g) ?? []).length;
  if (rsidCount > 0 || /\sw:rsid[A-Za-z]*="/.test(documentXml)) {
    traces.push({
      id: "rsids",
      label: `${rsidCount} RSIDs (Revision Save IDs)`,
      detail: "Word vergibt pro Bearbeitungssitzung eine ID. Damit lassen sich Dokumente derselben Herkunft einander zuordnen und Bearbeitungsrunden z\xE4hlen.",
      removable: true
    });
  }
  if (/<w:(ins|del|moveFrom|moveTo)\b/.test(documentXml)) {
    traces.push({
      id: "trackedChanges",
      label: "Nachverfolgte \xC4nderungen im Text",
      detail: 'Enth\xE4lt Autornamen und Zeitstempel direkt im Inhalt. Muss in Word \xFCber \u201E\xDCberpr\xFCfen \u2192 Alle \xC4nderungen annehmen" bereinigt werden \u2014 das ist Inhalt, keine Metadaten.',
      removable: false
    });
  }
  const commentParts = names.filter((n) => /^word\/comments.*\.xml$/.test(n) || n === "word/people.xml");
  if (commentParts.length > 0) {
    traces.push({
      id: "comments",
      label: "Kommentare / Personenliste",
      detail: `Enthaltene Teile: ${commentParts.join(", ")}. Speichern Autornamen und Initialen.`,
      removable: true
    });
  }
  if (findEntry(entries, CUSTOM_PART)) {
    traces.push({
      id: "customProps",
      label: "Benutzerdefinierte Eigenschaften",
      detail: "Werden oft von DMS-, Kanzlei- oder Vorlagensystemen gesetzt und enthalten Aktenzeichen oder Benutzer-IDs.",
      removable: true
    });
  }
  if (names.some((n) => n.startsWith("docProps/thumbnail"))) {
    traces.push({
      id: "thumbnail",
      label: "Vorschaubild",
      detail: "Zeigt die erste Seite im urspr\xFCnglichen Zustand \u2014 \xFCberlebt sp\xE4tere Text\xE4nderungen.",
      removable: true
    });
  }
  if (names.some((n) => n.startsWith("_xmlsignatures/"))) {
    traces.push({
      id: "signature",
      label: "Digitale Signatur",
      detail: "Jede \xC4nderung an der Datei macht die Signatur ung\xFCltig \u2014 das ist unmittelbar sichtbar.",
      removable: false
    });
  }
  const dosDates = entries.map((e) => e.dosDate);
  if (new Set(dosDates).size > 1) {
    traces.push({
      id: "zipTimestamps",
      label: "Unterschiedliche ZIP-Zeitstempel",
      detail: "Jeder Teil im Paket tr\xE4gt ein eigenes Datum. Passen die nicht zu den Dokumenteigenschaften, ist das ein deutliches Indiz f\xFCr nachtr\xE4gliche Bearbeitung.",
      removable: true
    });
  }
  return traces;
}
function ensureCoreElement(doc, field) {
  const existing = firstByTag(doc, field.ns, field.tag);
  if (existing) return existing;
  const qualified = field.prefix ? `${field.prefix}:${field.tag}` : field.tag;
  const el = doc.createElementNS(field.ns, qualified);
  if (field.w3cdtf) el.setAttributeNS(NS.xsi, "xsi:type", "dcterms:W3CDTF");
  doc.documentElement.appendChild(el);
  return el;
}
function applyFields(entries, values, part) {
  const partName = part === "core" ? CORE_PART : APP_PART;
  const fields = FIELDS.filter((f) => f.part === part);
  const wanted = fields.filter((f) => (values[f.key] ?? "").trim() !== "");
  const existing = textOf(entries, partName);
  if (!existing && wanted.length === 0) return;
  const doc = parseXml(existing ?? (part === "core" ? CORE_TEMPLATE : APP_TEMPLATE), partName);
  for (const field of fields) {
    const value = (values[field.key] ?? "").trim();
    const el = firstByTag(doc, field.ns, field.tag);
    if (value === "") {
      el?.parentNode?.removeChild(el);
      continue;
    }
    ensureCoreElement(doc, field).textContent = value;
  }
  setText(entries, partName, serializeXml(doc));
  ensureContentType(entries, partName);
  ensureRootRelationship(entries, partName);
}
function ensureContentType(entries, partName) {
  const types = {
    [CORE_PART]: "application/vnd.openxmlformats-package.core-properties+xml",
    [APP_PART]: "application/vnd.openxmlformats-officedocument.extended-properties+xml"
  };
  const contentType = types[partName];
  if (contentType) setContentTypeOverride(entries, partName, contentType);
}
function ensureRootRelationship(entries, partName) {
  const relTypes = {
    [CORE_PART]: "http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties",
    [APP_PART]: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties"
  };
  const type = relTypes[partName];
  if (!type) return;
  const xml = textOf(entries, ROOT_RELS);
  if (!xml) return;
  const doc = parseXml(xml, ROOT_RELS);
  const rels = doc.getElementsByTagNameNS(NS.rel, "Relationship");
  const used = /* @__PURE__ */ new Set();
  for (let i = 0; i < rels.length; i++) {
    const rel2 = rels[i];
    if (rel2.getAttribute("Type") === type) return;
    used.add(rel2.getAttribute("Id") ?? "");
  }
  let n = 1;
  while (used.has(`rId${n}`)) n++;
  const rel = doc.createElementNS(NS.rel, "Relationship");
  rel.setAttribute("Id", `rId${n}`);
  rel.setAttribute("Type", type);
  rel.setAttribute("Target", partName);
  doc.documentElement.appendChild(rel);
  setText(entries, ROOT_RELS, serializeXml(doc));
}
function stripRsidsFromPackage(entries) {
  const touched = [];
  for (const entry of entries) {
    if (!/^word\/.*\.xml$/.test(entry.name)) continue;
    const xml = decodeText(entry.data);
    const cleaned = xml.replace(/<w:rsids>[\s\S]*?<\/w:rsids>/g, "").replace(/<w:rsid\b[^>]*\/>/g, "").replace(/\s+w:rsid[A-Za-z]*="[^"]*"/g, "").replace(/<w:proofState\b[^>]*\/>/g, "");
    if (cleaned !== xml) {
      entry.data = encodeText(cleaned);
      touched.push(entry.name);
    }
  }
  return touched;
}
function stripCommentsFromPackage(entries) {
  const removed = removeParts(entries, (name) => /^word\/comments.*\.xml$/.test(name) || name === "word/people.xml");
  const documentEntry = findEntry(entries, "word/document.xml");
  if (!documentEntry) return removed;
  const xml = decodeText(documentEntry.data);
  const cleaned = xml.replace(/<w:commentRange(?:Start|End)\b[^>]*\/>/g, "").replace(/<w:commentReference\b[^>]*\/>/g, "").replace(/<w:r>(?:\s*<w:rPr>[\s\S]*?<\/w:rPr>)?\s*<\/w:r>/g, "");
  if (cleaned !== xml) documentEntry.data = encodeText(cleaned);
  return removed;
}
function applyCustomProps(entries, edited) {
  const existing = textOf(entries, CUSTOM_PART);
  if (!existing && edited.length === 0) return;
  const doc = parseXml(
    existing ?? `<Properties xmlns="${NS.custom}" xmlns:vt="${NS.vt}"/>`,
    CUSTOM_PART
  );
  const keptNames = new Set(edited.map((p) => p.name));
  const byName = new Map(edited.map((p) => [p.name, p]));
  for (const node of Array.from(doc.getElementsByTagNameNS(NS.custom, "property"))) {
    const name = node.getAttribute("name") ?? "";
    if (!keptNames.has(name)) {
      node.parentNode?.removeChild(node);
      continue;
    }
    const valueEl = Array.from(node.children).find((c) => c.namespaceURI === NS.vt);
    if (valueEl) valueEl.textContent = byName.get(name)?.value ?? "";
    byName.delete(name);
  }
  for (const prop of Array.from(byName.values())) {
    const node = doc.createElementNS(NS.custom, "property");
    node.setAttribute("fmtid", "{D5CDD505-2E9C-101B-9397-08002B2CF9AE}");
    node.setAttribute("name", prop.name);
    const value = doc.createElementNS(NS.vt, `vt:${prop.type || "lpwstr"}`);
    value.textContent = prop.value;
    node.appendChild(value);
    doc.documentElement.appendChild(node);
  }
  if (doc.getElementsByTagNameNS(NS.custom, "property").length === 0) {
    if (existing) removeParts(entries, (name) => name === CUSTOM_PART);
    return;
  }
  Array.from(doc.getElementsByTagNameNS(NS.custom, "property")).forEach(
    (node, index) => node.setAttribute("pid", String(index + 2))
  );
  setText(entries, CUSTOM_PART, serializeXml(doc));
  if (!existing) {
    setContentTypeOverride(entries, CUSTOM_PART, "application/vnd.openxmlformats-officedocument.custom-properties+xml");
    addRootRelationship(
      entries,
      "http://schemas.openxmlformats.org/officeDocument/2006/relationships/custom-properties",
      CUSTOM_PART
    );
  }
}
function addRootRelationship(entries, type, target) {
  const xml = textOf(entries, ROOT_RELS);
  if (!xml) return;
  const doc = parseXml(xml, ROOT_RELS);
  const used = /* @__PURE__ */ new Set();
  for (const rel2 of Array.from(doc.getElementsByTagNameNS(NS.rel, "Relationship"))) {
    if (rel2.getAttribute("Type") === type) return;
    used.add(rel2.getAttribute("Id") ?? "");
  }
  let n = 1;
  while (used.has(`rId${n}`)) n++;
  const rel = doc.createElementNS(NS.rel, "Relationship");
  rel.setAttribute("Id", `rId${n}`);
  rel.setAttribute("Type", type);
  rel.setAttribute("Target", target);
  doc.documentElement.appendChild(rel);
  setText(entries, ROOT_RELS, serializeXml(doc));
}

// lib/imageMeta.ts
var dec = new TextDecoder();
function ascii(bytes, start, length) {
  return dec.decode(bytes.subarray(start, start + length));
}
function detectFormat(bytes) {
  if (bytes.length < 12) return "unknown";
  if (bytes[0] === 255 && bytes[1] === 216) return "jpeg";
  if (bytes[0] === 137 && ascii(bytes, 1, 3) === "PNG") return "png";
  if (ascii(bytes, 0, 3) === "GIF") return "gif";
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") return "webp";
  if (bytes[0] === 73 && bytes[1] === 73 || bytes[0] === 77 && bytes[1] === 77) return "tiff";
  if (bytes[0] === 66 && bytes[1] === 77) return "bmp";
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
function readTiff(bytes, base) {
  const findings = [];
  if (base + 8 > bytes.length) return findings;
  const little = bytes[base] === 73 && bytes[base + 1] === 73;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (o) => view.getUint16(o, little);
  const u32 = (o) => view.getUint32(o, little);
  if (u16(base + 2) !== 42) return findings;
  const readIfd = (offset, tags, depth) => {
    if (offset <= 0 || offset + 2 > bytes.length || depth > 3) return;
    const count = u16(offset);
    if (count > 512) return;
    for (let i = 0; i < count; i++) {
      const entry = offset + 2 + i * 12;
      if (entry + 12 > bytes.length) return;
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
      if (type === 2 && size > 0 && valueOffset + size <= bytes.length) {
        value = ascii(bytes, valueOffset, size).replace(/\0.*$/, "").trim() || void 0;
      }
      if (name && !findings.some((f) => f.label === name)) findings.push({ label: name, value });
    }
  };
  readIfd(base + u32(base + 4), EXIF_TAGS, 0);
  return findings;
}
function inspectImage(bytes) {
  const format = detectFormat(bytes);
  const findings = [];
  if (format === "jpeg") {
    let offset = 2;
    while (offset + 4 <= bytes.length) {
      if (bytes[offset] !== 255) break;
      const marker = bytes[offset + 1];
      if (marker === 216 || marker === 1 || marker >= 208 && marker <= 215) {
        offset += 2;
        continue;
      }
      if (marker === 218 || marker === 217) break;
      const length = bytes[offset + 2] << 8 | bytes[offset + 3];
      const dataStart = offset + 4;
      if (marker === 225) {
        if (ascii(bytes, dataStart, 6) === "Exif\0\0") {
          findings.push(...readTiff(bytes, dataStart + 6));
        } else if (ascii(bytes, dataStart, 28).startsWith("http://ns.adobe.com/xap")) {
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
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    while (offset + 8 <= bytes.length) {
      const length = view.getUint32(offset);
      const type = ascii(bytes, offset + 4, 4);
      if (type === "eXIf") findings.push(...readTiff(bytes, offset + 8));
      else if (type === "tEXt" || type === "zTXt") findings.push({ label: "PNG-Textfeld" });
      else if (type === "iTXt") findings.push({ label: "XMP-Block (Bearbeitungsverlauf)" });
      else if (type === "tIME") findings.push({ label: "\xC4nderungszeitstempel im Bild" });
      if (type === "IEND") break;
      offset += 12 + length;
    }
  } else if (format === "tiff") {
    findings.push(...readTiff(bytes, 0));
  } else if (format === "webp" || format === "gif") {
    if (stripImageMetadata(bytes).length !== bytes.length) {
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
function stripImageMetadata(bytes) {
  switch (detectFormat(bytes)) {
    case "jpeg":
      return stripJpeg(bytes);
    case "png":
      return stripPng(bytes);
    case "webp":
      return stripWebp(bytes);
    case "gif":
      return stripGif(bytes);
    default:
      return bytes;
  }
}
function stripJpeg(bytes) {
  const out = [bytes.subarray(0, 2)];
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 255) break;
    const marker = bytes[offset + 1];
    if (marker === 1 || marker >= 208 && marker <= 215) {
      out.push(bytes.subarray(offset, offset + 2));
      offset += 2;
      continue;
    }
    if (marker === 218) {
      out.push(bytes.subarray(offset));
      return concat(out);
    }
    const length = bytes[offset + 2] << 8 | bytes[offset + 3];
    const segment = bytes.subarray(offset, offset + 2 + length);
    const dataStart = offset + 4;
    const isExifOrXmp = marker === 225;
    const isIptc = marker === 237;
    const isComment = marker === 254;
    const isIcc = marker === 226 && ascii(bytes, dataStart, 11) === "ICC_PROFILE";
    const isJfif = marker === 224;
    const isOtherApp = marker >= 224 && marker <= 239 && !isJfif && !isIcc;
    if (!isExifOrXmp && !isIptc && !isComment && !isOtherApp) out.push(segment);
    offset += 2 + length;
  }
  return concat(out);
}
function stripPng(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = [bytes.subarray(0, 8)];
  let offset = 8;
  while (offset + 12 <= bytes.length) {
    const length = view.getUint32(offset);
    const type = ascii(bytes, offset + 4, 4);
    const end = offset + 12 + length;
    if (PNG_KEEP.has(type)) out.push(bytes.subarray(offset, end));
    if (type === "IEND") break;
    offset = end;
  }
  return concat(out);
}
function stripWebp(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const kept = [];
  let offset = 12;
  let sawMetadata = false;
  while (offset + 8 <= bytes.length) {
    const fourcc2 = ascii(bytes, offset, 4);
    const size = view.getUint32(offset + 4, true);
    const padded = size + size % 2;
    const chunk = bytes.subarray(offset, offset + 8 + padded);
    if (fourcc2 === "EXIF" || fourcc2 === "XMP ") sawMetadata = true;
    else kept.push(chunk);
    offset += 8 + padded;
  }
  if (!sawMetadata) return bytes;
  const body = concat(kept);
  if (ascii(body, 0, 4) === "VP8X" && body.length > 12) body[8] &= ~12;
  const out = new Uint8Array(12 + body.length);
  out.set(bytes.subarray(0, 12));
  out.set(body, 12);
  new DataView(out.buffer).setUint32(4, out.length - 8, true);
  return out;
}
function stripGif(bytes) {
  let offset = 13;
  if (bytes[10] & 128) offset += 3 * (1 << (bytes[10] & 7) + 1);
  const out = [bytes.subarray(0, offset)];
  let changed = false;
  const skipBlocks = (start) => {
    let position = start;
    while (position < bytes.length && bytes[position] !== 0) position += bytes[position] + 1;
    return position + 1;
  };
  while (offset < bytes.length) {
    const marker = bytes[offset];
    if (marker === 59) {
      out.push(bytes.subarray(offset, offset + 1));
      break;
    }
    if (marker === 33) {
      const label = bytes[offset + 1];
      const end = skipBlocks(offset + 2);
      if (label === 254 || label === 255) changed = true;
      else out.push(bytes.subarray(offset, end));
      offset = end;
      continue;
    }
    if (marker === 44) {
      let position = offset + 10;
      if (bytes[offset + 9] & 128) position += 3 * (1 << (bytes[offset + 9] & 7) + 1);
      position = skipBlocks(position + 1);
      out.push(bytes.subarray(offset, position));
      offset = position;
      continue;
    }
    break;
  }
  return changed ? concat(out) : bytes;
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
async function flattenCrop(bytes, rect) {
  if (!canFlattenCrops()) return null;
  const mime = MIME[detectFormat(bytes)];
  if (!mime) return null;
  const keptWidth = 1 - rect.left - rect.right;
  const keptHeight = 1 - rect.top - rect.bottom;
  if (keptWidth <= 0 || keptHeight <= 0 || keptWidth > 0.999 && keptHeight > 0.999) return null;
  try {
    const bitmap = await createImageBitmap(new Blob([bytes], { type: mime }));
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
  for (const entry of entries) {
    if (!MEDIA.test(entry.name)) continue;
    const found = inspectImage(entry.data);
    if (found.length === 0) continue;
    imageParts.push(entry.name);
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
  for (const entry of entries) {
    if (!isXml(entry.name) || entry.name.endsWith(".rels")) continue;
    const xml = decodeText(entry.data);
    if (!xml.includes("srcRect")) continue;
    const rels = readRelationships(entries, relsPathFor(entry.name));
    const blipFills = xml.match(/<[a-z0-9]+:blipFill[\s\S]*?<\/[a-z0-9]+:blipFill>/g) ?? [];
    for (const fill of blipFills) {
      const srcRect = /<a:srcRect([^/>]*)\/>/.exec(fill);
      if (!srcRect) continue;
      const rect = parseCropRect(srcRect[1]);
      if (!rect) continue;
      const embed = /r:embed="([^"]+)"/.exec(fill);
      if (!embed) continue;
      const rel = rels.find((r) => r.id === embed[1]);
      if (!rel || rel.external) continue;
      uses.push({ ownerPart: entry.name, mediaPart: resolveTarget(relsPathFor(entry.name), rel.target), rect });
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
  for (const entry of entries) {
    if (!/^xl\/worksheets\/sheet\d+\.xml$/.test(entry.name)) continue;
    const xml = decodeText(entry.data);
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
  for (const entry of entries) {
    if (!entry.name.endsWith(".rels")) continue;
    for (const rel of readRelationships(entries, entry.name)) {
      if (rel.external && LOCAL_PATH.test(rel.target)) found.push({ part: entry.name, id: rel.id, target: rel.target });
    }
  }
  for (const entry of entries) {
    if (!/^xl\/externalLinks\/externalLink\d+\.xml$/.test(entry.name)) continue;
    found.push({ part: entry.name, id: "", target: entry.name });
  }
  return found;
}
function findChartWorkbooks(entries) {
  const found = [];
  for (const entry of entries) {
    if (!/charts\/chart\d*\.xml$/.test(entry.name)) continue;
    const xml = decodeText(entry.data);
    const external = /<c:externalData[^>]*r:id="([^"]+)"/.exec(xml);
    if (!external) continue;
    const rel = readRelationships(entries, relsPathFor(entry.name)).find((r) => r.id === external[1]);
    if (!rel || rel.external) continue;
    found.push({ chartPart: entry.name, relId: rel.id, target: resolveTarget(relsPathFor(entry.name), rel.target) });
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
  for (const entry of entries) {
    if (!isXml(entry.name)) continue;
    const xml = decodeText(entry.data);
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
  for (const entry of entries) {
    if (!MEDIA.test(entry.name)) continue;
    const stripped = stripImageMetadata(entry.data);
    if (stripped.length !== entry.data.length) {
      saved += entry.data.length - stripped.length;
      entry.data = stripped;
      cleaned.push(entry.name);
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
  for (const entry of entries) {
    if (!isXml(entry.name) || entry.name.endsWith(".rels")) continue;
    const xml = decodeText(entry.data);
    const rels = readRelationships(entries, relsPathFor(entry.name));
    for (const match of xml.match(/r:embed="([^"]+)"/g) ?? []) {
      const id = /r:embed="([^"]+)"/.exec(match)?.[1];
      const rel = rels.find((r) => r.id === id);
      if (!rel || rel.external) continue;
      const part = resolveTarget(relsPathFor(entry.name), rel.target);
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
    const entry = findEntry(entries, crop.mediaPart);
    if (!entry) continue;
    const cut = await flattenCrop(entry.data, crop.rect);
    if (!cut) {
      skipped.push(crop.mediaPart);
      continue;
    }
    entry.data = cut;
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
  for (const entry of entries) {
    if (/^xl\/pivotCache\/pivotCacheRecords\d*\.xml$/.test(entry.name)) {
      entry.data = encodeText(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r
<pivotCacheRecords xmlns="${NS.sheet}" xmlns:r="${NS.r}" count="0"/>`
      );
      touched.push(entry.name);
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
  const rels = readRelationships(entries, "xl/_rels/workbook.xml.rels");
  const targets = [];
  for (const sheet of Array.from(doc.getElementsByTagNameNS(NS.sheet, "sheet"))) {
    const state = sheet.getAttribute("state");
    if (state !== "hidden" && state !== "veryHidden") continue;
    const relId = sheet.getAttributeNS(NS.r, "id") ?? sheet.getAttribute("r:id") ?? "";
    const rel = rels.find((r) => r.id === relId);
    if (rel) targets.push(resolveTarget("xl/_rels/workbook.xml.rels", rel.target));
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
  for (const entry of entries) {
    if (!/^xl\/worksheets\/sheet\d+\.xml$/.test(entry.name)) continue;
    const doc = parseXml(decodeText(entry.data), entry.name);
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
      setText(entries, entry.name, serializeXml(doc));
      touched.push(entry.name);
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
  const sheetDocs = sheets.map((entry) => ({ entry, doc: parseXml(decodeText(entry.data), entry.name) }));
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
  for (const { entry, doc: sheetDoc } of sheetDocs) {
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
    if (changed) setText(entries, entry.name, serializeXml(sheetDoc));
  }
  return items.length - next;
}
function removeHiddenSlides(entries, log) {
  const hidden = listHiddenSlides(entries);
  if (hidden.length === 0) return;
  const presentationXml = textOf(entries, "ppt/presentation.xml");
  if (presentationXml) {
    const doc = parseXml(presentationXml, "ppt/presentation.xml");
    const rels = readRelationships(entries, "ppt/_rels/presentation.xml.rels");
    for (const slideId of Array.from(doc.getElementsByTagNameNS(NS.p, "sldId"))) {
      const relId = slideId.getAttributeNS(NS.r, "id") ?? slideId.getAttribute("r:id") ?? "";
      const rel = rels.find((r) => r.id === relId);
      if (!rel) continue;
      if (hidden.includes(resolveTarget("ppt/_rels/presentation.xml.rels", rel.target))) {
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
  for (const entry of entries.filter((e) => e.name.endsWith(".rels"))) {
    const doc = parseXml(decodeText(entry.data), entry.name);
    const ids = [];
    for (const rel of Array.from(doc.getElementsByTagNameNS(NS.rel, "Relationship"))) {
      if (rel.getAttribute("TargetMode") !== "External") continue;
      if (!LOCAL_PATH.test(rel.getAttribute("Target") ?? "")) continue;
      ids.push(rel.getAttribute("Id") ?? "");
      rel.parentNode?.removeChild(rel);
    }
    if (ids.length === 0) continue;
    entry.data = encodeText(serializeXml(doc));
    const owner = entry.name.replace(/_rels\/([^/]+)\.rels$/, "$1");
    removedIds.set(owner, ids);
  }
  for (const [owner, ids] of Array.from(removedIds.entries())) {
    const entry = findEntry(entries, owner);
    if (!entry) continue;
    let xml = decodeText(entry.data);
    for (const id of ids) {
      xml = xml.replace(new RegExp(`\\sr:id="${id}"`, "g"), "").replace(new RegExp(`\\sr:embed="${id}"`, "g"), "");
    }
    entry.data = encodeText(xml);
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
    const entry = findEntry(entries, chart.chartPart);
    if (!entry) continue;
    entry.data = encodeText(
      decodeText(entry.data).replace(/<c:externalData[\s\S]*?<\/c:externalData>/g, "").replace(/<c:externalData[^/>]*\/>/g, "")
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
  for (const stat2 of Array.from(doc.getElementsByTagNameNS(ODF_NS.meta, "document-statistic"))) {
    stat2.parentNode?.removeChild(stat2);
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
    for (const entry of entries) {
      if (!PICTURES.test(entry.name)) continue;
      const stripped = stripImageMetadata(entry.data);
      if (stripped.length !== entry.data.length) {
        entry.data = stripped;
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
function sortOdfEntries(entries) {
  const mimetype = findEntry(entries, "mimetype");
  if (!mimetype) return entries;
  mimetype.method = 0;
  return [mimetype, ...entries.filter((e) => e !== mimetype)];
}

// lib/pdf.ts
var DEFAULT_PDF_CLEAN = {
  removeXmp: true,
  removeJavaScript: true,
  removeEmbeddedFiles: true,
  removeAnnotations: false,
  dropOldRevisions: true
};
var PDF_FIELDS = [
  { key: "Title", label: "Titel" },
  { key: "Subject", label: "Thema" },
  { key: "Author", label: "Autor" },
  { key: "Keywords", label: "Stichw\xF6rter" },
  { key: "Creator", label: "Erstellt mit" },
  { key: "Producer", label: "PDF-Erzeuger" },
  { key: "CreationDate", label: "Erstellt am" },
  { key: "ModDate", label: "Ge\xE4ndert am" }
];
var isWhite = (c) => c === 32 || c === 10 || c === 13 || c === 9 || c === 12 || c === 0;
var isDelim = (c) => [40, 41, 60, 62, 91, 93, 123, 125, 47, 37].includes(c);
var latin1 = new TextDecoder("latin1");
var Lexer = class {
  constructor(bytes, pos = 0) {
    this.bytes = bytes;
    this.pos = pos;
  }
  skip() {
    while (this.pos < this.bytes.length) {
      const c = this.bytes[this.pos];
      if (isWhite(c)) this.pos++;
      else if (c === 37) {
        while (this.pos < this.bytes.length && this.bytes[this.pos] !== 10) this.pos++;
      } else break;
    }
  }
  peekKeyword(word) {
    this.skip();
    return latin1.decode(this.bytes.subarray(this.pos, this.pos + word.length)) === word;
  }
  readToken() {
    this.skip();
    const start = this.pos;
    while (this.pos < this.bytes.length && !isWhite(this.bytes[this.pos]) && !isDelim(this.bytes[this.pos])) this.pos++;
    if (this.pos === start) this.pos++;
    return latin1.decode(this.bytes.subarray(start, this.pos));
  }
  parse(depth = 0) {
    this.skip();
    if (this.pos >= this.bytes.length || depth > 64) return { t: "null" };
    const c = this.bytes[this.pos];
    if (c === 47) {
      this.pos++;
      const start = this.pos;
      while (this.pos < this.bytes.length && !isWhite(this.bytes[this.pos]) && !isDelim(this.bytes[this.pos])) this.pos++;
      return { t: "name", v: decodeName(latin1.decode(this.bytes.subarray(start, this.pos))) };
    }
    if (c === 40) return this.parseLiteralString();
    if (c === 60) {
      if (this.bytes[this.pos + 1] === 60) return this.parseDict(depth);
      return this.parseHexString();
    }
    if (c === 91) {
      this.pos++;
      const items = [];
      while (this.pos < this.bytes.length) {
        this.skip();
        if (this.bytes[this.pos] === 93) {
          this.pos++;
          break;
        }
        const before = this.pos;
        items.push(this.parse(depth + 1));
        if (this.pos === before) {
          this.pos++;
          break;
        }
      }
      return { t: "arr", v: items };
    }
    if (c === 93 || c === 62 || c === 41 || c === 125) {
      this.pos++;
      return { t: "null" };
    }
    const token = this.readToken();
    if (token === "true") return { t: "bool", v: true };
    if (token === "false") return { t: "bool", v: false };
    if (token === "null" || token === "") return { t: "null" };
    if (/^[+-]?[\d.]+$/.test(token)) {
      const save = this.pos;
      if (/^\d+$/.test(token)) {
        const gen = this.readToken();
        if (/^\d+$/.test(gen)) {
          const keyword = this.readToken();
          if (keyword === "R") return { t: "ref", num: Number(token), gen: Number(gen) };
        }
        this.pos = save;
      }
      return { t: "num", v: Number(token) };
    }
    return { t: "null" };
  }
  parseDict(depth) {
    this.pos += 2;
    const map = /* @__PURE__ */ new Map();
    while (this.pos < this.bytes.length) {
      this.skip();
      if (this.bytes[this.pos] === 62 && this.bytes[this.pos + 1] === 62) {
        this.pos += 2;
        break;
      }
      const key = this.parse(depth + 1);
      if (key.t !== "name") {
        if (this.pos >= this.bytes.length) break;
        continue;
      }
      map.set(key.v, this.parse(depth + 1));
    }
    const save = this.pos;
    this.skip();
    if (latin1.decode(this.bytes.subarray(this.pos, this.pos + 6)) === "stream") {
      this.pos += 6;
      if (this.bytes[this.pos] === 13) this.pos++;
      if (this.bytes[this.pos] === 10) this.pos++;
      const start = this.pos;
      const declared = map.get("Length");
      let end = declared?.t === "num" ? start + declared.v : -1;
      if (end < 0 || end > this.bytes.length || !endsWithEndstream(this.bytes, end)) {
        end = indexOfSequence(this.bytes, "endstream", start);
        if (end < 0) end = this.bytes.length;
        while (end > start && isWhite(this.bytes[end - 1])) end--;
      }
      const data = this.bytes.subarray(start, end);
      this.pos = Math.min(this.bytes.length, indexOfSequence(this.bytes, "endstream", end) + 9);
      return { t: "stream", dict: map, data };
    }
    this.pos = save;
    return { t: "dict", v: map };
  }
  parseLiteralString() {
    this.pos++;
    let depth = 1;
    let out = "";
    while (this.pos < this.bytes.length) {
      const c = this.bytes[this.pos++];
      if (c === 92) {
        out += String.fromCharCode(this.bytes[this.pos++]);
        continue;
      }
      if (c === 40) depth++;
      if (c === 41) {
        depth--;
        if (depth === 0) break;
      }
      out += String.fromCharCode(c);
    }
    return { t: "str", v: out, hex: false };
  }
  parseHexString() {
    this.pos++;
    let hex = "";
    while (this.pos < this.bytes.length && this.bytes[this.pos] !== 62) {
      const c = String.fromCharCode(this.bytes[this.pos++]);
      if (/[0-9a-fA-F]/.test(c)) hex += c;
    }
    this.pos++;
    let out = "";
    for (let i = 0; i < hex.length; i += 2) out += String.fromCharCode(parseInt(hex.substr(i, 2).padEnd(2, "0"), 16));
    return { t: "str", v: out, hex: true };
  }
};
var decodeName = (name) => name.replace(/#([0-9a-fA-F]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
function endsWithEndstream(bytes, at) {
  let i = at;
  while (i < bytes.length && isWhite(bytes[i])) i++;
  return latin1.decode(bytes.subarray(i, i + 9)) === "endstream";
}
function indexOfSequence(bytes, text, from) {
  const needle = new TextEncoder().encode(text);
  outer: for (let i = Math.max(0, from); i <= bytes.length - needle.length; i++) {
    for (let k = 0; k < needle.length; k++) if (bytes[i + k] !== needle[k]) continue outer;
    return i;
  }
  return -1;
}
async function inflate(data) {
  for (const format of ["deflate", "deflate-raw"]) {
    try {
      const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream(format));
      return new Uint8Array(await new Response(stream).arrayBuffer());
    } catch {
    }
  }
  return null;
}
async function parsePdf(bytes) {
  const objects = /* @__PURE__ */ new Map();
  const trailer = /* @__PURE__ */ new Map();
  const fromObjectStreams = /* @__PURE__ */ new Set();
  const text = latin1.decode(bytes);
  const objectPattern = /(\d+)\s+(\d+)\s+obj\b/g;
  let match;
  while (match = objectPattern.exec(text)) {
    const lexer = new Lexer(bytes, match.index + match[0].length);
    const value = lexer.parse();
    objects.set(Number(match[1]), value);
  }
  const trailerPattern = /trailer\b/g;
  while (match = trailerPattern.exec(text)) {
    const lexer = new Lexer(bytes, match.index + 7);
    const value = lexer.parse();
    if (value.t === "dict") for (const [key, entry] of Array.from(value.v.entries())) trailer.set(key, entry);
  }
  for (const [, value] of Array.from(objects.entries())) {
    const dict = value.t === "stream" ? value.dict : value.t === "dict" ? value.v : null;
    if (!dict) continue;
    const type = dict.get("Type");
    if (type?.t === "name" && type.v === "XRef") {
      for (const key of ["Root", "Info", "Encrypt"]) {
        const entry = dict.get(key);
        if (entry && !trailer.has(key)) trailer.set(key, entry);
      }
    }
  }
  for (const [, value] of Array.from(objects.entries())) {
    if (value.t !== "stream") continue;
    const type = value.dict.get("Type");
    if (type?.t !== "name" || type.v !== "ObjStm") continue;
    const filter = value.dict.get("Filter");
    const filterName = filter?.t === "name" ? filter.v : filter?.t === "arr" && filter.v[0]?.t === "name" ? filter.v[0].v : "";
    const data = filterName === "FlateDecode" ? await inflate(value.data) : value.data;
    if (!data) continue;
    const count = value.dict.get("N");
    const first = value.dict.get("First");
    if (count?.t !== "num" || first?.t !== "num") continue;
    const header = new Lexer(data, 0);
    const pairs = [];
    for (let i = 0; i < count.v; i++) {
      const num = Number(header.readToken());
      const offset = Number(header.readToken());
      if (Number.isNaN(num) || Number.isNaN(offset)) break;
      pairs.push({ num, offset });
    }
    for (const pair of pairs) {
      const lexer = new Lexer(data, first.v + pair.offset);
      objects.set(pair.num, lexer.parse());
      fromObjectStreams.add(pair.num);
    }
  }
  const revisions = (text.match(/%%EOF/g) ?? []).length;
  return { objects, trailer, encrypted: trailer.has("Encrypt"), revisions, fromObjectStreams };
}
var resolve = (doc, value) => value?.t === "ref" ? doc.objects.get(value.num) : value;
function dictOf(value) {
  if (!value) return null;
  if (value.t === "dict") return value.v;
  if (value.t === "stream") return value.dict;
  return null;
}
function pdfDateToIso(value) {
  const match = /^D?:?(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?/.exec(value);
  if (!match) return value;
  const [, y, mo = "01", d = "01", h = "00", mi = "00", s = "00"] = match;
  return `${y}-${mo}-${d}T${h}:${mi}:${s}Z`;
}
function isoToPdfDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const pad = (n) => String(n).padStart(2, "0");
  return `D:${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`;
}
async function readPdf(bytes) {
  const values = {};
  const findings = [];
  if (latin1.decode(bytes.subarray(0, 5)) !== "%PDF-") {
    return { values, findings, error: "Das ist keine PDF-Datei." };
  }
  const doc = await parsePdf(bytes);
  if (doc.encrypted) {
    return {
      values,
      findings: [
        {
          id: "encrypted",
          label: "Verschl\xFCsselte PDF-Datei",
          detail: "Verschl\xFCsselte PDFs werden nicht bearbeitet \u2014 ein Rettungsversuch w\xFCrde die Datei zerst\xF6ren. Bitte in einem PDF-Programm ohne Schutz neu speichern.",
          severity: "hoch"
        }
      ],
      error: "PDF ist verschl\xFCsselt."
    };
  }
  const info = dictOf(resolve(doc, doc.trailer.get("Info")));
  for (const field of PDF_FIELDS) {
    const value = info?.get(field.key);
    if (value?.t === "str") {
      values[field.key] = field.key.endsWith("Date") ? pdfDateToIso(value.v) : decodePdfText(value.v);
    } else {
      values[field.key] = "";
    }
  }
  if (info && Array.from(info.keys()).length > 0) {
    const extra = Array.from(info.keys()).filter((key) => !PDF_FIELDS.some((f) => f.key === key));
    if (extra.length > 0) {
      findings.push({
        id: "infoExtra",
        label: `Zus\xE4tzliche Info-Eintr\xE4ge: ${extra.join(", ")}`,
        detail: "Programme legen im Info-W\xF6rterbuch eigene Felder ab, etwa Bearbeiter oder interne Kennungen.",
        severity: "mittel"
      });
    }
  }
  const root = dictOf(resolve(doc, doc.trailer.get("Root")));
  if (root?.has("Metadata")) {
    findings.push({
      id: "xmp",
      label: "XMP-Metadaten",
      detail: "Der XMP-Block enth\xE4lt oft einen Bearbeitungsverlauf mit Programmen, Zeitstempeln und Dokument-IDs.",
      severity: "mittel"
    });
  }
  if (doc.revisions > 1) {
    findings.push({
      id: "revisions",
      label: `${doc.revisions} gespeicherte Fassungen in einer Datei`,
      detail: "PDFs wachsen beim Speichern an: \xE4ltere Fassungen bleiben vollst\xE4ndig erhalten und lassen sich wiederherstellen \u2014 samt Text, den jemand sp\xE4ter entfernt hat.",
      severity: "hoch"
    });
  }
  const names = dictOf(resolve(doc, root?.get("Names")));
  if (names?.has("JavaScript") || hasKeyAnywhere(doc, "JS")) {
    findings.push({
      id: "javascript",
      label: "Eingebettetes JavaScript",
      detail: "Skripte im Dokument k\xF6nnen beim \xD6ffnen ausgef\xFChrt werden und sind ein Sicherheitsrisiko.",
      severity: "hoch"
    });
  }
  if (names?.has("EmbeddedFiles") || countEmbeddedFiles(doc) > 0) {
    findings.push({
      id: "embeddedFiles",
      label: "Eingebettete Dateien",
      detail: "Angeh\xE4ngte Dateien bringen ihre eigenen Metadaten mit und werden beim Lesen leicht \xFCbersehen.",
      severity: "hoch"
    });
  }
  const annotations = countAnnotations(doc);
  if (annotations > 0) {
    findings.push({
      id: "annotations",
      label: `${annotations} Anmerkung(en)`,
      detail: "Kommentare, Notizen und Formularfelder enthalten Autorennamen und Zeitstempel.",
      severity: "mittel"
    });
  }
  const orphans = countUnreachable(doc);
  if (orphans > 0) {
    findings.push({
      id: "orphans",
      label: `${orphans} nicht mehr erreichbare Objekte`,
      detail: "Diese Objekte geh\xF6ren zu keiner Seite mehr \u2014 typischerweise Reste gel\xF6schter Inhalte. Beim Neuschreiben fallen sie weg.",
      severity: "mittel"
    });
  }
  return { values, findings };
}
function decodePdfText(value) {
  if (value.charCodeAt(0) === 254 && value.charCodeAt(1) === 255) {
    let out = "";
    for (let i = 2; i + 1 < value.length; i += 2) out += String.fromCharCode(value.charCodeAt(i) << 8 | value.charCodeAt(i + 1));
    return out;
  }
  return value;
}
function countEmbeddedFiles(doc) {
  let count = 0;
  for (const [, value] of Array.from(doc.objects.entries())) {
    const dict = dictOf(value);
    if (!dict) continue;
    const type = dict.get("Type");
    const subtype = dict.get("Subtype");
    if (type?.t === "name" && type.v === "EmbeddedFile") count++;
    else if (subtype?.t === "name" && subtype.v === "FileAttachment") count++;
  }
  return count;
}
function hasKeyAnywhere(doc, key) {
  const seen = /* @__PURE__ */ new Set();
  const visit = (value, depth) => {
    if (!value || depth > 32 || seen.has(value)) return false;
    seen.add(value);
    if (value.t === "arr") return value.v.some((item) => visit(item, depth + 1));
    const dict = dictOf(value);
    if (!dict) return false;
    if (dict.has(key)) return true;
    const subtype = dict.get("Subtype");
    if (subtype?.t === "name" && subtype.v === key) return true;
    return Array.from(dict.values()).some((entry) => visit(entry, depth + 1));
  };
  return Array.from(doc.objects.values()).some((value) => visit(value, 0));
}
function countAnnotations(doc) {
  let count = 0;
  for (const [, value] of Array.from(doc.objects.entries())) {
    const dict = dictOf(value);
    const type = dict?.get("Type");
    if (type?.t === "name" && type.v === "Annot") count++;
  }
  return count;
}
function reachable(doc, roots) {
  const seen = /* @__PURE__ */ new Set();
  const queue = [...roots];
  while (queue.length > 0) {
    const value = queue.pop();
    if (value.t === "ref") {
      if (seen.has(value.num)) continue;
      seen.add(value.num);
      const target = doc.objects.get(value.num);
      if (target) queue.push(target);
    } else if (value.t === "arr") {
      queue.push(...value.v);
    } else if (value.t === "dict") {
      queue.push(...Array.from(value.v.values()));
    } else if (value.t === "stream") {
      queue.push(...Array.from(value.dict.values()));
    }
  }
  return seen;
}
function countUnreachable(doc) {
  const root = doc.trailer.get("Root");
  if (!root) return 0;
  const roots = [root, doc.trailer.get("Info")].filter(Boolean);
  const live = reachable(doc, roots);
  let count = 0;
  for (const [num] of Array.from(doc.objects.entries())) {
    if (!live.has(num)) count++;
  }
  return count;
}
async function cleanPdf(bytes, values, options) {
  const doc = await parsePdf(bytes);
  const steps = [];
  if (doc.encrypted) return { bytes, steps, error: "Verschl\xFCsselte PDFs werden nicht ver\xE4ndert." };
  const rootRef = doc.trailer.get("Root");
  if (!rootRef) return { bytes, steps, error: "Im PDF wurde kein Dokumentkatalog gefunden \u2014 Bereinigung abgelehnt." };
  const root = dictOf(resolve(doc, rootRef));
  if (!root) return { bytes, steps, error: "Der Dokumentkatalog ist unlesbar \u2014 Bereinigung abgelehnt." };
  if (options.removeXmp && root.delete("Metadata")) steps.push("XMP-Metadaten entfernt");
  if (options.removeJavaScript) {
    const names = dictOf(resolve(doc, root.get("Names")));
    let removed = names?.delete("JavaScript") ?? false;
    const openAction = dictOf(resolve(doc, root.get("OpenAction")));
    const actionType = openAction?.get("S");
    if (openAction?.has("JS") || actionType?.t === "name" && actionType.v === "JavaScript") {
      root.delete("OpenAction");
      removed = true;
    }
    for (const [, value] of Array.from(doc.objects.entries())) {
      const dict = dictOf(value);
      if (dict?.delete("JS")) removed = true;
    }
    if (removed) steps.push("JavaScript entfernt");
  }
  if (options.removeEmbeddedFiles) {
    const names = dictOf(resolve(doc, root.get("Names")));
    let removed = names?.delete("EmbeddedFiles") ?? false;
    for (const [, value] of Array.from(doc.objects.entries())) {
      const dict = dictOf(value);
      const annots = resolve(doc, dict?.get("Annots"));
      if (!dict || annots?.t !== "arr") continue;
      const kept = annots.v.filter((item) => {
        const annot = dictOf(resolve(doc, item));
        const subtype = annot?.get("Subtype");
        return !(subtype?.t === "name" && subtype.v === "FileAttachment");
      });
      if (kept.length === annots.v.length) continue;
      annots.v = kept;
      removed = true;
    }
    if (removed) steps.push("Eingebettete Dateien entfernt");
  }
  if (options.removeAnnotations) {
    let count = 0;
    for (const [, value] of Array.from(doc.objects.entries())) {
      const dict = dictOf(value);
      const type = dict?.get("Type");
      if (type?.t === "name" && type.v === "Page" && dict?.has("Annots")) {
        dict.delete("Annots");
        count++;
      }
    }
    if (count > 0) steps.push(`Anmerkungen von ${count} Seite(n) entfernt`);
  }
  const infoEntries = /* @__PURE__ */ new Map();
  for (const field of PDF_FIELDS) {
    const value = (values[field.key] ?? "").trim();
    if (value === "") continue;
    infoEntries.set(field.key, { t: "str", v: field.key.endsWith("Date") ? isoToPdfDate(value) : value, hex: false });
  }
  const pagesBefore = countPages(doc);
  const live = reachable(doc, [rootRef]);
  const dropped = doc.objects.size - live.size;
  if (dropped > 0 && options.dropOldRevisions) steps.push(`${dropped} nicht erreichbare Objekte weggelassen`);
  if (doc.revisions > 1) steps.push(`${doc.revisions - 1} \xE4ltere Fassung(en) verworfen`);
  const keep = options.dropOldRevisions ? live : new Set(Array.from(doc.objects.keys()));
  const out = serialize(doc, keep, rootRef, infoEntries);
  const check = await parsePdf(out);
  const pagesAfter = countPages(check);
  if (pagesBefore > 0 && pagesAfter !== pagesBefore) {
    return {
      bytes,
      steps,
      error: `Sicherheitspr\xFCfung fehlgeschlagen: vorher ${pagesBefore} Seiten, nachher ${pagesAfter}. Die Datei wurde nicht ver\xE4ndert.`
    };
  }
  if (infoEntries.size > 0) steps.push(`Info-W\xF6rterbuch neu geschrieben (${infoEntries.size} Feld(er))`);
  else steps.push("Info-W\xF6rterbuch entfernt");
  return { bytes: out, steps };
}
function countPages(doc) {
  let count = 0;
  for (const [, value] of Array.from(doc.objects.entries())) {
    const dict = dictOf(value);
    const type = dict?.get("Type");
    if (type?.t === "name" && type.v === "Page") count++;
  }
  return count;
}
function serialize(doc, keep, rootRef, infoEntries) {
  const chunks = [];
  const encoder2 = new TextEncoder();
  const push = (text) => chunks.push(encoder2.encode(text));
  let offset = 0;
  const offsets = /* @__PURE__ */ new Map();
  const track = (chunk) => {
    chunks.push(chunk);
    offset += chunk.length;
  };
  const write = (text) => track(encoder2.encode(text));
  write("%PDF-1.7\n%\xE2\xE3\xCF\xD3\n");
  const numbers = Array.from(keep).sort((a, b) => a - b);
  const maxNumber = numbers.length > 0 ? numbers[numbers.length - 1] : 0;
  const infoNumber = maxNumber + 1;
  for (const num of numbers) {
    const value = doc.objects.get(num);
    if (!value) continue;
    const dict = dictOf(value);
    const type = dict?.get("Type");
    if (type?.t === "name" && (type.v === "ObjStm" || type.v === "XRef")) continue;
    offsets.set(num, offset);
    write(`${num} 0 obj
`);
    if (value.t === "stream") {
      write(serializeValue({ t: "dict", v: withLength(value) }));
      write("\nstream\n");
      track(value.data);
      write("\nendstream");
    } else {
      write(serializeValue(value));
    }
    write("\nendobj\n");
  }
  if (infoEntries.size > 0) {
    offsets.set(infoNumber, offset);
    write(`${infoNumber} 0 obj
`);
    write(serializeValue({ t: "dict", v: infoEntries }));
    write("\nendobj\n");
  }
  const size = (infoEntries.size > 0 ? infoNumber : maxNumber) + 1;
  const xrefOffset = offset;
  write("xref\n");
  write(`0 ${size}
`);
  write("0000000000 65535 f \n");
  for (let num = 1; num < size; num++) {
    const at2 = offsets.get(num);
    write(at2 === void 0 ? "0000000000 65535 f \n" : `${String(at2).padStart(10, "0")} 00000 n 
`);
  }
  const rootNumber = rootRef.t === "ref" ? rootRef.num : 0;
  write("trailer\n");
  write(`<< /Size ${size} /Root ${rootNumber} 0 R`);
  if (infoEntries.size > 0) write(` /Info ${infoNumber} 0 R`);
  write(" >>\n");
  write(`startxref
${xrefOffset}
%%EOF
`);
  void push;
  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}
function withLength(stream) {
  const dict = new Map(stream.dict);
  dict.set("Length", { t: "num", v: stream.data.length });
  return dict;
}
function serializeValue(value) {
  switch (value.t) {
    case "num":
      return Number.isInteger(value.v) ? String(value.v) : String(Number(value.v.toFixed(6)));
    case "name":
      return "/" + value.v.replace(/[^\x21-\x7e]|[#()<>[\]{}/%]/g, (c) => "#" + c.charCodeAt(0).toString(16).padStart(2, "0"));
    case "bool":
      return value.v ? "true" : "false";
    case "null":
      return "null";
    case "ref":
      return `${value.num} ${value.gen} R`;
    case "str":
      return serializeString(value.v);
    case "arr":
      return `[ ${value.v.map(serializeValue).join(" ")} ]`;
    case "dict":
      return `<< ${Array.from(value.v.entries()).map(([key, entry]) => `${serializeValue({ t: "name", v: key })} ${serializeValue(entry)}`).join(" ")} >>`;
    case "stream":
      return serializeValue({ t: "dict", v: value.dict });
  }
}
function serializeString(value) {
  const needsUtf16 = /[^\x20-\x7e]/.test(value);
  if (needsUtf16) {
    let hex = "FEFF";
    for (const char of value) {
      const code = char.codePointAt(0) ?? 0;
      hex += code.toString(16).padStart(4, "0").toUpperCase();
    }
    return `<${hex}>`;
  }
  return `(${value.replace(/[\\()]/g, (c) => "\\" + c)})`;
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
var isOle2 = (bytes) => SIGNATURE.every((byte, index) => bytes[index] === byte);
function readCompound(bytes) {
  if (!isOle2(bytes) || bytes.length < 512) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
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
    if (base + sectorSize > bytes.length) break;
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
    if (base + sectorSize > bytes.length) break;
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
    if (base + sectorSize > bytes.length) break;
    for (let i = 0; i < sectorSize / 4; i++) miniFat.push(view.getUint32(base + i * 4, true));
  }
  const directorySectors = chain(directoryStart);
  const entries = [];
  for (const sector of directorySectors) {
    const base = sectorOffset(sector);
    for (let offset = base; offset + 128 <= base + sectorSize && offset + 128 <= bytes.length; offset += 128) {
      const nameLength = view.getUint16(offset + 64, true);
      if (nameLength < 2) continue;
      let name = "";
      for (let i = 0; i < nameLength - 2; i += 2) name += String.fromCharCode(view.getUint16(offset + i, true));
      entries.push({
        name,
        type: bytes[offset + 66],
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
function readStream(bytes, location) {
  const out = new Uint8Array(location.ranges.reduce((sum, r) => sum + (r.end - r.start), 0));
  let offset = 0;
  for (const range of location.ranges) {
    const slice = bytes.subarray(range.start, Math.min(range.end, bytes.length));
    out.set(slice, offset);
    offset += range.end - range.start;
  }
  return out.subarray(0, Math.max(location.size, 0) || out.length);
}
function writeStream(bytes, location, data) {
  const capacity = location.ranges.reduce((sum, r) => sum + (r.end - r.start), 0);
  if (data.length > capacity) return false;
  let offset = 0;
  for (const range of location.ranges) {
    const length = range.end - range.start;
    for (let i = 0; i < length; i++) {
      const target = range.start + i;
      if (target >= bytes.length) break;
      bytes[target] = offset + i < data.length ? data[offset + i] : 0;
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
    const entry = sectionOffset + 8 + i * 8;
    if (entry + 8 > stream.length) break;
    const id = view.getUint32(entry, true);
    const offset = sectionOffset + view.getUint32(entry + 4, true);
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
  const encoder2 = new TextEncoder();
  const properties = [];
  const codePage = new Uint8Array(8);
  new DataView(codePage.buffer).setUint32(0, 2, true);
  new DataView(codePage.buffer).setUint16(4, 65001, true);
  properties.push({ id: 1, body: codePage });
  for (const [id, value] of Array.from(values.entries())) {
    if (id === 1) continue;
    if (typeof value === "string") {
      if (value === "") continue;
      const text = encoder2.encode(value + "\0");
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
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  const swap = (a, b) => {
    const tmp = bytes[a];
    bytes[a] = bytes[b];
    bytes[b] = tmp;
  };
  swap(0, 3);
  swap(1, 2);
  swap(4, 5);
  swap(6, 7);
  return bytes;
}
function readOle2(bytes) {
  const compound = readCompound(bytes);
  if (!compound) return null;
  const summary = compound.streams.get(SUMMARY);
  const docSummary = compound.streams.get(DOC_SUMMARY);
  const summaryValues = summary ? parsePropertySet(readStream(bytes, summary)) : /* @__PURE__ */ new Map();
  const docValues = docSummary ? parsePropertySet(readStream(bytes, docSummary)) : /* @__PURE__ */ new Map();
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
function writeOle2(bytes, values) {
  const compound = readCompound(bytes);
  if (!compound) return { bytes, steps: [], error: "Datei ist kein g\xFCltiges OLE2-Dokument." };
  const out = bytes.slice();
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
        bytes,
        steps,
        error: "Die neuen Werte brauchen mehr Platz, als das alte Format in dieser Datei vorsieht. K\xFCrzere Texte verwenden oder die Datei als .docx/.xlsx speichern."
      };
    }
    steps.push(`${streamName.slice(1)} neu geschrieben (${properties.size} Eigenschaft(en))`);
  }
  return { bytes: out, steps };
}

// lib/mediaMeta.ts
var dec2 = new TextDecoder("latin1");
var fourcc = (bytes, at) => dec2.decode(bytes.subarray(at, at + 4));
function detectMedia(bytes) {
  if (bytes.length > 12 && fourcc(bytes, 4) === "ftyp") return "mp4";
  if (bytes.length > 10 && dec2.decode(bytes.subarray(0, 3)) === "ID3") return "mp3";
  if (bytes.length > 2 && bytes[0] === 255 && (bytes[1] & 224) === 224) return "mp3";
  return "unknown";
}
function syncSafe(bytes, at) {
  return bytes[at] << 21 | bytes[at + 1] << 14 | bytes[at + 2] << 7 | bytes[at + 3];
}
function id3v2Length(bytes) {
  if (bytes.length < 10 || dec2.decode(bytes.subarray(0, 3)) !== "ID3") return 0;
  const footer = (bytes[5] & 16) !== 0 ? 10 : 0;
  return 10 + syncSafe(bytes, 6) + footer;
}
var hasId3v1 = (bytes) => bytes.length > 128 && dec2.decode(bytes.subarray(bytes.length - 128, bytes.length - 125)) === "TAG";
function inspectMedia(bytes) {
  const findings = [];
  const format = detectMedia(bytes);
  if (format === "mp3") {
    const length = id3v2Length(bytes);
    if (length > 0) {
      findings.push({ label: "ID3v2-Tag", value: `${Math.round(length / 1024)} KB` });
      const head = dec2.decode(bytes.subarray(0, Math.min(length, 4096)));
      if (/TPE1|TCOM|TOPE/.test(head)) findings.push({ label: "Interpret-/Urheberangaben" });
      if (/COMM|TXXX/.test(head)) findings.push({ label: "Freitext-Kommentare" });
      if (/PRIV/.test(head)) findings.push({ label: "Programmspezifische Daten (PRIV)" });
    }
    if (hasId3v1(bytes)) findings.push({ label: "ID3v1-Tag" });
    return findings;
  }
  if (format === "mp4") {
    for (const box of findBoxes(bytes)) {
      if (box.type === "udta") findings.push({ label: "Benutzerdaten (udta)" });
      else if (box.type === "meta") findings.push({ label: "Metadaten-Box (meta)" });
      else if (box.type === "uuid") findings.push({ label: "XMP-Block" });
      const text = dec2.decode(bytes.subarray(box.start, Math.min(box.end, box.start + 2048)));
      if (/©xyz|loci/.test(text)) findings.push({ label: "GPS-Position" });
      if (/©too|©swr/.test(text)) findings.push({ label: "Aufnahme-Software" });
    }
    const seen = /* @__PURE__ */ new Set();
    return findings.filter((f) => seen.has(f.label) ? false : (seen.add(f.label), true));
  }
  return findings;
}
function findBoxes(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
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
      const type = fourcc(bytes, offset + 4);
      boxes.push({ type, start: offset, end: offset + size, headerSize });
      if ((type === "moov" || type === "trak" || type === "mdia") && depth < 3) {
        walk(offset + headerSize, offset + size, depth + 1);
      }
      offset += size;
    }
  };
  walk(0, bytes.length, 0);
  return boxes;
}
function stripMediaMetadata(bytes) {
  const format = detectMedia(bytes);
  if (format === "mp3") {
    const start = id3v2Length(bytes);
    const end = hasId3v1(bytes) ? bytes.length - 128 : bytes.length;
    if (start === 0 && end === bytes.length) return bytes;
    return bytes.slice(start, end);
  }
  if (format === "mp4") {
    const boxes = findBoxes(bytes).filter((b) => b.type === "udta" || b.type === "meta" || b.type === "uuid");
    const outer = boxes.filter((box) => !boxes.some((other) => other !== box && box.start > other.start && box.end <= other.end));
    if (outer.length === 0) return bytes;
    const out = bytes.slice();
    const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
    for (const box of outer) {
      out.fill(0, box.start + 8, box.end);
      view.setUint32(box.start, box.end - box.start);
      out.set(new TextEncoder().encode("free"), box.start + 4);
    }
    return out;
  }
  return bytes;
}

// lib/clean.ts
var DEFAULT_OPTIONS = {
  base: DEFAULT_CLEANUP,
  deep: DEFAULT_DEEP_OPTIONS,
  odf: DEFAULT_ODF_CLEAN,
  pdf: DEFAULT_PDF_CLEAN,
  rtf: DEFAULT_RTF_CLEAN
};
var OOXML_EXT = [".docx", ".docm", ".dotx", ".dotm", ".xlsx", ".xlsm", ".xltx", ".xltm", ".pptx", ".pptm", ".potx", ".ppsx", ".ppsm"];
var ODF_EXT = [".odt", ".ods", ".odp", ".odg", ".otm", ".ott", ".ots", ".otp"];
var OLE2_EXT = [".doc", ".xls", ".ppt", ".dot", ".xlt", ".pot"];
var IMAGE_EXT = [".jpg", ".jpeg", ".png", ".gif", ".webp", ".tif", ".tiff"];
var MEDIA_EXT = [".mp3", ".mp4", ".m4a", ".m4v", ".mov"];
var SUPPORTED_EXTENSIONS = [...OOXML_EXT, ...ODF_EXT, ...OLE2_EXT, ".pdf", ".rtf", ...IMAGE_EXT, ...MEDIA_EXT];
async function sha256(bytes) {
  if (typeof crypto === "undefined" || !crypto.subtle) return "";
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
function detectKind(name, bytes) {
  const lower = name.toLowerCase();
  const isZip = bytes[0] === 80 && bytes[1] === 75;
  if (isZip) {
    if (ODF_EXT.some((ext) => lower.endsWith(ext))) return "odf";
    if (OOXML_EXT.some((ext) => lower.endsWith(ext))) return "ooxml";
    return "ooxml";
  }
  if (new TextDecoder("latin1").decode(bytes.subarray(0, 5)) === "%PDF-") return "pdf";
  if (isOle2(bytes)) return "ole2";
  if (detectFormat(bytes) !== "unknown") return "image";
  if (detectMedia(bytes) !== "unknown") return "media";
  if (isRtf(new TextDecoder("latin1").decode(bytes.subarray(0, 64)))) return "rtf";
  return "unbekannt";
}
var officeFields = () => FIELDS.map((field) => ({
  key: field.key,
  label: field.label,
  kind: field.kind,
  hint: field.hint,
  group: field.part === "core" ? "Dokumenteigenschaften" : "Erweiterte Eigenschaften"
}));
async function loadFile(name, bytes) {
  const base = {
    name,
    size: bytes.length,
    kind: detectKind(name, bytes),
    fields: [],
    values: {},
    customProps: [],
    findings: [],
    sha256: await sha256(bytes),
    bytes
  };
  try {
    switch (base.kind) {
      case "ooxml":
      case "odf": {
        const entries = await readZip(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
        base.entries = entries;
        if (isOdfPackage(entries)) {
          base.kind = "odf";
          base.fields = ODF_FIELDS.map((f) => ({
            key: f.key,
            label: f.label,
            kind: f.kind === "datetime" ? "datetime" : f.kind === "number" ? "number" : "text",
            group: "Dokumenteigenschaften"
          }));
          base.values = readOdfFields(entries);
          base.findings = scanOdf(entries).map((f) => ({ ...f, option: f.id }));
        } else {
          base.kind = "ooxml";
          base.fields = officeFields();
          base.values = readOfficeFields(entries);
          base.customProps = readCustomProps(entries);
          base.findings = [
            ...scanTraces(entries).map((trace) => ({
              id: trace.id,
              label: trace.label,
              detail: trace.detail,
              severity: trace.removable ? "mittel" : "hoch",
              option: trace.removable ? trace.id : void 0
            })),
            ...scanDeep(entries).map((finding) => ({
              id: finding.id,
              label: finding.label,
              detail: finding.detail,
              severity: finding.severity,
              option: finding.option,
              parts: finding.parts
            }))
          ];
        }
        break;
      }
      case "pdf": {
        const info = await readPdf(bytes);
        base.fields = PDF_FIELDS.map((f) => ({
          key: f.key,
          label: f.label,
          kind: f.key.endsWith("Date") ? "datetime" : "text",
          group: "Dokumenteigenschaften"
        }));
        base.values = info.values;
        base.findings = info.findings.map((f) => ({ ...f, option: f.id }));
        base.error = info.error;
        break;
      }
      case "ole2": {
        const document = readOle2(bytes);
        if (!document) {
          base.error = "Die Datei lie\xDF sich nicht als OLE2-Dokument lesen.";
          break;
        }
        base.fields = OLE2_FIELDS.map((f) => ({
          key: f.key,
          label: f.label,
          kind: f.kind === "datetime" ? "datetime" : f.kind === "number" ? "number" : "text",
          group: f.stream === "summary" ? "Dokumenteigenschaften" : "Erweiterte Eigenschaften"
        }));
        base.values = document.values;
        base.findings = document.findings.map((f) => ({ ...f, option: void 0 }));
        break;
      }
      case "rtf": {
        const text = new TextDecoder("latin1").decode(bytes);
        base.text = text;
        base.fields = RTF_FIELDS.map((f) => ({
          key: f.key,
          label: f.label,
          kind: f.kind === "number" ? "number" : "text",
          group: "Dokumenteigenschaften"
        }));
        base.values = readRtfFields(text);
        base.findings = scanRtf(text).map((f) => ({ ...f, option: f.id }));
        break;
      }
      case "image": {
        const found = inspectImage(bytes);
        base.findings = found.map((item) => ({
          id: "imageMetadata",
          label: item.value ? `${item.label}: ${item.value}` : item.label,
          detail: "Steht im Metadatenblock des Bildes und wird beim Versenden mitgeschickt.",
          severity: item.label.startsWith("GPS") ? "hoch" : "mittel",
          option: "stripImageMetadata"
        }));
        break;
      }
      case "media": {
        base.findings = inspectMedia(bytes).map((item) => ({
          id: "mediaMetadata",
          label: item.value ? `${item.label}: ${item.value}` : item.label,
          detail: "Steht im Tag-Bereich der Mediendatei.",
          severity: item.label.startsWith("GPS") ? "hoch" : "mittel",
          option: "stripMediaMetadata"
        }));
        break;
      }
      default:
        base.error = "Dieses Format wird nicht unterst\xFCtzt.";
    }
  } catch (err) {
    base.error = err instanceof Error ? err.message : "Die Datei konnte nicht gelesen werden.";
  }
  return base;
}
async function cleanFile(file, values, customProps, options) {
  const steps = [];
  let fileName = file.name;
  let bytes = file.bytes;
  try {
    if (file.kind === "ooxml" && file.entries) {
      const entries = file.entries.map((e) => ({ ...e, data: new Uint8Array(e.data) }));
      applyFields(entries, values, "core");
      applyFields(entries, values, "app");
      steps.push("Dokumenteigenschaften geschrieben");
      if (options.base.stripCustomProps) {
        if (removeParts(entries, (name) => name === "docProps/custom.xml").length > 0) {
          steps.push("Benutzerdefinierte Eigenschaften gel\xF6scht");
        }
      } else {
        applyCustomProps(entries, customProps);
      }
      if (options.base.stripThumbnail) {
        if (removeParts(entries, (name) => name.startsWith("docProps/thumbnail")).length > 0) {
          steps.push("Vorschaubild entfernt");
        }
      }
      if (options.base.stripComments) {
        const removed = stripCommentsFromPackage(entries);
        if (removed.length > 0) steps.push(`Kommentare und Personenliste entfernt (${removed.length} Teil(e))`);
      }
      if (options.base.stripRsids) {
        const touched = stripRsidsFromPackage(entries);
        if (touched.length > 0) steps.push(`Word-RSIDs aus ${touched.length} Teil(en) entfernt`);
      }
      const deep = await applyDeepClean(entries, options.deep);
      steps.push(...deep.steps.map((step) => step.summary));
      if (deep.newExtension) {
        const extension = macroFreeExtension(file.name);
        if (extension) fileName = file.name.replace(/\.[^.]+$/, `.${extension}`);
      }
      const timestamp = options.base.normalizeZipTimestamps ? parseDate(values.modified ?? values.created) : void 0;
      if (timestamp) steps.push("ZIP-Zeitstempel angeglichen");
      bytes = new Uint8Array(await (await writeZip(entries, timestamp)).arrayBuffer());
    } else if (file.kind === "odf" && file.entries) {
      const entries = file.entries.map((e) => ({ ...e, data: new Uint8Array(e.data) }));
      writeOdfFields(entries, values);
      steps.push("Dokumenteigenschaften geschrieben");
      steps.push(...cleanOdf(entries, options.odf));
      const timestamp = options.base.normalizeZipTimestamps ? parseDate(values.date ?? values["creation-date"]) : void 0;
      if (timestamp) steps.push("ZIP-Zeitstempel angeglichen");
      bytes = new Uint8Array(await (await writeZip(sortOdfEntries(entries), timestamp)).arrayBuffer());
    } else if (file.kind === "pdf") {
      const result = await cleanPdf(file.bytes, values, options.pdf);
      if (result.error) return failure(file, result.error);
      bytes = result.bytes;
      steps.push(...result.steps);
    } else if (file.kind === "ole2") {
      const result = writeOle2(file.bytes, values);
      if (result.error) return failure(file, result.error);
      bytes = result.bytes;
      steps.push(...result.steps);
    } else if (file.kind === "rtf" && file.text !== void 0) {
      let text = writeRtfFields(file.text, values);
      const result = cleanRtf(text, options.rtf);
      text = result.text;
      steps.push("Dokumenteigenschaften geschrieben", ...result.steps);
      bytes = new Uint8Array(text.length);
      for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i) & 255;
    } else if (file.kind === "image") {
      bytes = stripImageMetadata(file.bytes);
      steps.push(bytes.length === file.bytes.length ? "Keine Bildmetadaten gefunden" : "Bildmetadaten entfernt");
    } else if (file.kind === "media") {
      bytes = stripMediaMetadata(file.bytes);
      steps.push(bytes.length === file.bytes.length ? "Keine Medien-Tags gefunden" : "Medien-Tags entfernt");
    } else {
      return failure(file, file.error ?? "Dieses Format wird nicht unterst\xFCtzt.");
    }
  } catch (err) {
    return failure(file, err instanceof Error ? err.message : "Die Datei konnte nicht geschrieben werden.");
  }
  const verified = await loadFile(fileName, bytes);
  return {
    bytes,
    fileName,
    steps,
    sha256Before: file.sha256,
    sha256After: await sha256(bytes),
    remaining: verified.findings
  };
}
function failure(file, error) {
  return {
    bytes: file.bytes,
    fileName: file.name,
    steps: [],
    sha256Before: file.sha256,
    sha256After: file.sha256,
    remaining: file.findings,
    error
  };
}
function parseDate(value) {
  if (!value) return /* @__PURE__ */ new Date();
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? /* @__PURE__ */ new Date() : date;
}
function buildReportText(entries, generatedAt) {
  const lines = [];
  lines.push("Metadaten-Bereinigung \u2014 Protokoll");
  lines.push(`Erstellt: ${generatedAt}`);
  lines.push(`Dateien: ${entries.length}`);
  lines.push("");
  for (const entry of entries) {
    lines.push("=".repeat(72));
    lines.push(`Datei:    ${entry.file}`);
    lines.push(`Format:   ${entry.kind}`);
    lines.push(`Gr\xF6\xDFe:    ${entry.sizeBefore} \u2192 ${entry.sizeAfter} Bytes`);
    lines.push(`SHA-256:  ${entry.sha256Before}`);
    lines.push(`          ${entry.sha256After}`);
    if (entry.error) {
      lines.push(`FEHLER:   ${entry.error}`);
      lines.push("");
      continue;
    }
    lines.push("");
    lines.push(`Gefunden (${entry.findingsBefore.length}):`);
    for (const finding of entry.findingsBefore) lines.push(`  [${finding.severity}] ${finding.label}`);
    lines.push("");
    lines.push(`Durchgef\xFChrt (${entry.steps.length}):`);
    for (const step of entry.steps) lines.push(`  - ${step}`);
    lines.push("");
    if (entry.remaining.length === 0) {
      lines.push("Nachkontrolle: keine Funde mehr.");
    } else {
      lines.push(`Nachkontrolle \u2014 weiterhin vorhanden (${entry.remaining.length}):`);
      for (const finding of entry.remaining) lines.push(`  [${finding.severity}] ${finding.label}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

// cli/main.ts
var globals = globalThis;
if (!globals.DOMParser) globals.DOMParser = DOMParser2;
if (!globals.XMLSerializer) globals.XMLSerializer = XMLSerializer2;
var on = (options) => Object.fromEntries(Object.keys(options).map((key) => [key, true]));
var PROFILES = {
  standard: {
    description: "Ausgewogen: Metadaten bereinigen, Inhalte unangetastet lassen",
    options: DEFAULT_OPTIONS
  },
  streng: {
    description: "Alles entfernen, was entfernt werden kann \u2014 inklusive Inhalten wie Notizen und ausgeblendeten Bl\xE4ttern",
    options: {
      base: on(DEFAULT_OPTIONS.base),
      deep: on(DEFAULT_OPTIONS.deep),
      odf: on(DEFAULT_OPTIONS.odf),
      pdf: on(DEFAULT_OPTIONS.pdf),
      rtf: on(DEFAULT_OPTIONS.rtf)
    },
    clearAll: true
  },
  weitergabe: {
    description: "F\xFCr den Versand nach au\xDFen: Namen anonymisieren, Notizen und Verkn\xFCpfungen entfernen",
    options: {
      base: { ...DEFAULT_OPTIONS.base, stripCustomProps: true, stripComments: true },
      deep: {
        ...DEFAULT_OPTIONS.deep,
        anonymizeAuthors: true,
        removeSpeakerNotes: true,
        removeChartWorkbooks: true,
        removeMacros: true
      },
      odf: { ...DEFAULT_OPTIONS.odf, anonymizeAuthors: true },
      pdf: DEFAULT_OPTIONS.pdf,
      rtf: { ...DEFAULT_OPTIONS.rtf, anonymizeAuthors: true }
    }
  }
};
function parseArgs(argv) {
  const args = {
    paths: [],
    profile: "standard",
    inPlace: false,
    recursive: false,
    watch: false,
    intervalSeconds: 10,
    json: false,
    scanOnly: false,
    clearAll: false,
    values: {},
    help: false
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => argv[++i];
    switch (arg) {
      case "--hilfe":
      case "--help":
      case "-h":
        args.help = true;
        break;
      case "--profil":
      case "--profile":
        args.profile = next();
        break;
      case "--profil-datei":
        args.profilePath = next();
        break;
      case "--ziel":
      case "--out":
        args.out = next();
        break;
      case "--ersetzen":
        args.inPlace = true;
        break;
      case "--rekursiv":
        args.recursive = true;
        break;
      case "--ueberwachen":
      case "--watch":
        args.watch = true;
        break;
      case "--intervall":
        args.intervalSeconds = Math.max(2, Number(next()) || 10);
        break;
      case "--bericht":
        args.reportPath = next();
        break;
      case "--json":
        args.json = true;
        break;
      case "--nur-bericht":
        args.scanOnly = true;
        break;
      case "--alles-leeren":
        args.clearAll = true;
        break;
      case "--setzen": {
        const pair = next() ?? "";
        const at = pair.indexOf("=");
        if (at > 0) args.values[pair.slice(0, at)] = pair.slice(at + 1);
        break;
      }
      default:
        if (arg.startsWith("-")) throw new Error(`Unbekannte Option: ${arg}`);
        args.paths.push(arg);
    }
  }
  return args;
}
var HELP = `Metadaten-Bereinigung

  metadaten-clean [Optionen] <Datei|Ordner> ...

Optionen
  --profil <name>        standard | streng | weitergabe   (Vorgabe: standard)
  --profil-datei <pfad>  Eigenes Profil als JSON-Datei (darf unter "values"
                         auch eine Vorlage f\xFCr alle Dateien enthalten)
  --ziel <ordner>        Ergebnisse dorthin schreiben
  --ersetzen             Dateien an Ort und Stelle \xFCberschreiben
  --rekursiv             Unterordner mitnehmen
  --ueberwachen          Ordner beobachten und neue Dateien automatisch bereinigen
  --intervall <sek>      Pr\xFCfabstand beim \xDCberwachen (Vorgabe: 10)
  --nur-bericht          Nichts ver\xE4ndern, nur pr\xFCfen
  --bericht <datei>      Protokoll zus\xE4tzlich in eine Datei schreiben
  --json                 Ausgabe maschinenlesbar
  --alles-leeren         Alle Eigenschaftsfelder leeren
  --setzen key=wert      Einzelnes Feld setzen (mehrfach m\xF6glich)
  --hilfe                Diese \xDCbersicht

Ohne --ziel und ohne --ersetzen wird "name-bereinigt.endung" daneben gelegt;
mit --ziel behalten die Dateien ihren Namen.
Der R\xFCckgabewert ist 1, sobald eine Datei nicht verarbeitet werden konnte.`;
async function collectFiles(paths, recursive) {
  const files = [];
  const visit = async (path, depth) => {
    const info = await stat(path).catch(() => null);
    if (!info) return;
    if (info.isFile()) {
      if (SUPPORTED_EXTENSIONS.includes(extname(path).toLowerCase())) files.push(path);
      return;
    }
    if (!info.isDirectory()) return;
    if (depth > 0 && !recursive) return;
    for (const item of await readdir(path)) {
      if (item.startsWith(".")) continue;
      await visit(join(path, item), depth + 1);
    }
  };
  for (const path of paths) await visit(resolve2(path), 0);
  return files;
}
function targetPath(source, args) {
  if (args.inPlace) return source;
  const extension = extname(source);
  const name = source.slice(0, source.length - extension.length);
  if (!args.out) return `${name}-bereinigt${extension}`;
  return join(resolve2(args.out), `${name.split("/").pop()}${extension}`);
}
async function loadProfile(args) {
  if (args.profilePath) {
    const raw = JSON.parse(await readFile(resolve2(args.profilePath), "utf8"));
    if (raw.values && typeof raw.values === "object") {
      args.values = { ...raw.values, ...args.values };
    }
    return {
      options: {
        base: { ...DEFAULT_OPTIONS.base, ...raw.base },
        deep: { ...DEFAULT_OPTIONS.deep, ...raw.deep },
        odf: { ...DEFAULT_OPTIONS.odf, ...raw.odf },
        pdf: { ...DEFAULT_OPTIONS.pdf, ...raw.pdf },
        rtf: { ...DEFAULT_OPTIONS.rtf, ...raw.rtf }
      },
      clearAll: Boolean(raw.clearAll)
    };
  }
  const profile = PROFILES[args.profile];
  if (!profile) throw new Error(`Unbekanntes Profil "${args.profile}". Verf\xFCgbar: ${Object.keys(PROFILES).join(", ")}`);
  return { options: profile.options, clearAll: Boolean(profile.clearAll) };
}
async function processFile(path, args, options, clearAll) {
  const bytes = new Uint8Array(await readFile(path));
  const file = await loadFile(path.split("/").pop() ?? path, bytes);
  const entry = {
    file: path,
    kind: file.kind,
    sizeBefore: bytes.length,
    sizeAfter: bytes.length,
    sha256Before: file.sha256,
    sha256After: file.sha256,
    findingsBefore: file.findings,
    steps: [],
    remaining: file.findings,
    error: file.error
  };
  if (args.scanOnly || file.error) return entry;
  const values = clearAll ? Object.fromEntries(file.fields.map((field) => [field.key, ""])) : { ...file.values };
  for (const [key, value] of Object.entries(args.values)) values[key] = value;
  const customProps = clearAll ? [] : file.customProps;
  const result = await cleanFile(file, values, customProps, options);
  if (result.error) {
    entry.error = result.error;
    return entry;
  }
  const destination = targetPath(path, args).replace(/\.[^.]+$/, extname(result.fileName));
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, result.bytes);
  entry.file = destination;
  entry.sizeAfter = result.bytes.length;
  entry.sha256After = result.sha256After;
  entry.steps = result.steps;
  entry.remaining = result.remaining;
  return entry;
}
function printEntry(entry, args) {
  if (args.json) return;
  if (entry.error) {
    console.log(`\u2717 ${entry.file}
    ${entry.error}`);
    return;
  }
  if (args.scanOnly) {
    console.log(`\u2022 ${entry.file} (${entry.kind}) \u2014 ${entry.findingsBefore.length} Fund(e)`);
    for (const finding of entry.findingsBefore) console.log(`    [${finding.severity}] ${finding.label}`);
    return;
  }
  console.log(`\u2713 ${entry.file} \u2014 ${entry.steps.length} Schritt(e), ${entry.remaining.length} Rest-Fund(e)`);
  for (const step of entry.steps) console.log(`    ${step}`);
  for (const finding of entry.remaining) console.log(`    offen: [${finding.severity}] ${finding.label}`);
}
async function runOnce(files, args, options, clearAll) {
  const entries = [];
  for (const path of files) {
    try {
      const entry = await processFile(path, args, options, clearAll);
      entries.push(entry);
      printEntry(entry, args);
    } catch (err) {
      const entry = {
        file: path,
        kind: "unbekannt",
        sizeBefore: 0,
        sizeAfter: 0,
        sha256Before: "",
        sha256After: "",
        findingsBefore: [],
        steps: [],
        remaining: [],
        error: err instanceof Error ? err.message : String(err)
      };
      entries.push(entry);
      printEntry(entry, args);
    }
  }
  return entries;
}
async function watchLoop(args, options, clearAll) {
  const seen = /* @__PURE__ */ new Map();
  for (const path of await collectFiles(args.paths, args.recursive)) {
    const info = await stat(path).catch(() => null);
    if (info) seen.set(path, info.mtimeMs);
  }
  console.log(`\xDCberwache ${args.paths.join(", ")} (alle ${args.intervalSeconds}s, Abbruch mit Strg+C)`);
  for (; ; ) {
    await new Promise((done) => setTimeout(done, args.intervalSeconds * 1e3));
    const files = await collectFiles(args.paths, args.recursive);
    const changed = [];
    for (const path of files) {
      if (path.includes("-bereinigt")) continue;
      const info = await stat(path).catch(() => null);
      if (!info) continue;
      if (seen.get(path) === info.mtimeMs) continue;
      seen.set(path, info.mtimeMs);
      changed.push(path);
    }
    if (changed.length > 0) await runOnce(changed, args, options, clearAll);
  }
}
async function main(argv) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 2;
  }
  if (args.help || args.paths.length === 0) {
    console.log(HELP);
    return args.help ? 0 : 2;
  }
  const { options, clearAll } = await loadProfile(args);
  if (args.watch) {
    await watchLoop(args, options, clearAll || args.clearAll);
    return 0;
  }
  const files = await collectFiles(args.paths, args.recursive);
  if (files.length === 0) {
    console.error("Keine unterst\xFCtzten Dateien gefunden.");
    return 2;
  }
  const entries = await runOnce(files, args, options, clearAll || args.clearAll);
  const report = buildReportText(entries, (/* @__PURE__ */ new Date()).toISOString());
  if (args.reportPath) {
    await writeFile(resolve2(args.reportPath), report, "utf8");
    if (!args.json) console.log(`
Protokoll: ${resolve2(args.reportPath)}`);
  }
  if (args.json) console.log(JSON.stringify({ entries }, null, 2));
  const failed = entries.filter((entry) => entry.error).length;
  if (!args.json && failed > 0) console.error(`
${failed} Datei(en) konnten nicht verarbeitet werden.`);
  return failed > 0 ? 1 : 0;
}

// cli/index.ts
main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(2);
  }
);
