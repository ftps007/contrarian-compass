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
    const escapes = { 110: "\n", 114: "\r", 116: "	", 98: "\b", 102: "\f" };
    while (this.pos < this.bytes.length) {
      const c = this.bytes[this.pos++];
      if (c === 92) {
        const next = this.bytes[this.pos++];
        if (next === void 0) break;
        if (escapes[next] !== void 0) {
          out += escapes[next];
        } else if (next >= 48 && next <= 55) {
          let code = next - 48;
          for (let k = 0; k < 2; k++) {
            const digit = this.bytes[this.pos];
            if (digit === void 0 || digit < 48 || digit > 55) break;
            code = code * 8 + (digit - 48);
            this.pos++;
          }
          out += String.fromCharCode(code & 255);
        } else if (next === 13) {
          if (this.bytes[this.pos] === 10) this.pos++;
        } else if (next !== 10) {
          out += String.fromCharCode(next);
        }
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
  const positions = /* @__PURE__ */ new Map();
  const trailer = /* @__PURE__ */ new Map();
  const fromObjectStreams = /* @__PURE__ */ new Set();
  const damaged = /* @__PURE__ */ new Set();
  const unsupported = [];
  const define = (num, value, position) => {
    const current = positions.get(num);
    if (current !== void 0 && current > position) return;
    objects.set(num, value);
    positions.set(num, position);
  };
  const text = latin1.decode(bytes);
  const objectPattern = /(\d+)\s+(\d+)\s+obj\b/g;
  const streamPositions = /* @__PURE__ */ new Map();
  let match;
  while (match = objectPattern.exec(text)) {
    const num = Number(match[1]);
    const lexer = new Lexer(bytes, match.index + match[0].length);
    const value = lexer.parse();
    define(num, value, match.index);
    if (value.t === "stream") streamPositions.set(num, match.index);
    if (!lexer.peekKeyword("endobj")) damaged.add(num);
    objectPattern.lastIndex = Math.max(objectPattern.lastIndex, lexer.pos);
  }
  const trailerPattern = /trailer\b/g;
  while (match = trailerPattern.exec(text)) {
    const lexer = new Lexer(bytes, match.index + 7);
    const value = lexer.parse();
    if (value.t === "dict") for (const [key, entry] of Array.from(value.v.entries())) trailer.set(key, entry);
  }
  const xrefStreams = Array.from(objects.entries()).filter(([, value]) => {
    const dict = dictOf(value);
    const type = dict?.get("Type");
    return type?.t === "name" && type.v === "XRef";
  }).sort(([a], [b]) => (positions.get(a) ?? 0) - (positions.get(b) ?? 0));
  for (const [, value] of xrefStreams) {
    const dict = dictOf(value);
    for (const key of ["Root", "Info", "Encrypt"]) {
      const entry = dict.get(key);
      if (entry) trailer.set(key, entry);
    }
  }
  for (const [num, value] of Array.from(objects.entries())) {
    if (value.t !== "stream") continue;
    const type = value.dict.get("Type");
    if (type?.t !== "name" || type.v !== "ObjStm") continue;
    const filter = value.dict.get("Filter");
    const filterName = filter?.t === "name" ? filter.v : filter?.t === "arr" && filter.v[0]?.t === "name" ? filter.v[0].v : "";
    const params = dictOf(value.dict.get("DecodeParms"));
    const predictor = params?.get("Predictor");
    if (filter?.t === "arr" && filter.v.length > 1) {
      unsupported.push(`Objektstrom ${num} verwendet mehrere Filter.`);
      continue;
    }
    if (filterName !== "" && filterName !== "FlateDecode") {
      unsupported.push(`Objektstrom ${num} verwendet den Filter ${filterName}.`);
      continue;
    }
    if (predictor?.t === "num" && predictor.v > 1) {
      unsupported.push(`Objektstrom ${num} verwendet einen Pr\xE4diktor.`);
      continue;
    }
    const data = filterName === "FlateDecode" ? await inflate(value.data) : value.data;
    if (!data) {
      unsupported.push(`Objektstrom ${num} l\xE4sst sich nicht entpacken.`);
      continue;
    }
    const count = value.dict.get("N");
    const first = value.dict.get("First");
    if (count?.t !== "num" || first?.t !== "num") {
      unsupported.push(`Objektstrom ${num} hat keine g\xFCltige Kopfzeile.`);
      continue;
    }
    const header = new Lexer(data, 0);
    const pairs = [];
    for (let i = 0; i < count.v; i++) {
      const member = Number(header.readToken());
      const offset = Number(header.readToken());
      if (Number.isNaN(member) || Number.isNaN(offset)) break;
      pairs.push({ num: member, offset });
    }
    const position = streamPositions.get(num) ?? 0;
    for (const pair of pairs) {
      if (first.v + pair.offset >= data.length) {
        damaged.add(pair.num);
        continue;
      }
      const lexer = new Lexer(data, first.v + pair.offset);
      define(pair.num, lexer.parse(), position);
      fromObjectStreams.add(pair.num);
    }
  }
  const revisions = (text.match(/%%EOF/g) ?? []).length;
  return { objects, trailer, encrypted: trailer.has("Encrypt"), revisions, fromObjectStreams, damaged, unsupported };
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
  const blocker = rewriteBlocker(doc);
  if (blocker) {
    findings.push({
      id: "unsafe",
      label: "Datei kann nicht sicher neu geschrieben werden",
      detail: `${blocker} Die Metadaten werden angezeigt, eine Bereinigung wird aber abgelehnt, statt eine besch\xE4digte Datei zu liefern.`,
      severity: "hoch"
    });
    return { values, findings, error: blocker };
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
function rewriteBlocker(doc) {
  if (doc.unsupported.length > 0) return doc.unsupported[0];
  const root = doc.trailer.get("Root");
  if (!root) return "Im PDF wurde kein Dokumentkatalog gefunden.";
  if (!dictOf(resolve(doc, root))) return "Der Dokumentkatalog ist unlesbar.";
  const live = reachable(doc, [root]);
  const broken = Array.from(doc.damaged).filter((num) => live.has(num));
  if (broken.length > 0) {
    return `${broken.length} ben\xF6tigte(s) Objekt(e) sind besch\xE4digt (z. B. Nr. ${broken[0]}).`;
  }
  return null;
}
function contentStreamCount(doc) {
  const root = doc.trailer.get("Root");
  if (!root) return 0;
  let count = 0;
  for (const num of Array.from(reachable(doc, [root]))) {
    const value = doc.objects.get(num);
    if (value?.t !== "stream") continue;
    const type = value.dict.get("Type");
    if (type?.t === "name" && (type.v === "ObjStm" || type.v === "XRef")) continue;
    count++;
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
async function pdfStructure(bytes) {
  const doc = await parsePdf(bytes);
  return { pages: countPages(doc), objects: doc.objects.size, revisions: doc.revisions, encrypted: doc.encrypted };
}
async function cleanPdf(bytes, values, options) {
  const doc = await parsePdf(bytes);
  const steps = [];
  if (doc.encrypted) return { bytes, steps, error: "Verschl\xFCsselte PDFs werden nicht ver\xE4ndert." };
  const blocker = rewriteBlocker(doc);
  if (blocker) return { bytes, steps, error: `${blocker} Bereinigung abgelehnt.` };
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
  const streamsBefore = contentStreamCount(doc);
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
  const streamsAfter = contentStreamCount(check);
  if (check.damaged.size > 0 || rewriteBlocker(check)) {
    return {
      bytes,
      steps,
      error: `Sicherheitspr\xFCfung fehlgeschlagen: das Ergebnis liest sich nicht sauber zur\xFCck (${check.damaged.size} besch\xE4digte Objekte). Die Datei wurde nicht ver\xE4ndert.`
    };
  }
  const removesStreams = options.removeEmbeddedFiles || options.removeXmp || options.removeAnnotations || options.removeJavaScript;
  if (streamsAfter < streamsBefore && !removesStreams) {
    return {
      bytes,
      steps,
      error: `Sicherheitspr\xFCfung fehlgeschlagen: ${streamsBefore - streamsAfter} Inhaltsstrom/-str\xF6me fehlen im Ergebnis. Die Datei wurde nicht ver\xE4ndert.`
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
  const encoder3 = new TextEncoder();
  const push = (text) => chunks.push(encoder3.encode(text));
  let offset = 0;
  const offsets = /* @__PURE__ */ new Map();
  const track = (chunk) => {
    chunks.push(chunk);
    offset += chunk.length;
  };
  const write = (text) => track(encoder3.encode(text));
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

// tests/pdfFixtures.ts
var encoder = new TextEncoder();
function assemble(objects, trailerExtra, prefix = "%PDF-1.7\n") {
  let out = prefix;
  const offsets = /* @__PURE__ */ new Map();
  for (const object of objects) {
    offsets.set(object.num, out.length);
    out += `${object.num} 0 obj
${object.body}
endobj
`;
  }
  const size = Math.max(...objects.map((o) => o.num)) + 1;
  const xref = out.length;
  out += `xref
0 ${size}
0000000000 65535 f 
`;
  for (let i = 1; i < size; i++) {
    const at = offsets.get(i);
    out += at === void 0 ? "0000000000 65535 f \n" : `${String(at).padStart(10, "0")} 00000 n 
`;
  }
  out += `trailer
<< /Size ${size} ${trailerExtra} >>
startxref
${xref}
%%EOF
`;
  return out;
}
var CONTENT = "BT /F1 24 Tf 72 700 Td (Sichtbarer Seitentext) Tj ET";
var baseObjects = (infoTitle, infoAuthor) => [
  { num: 1, body: "<< /Type /Catalog /Pages 2 0 R >>" },
  { num: 2, body: "<< /Type /Pages /Kids [3 0 R] /Count 1 >>" },
  { num: 3, body: "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 6 0 R >> >> >>" },
  { num: 4, body: `<< /Length ${CONTENT.length} >>
stream
${CONTENT}
endstream` },
  { num: 5, body: `<< /Title (${infoTitle}) /Author (${infoAuthor}) /Producer (Testprogramm 1.0) /CreationDate (D:20240201100000Z) >>` },
  { num: 6, body: "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>" }
];
function simplePdf() {
  return encoder.encode(assemble(baseObjects("Interner Entwurf", "Max Mustermann"), "/Root 1 0 R /Info 5 0 R"));
}
function incrementalPdf() {
  const first = assemble(
    [
      ...baseObjects("Geheimer Erstentwurf", "Max Mustermann"),
      { num: 7, body: "<< /Length 44 >>\nstream\nBT (Dieser Absatz wurde geloescht) Tj ET\nendstream" }
    ],
    "/Root 1 0 R /Info 5 0 R"
  );
  const updateStart = first.length;
  const newInfo = `5 0 obj
<< /Title (Freigegebene Fassung) /Producer (Testprogramm 1.0) >>
endobj
`;
  const xref = updateStart + newInfo.length;
  const update = newInfo + `xref
0 1
0000000000 65535 f 
5 1
${String(updateStart).padStart(10, "0")} 00000 n 
trailer
<< /Size 8 /Root 1 0 R /Info 5 0 R /Prev 0 >>
startxref
${xref}
%%EOF
`;
  return encoder.encode(first + update);
}
function objectStreamPdf() {
  const packed = [
    { num: 1, body: "<< /Type /Catalog /Pages 2 0 R >>" },
    { num: 2, body: "<< /Type /Pages /Kids [3 0 R] /Count 1 >>" },
    {
      num: 3,
      body: "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>"
    }
  ];
  let payload = "";
  const pairs = [];
  for (const object of packed) {
    pairs.push(`${object.num} ${payload.length}`);
    payload += object.body + " ";
  }
  const header = pairs.join(" ") + "\n";
  const streamData = header + payload;
  return encoder.encode(
    assemble(
      [
        { num: 4, body: `<< /Length ${CONTENT.length} >>
stream
${CONTENT}
endstream` },
        {
          num: 7,
          body: `<< /Type /ObjStm /N ${packed.length} /First ${header.length} /Length ${streamData.length} >>
stream
${streamData}
endstream`
        }
      ],
      "/Root 1 0 R"
    )
  );
}
function pdfWithExtras() {
  return encoder.encode(
    assemble(
      [
        { num: 1, body: '<< /Type /Catalog /Pages 2 0 R /Names << /EmbeddedFiles 8 0 R >> /OpenAction << /S /JavaScript /JS (app.alert\\("hallo"\\)) >> >>' },
        { num: 2, body: "<< /Type /Pages /Kids [3 0 R] /Count 1 >>" },
        { num: 3, body: "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Annots [9 0 R] >>" },
        { num: 4, body: `<< /Length ${CONTENT.length} >>
stream
${CONTENT}
endstream` },
        { num: 5, body: "<< /Title (Mit Anhang) /Author (Max Mustermann) >>" },
        { num: 8, body: "<< /Names [(anhang.txt) 10 0 R] >>" },
        { num: 9, body: "<< /Type /Annot /Subtype /FileAttachment /T (Max Mustermann) /FS 10 0 R >>" },
        { num: 10, body: "<< /Type /Filespec /F (anhang.txt) /EF << /F 11 0 R >> >>" },
        { num: 11, body: "<< /Type /EmbeddedFile /Length 28 >>\nstream\nGeheime Anhangsdaten hier!!!\nendstream" }
      ],
      "/Root 1 0 R /Info 5 0 R"
    )
  );
}
function encryptedPdf() {
  return encoder.encode(
    assemble(
      [
        { num: 1, body: "<< /Type /Catalog /Pages 2 0 R >>" },
        { num: 2, body: "<< /Type /Pages /Kids [] /Count 0 >>" },
        { num: 9, body: "<< /Filter /Standard /V 2 /R 3 /Length 128 >>" }
      ],
      "/Root 1 0 R /Encrypt 9 0 R"
    )
  );
}
function verifyXref(bytes) {
  const text = new TextDecoder("latin1").decode(bytes);
  if (!text.startsWith("%PDF-")) return "kein PDF-Header";
  const startxref = Number(/startxref\s+(\d+)\s*%%EOF\s*$/.exec(text)?.[1] ?? -1);
  if (startxref < 0) return "kein startxref am Dateiende";
  const table = text.slice(startxref);
  if (!table.startsWith("xref")) return "startxref zeigt nicht auf die Tabelle";
  const header = /^xref\s+0\s+(\d+)\s/.exec(table);
  if (!header) return "Tabellenkopf unlesbar";
  const entries = Array.from(table.matchAll(/(\d{10}) (\d{5}) ([nf])/g));
  if (entries.length !== Number(header[1])) return `Tabelle hat ${entries.length} Eintr\xE4ge, Kopf sagt ${header[1]}`;
  for (let i = 1; i < entries.length; i++) {
    if (entries[i][3] !== "n") continue;
    const at = Number(entries[i][1]);
    if (!new RegExp(`^${i} 0 obj`).test(text.slice(at, at + 24))) {
      return `Eintrag ${i} zeigt auf "${text.slice(at, at + 20)}"`;
    }
  }
  return "ok";
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

// tests/pdf.test.ts
var asText = (bytes) => new TextDecoder("latin1").decode(bytes);
await test("PDF: Info-Felder werden gelesen", async () => {
  const info = await readPdf(simplePdf());
  equal(info.error, void 0, "Fehler beim Lesen");
  equal(info.values.Title, "Interner Entwurf", "Titel falsch");
  equal(info.values.Author, "Max Mustermann", "Autor falsch");
  equal(info.values.Producer, "Testprogramm 1.0", "Erzeuger falsch");
  equal(info.values.CreationDate, "2024-02-01T10:00:00Z", "Datum nicht umgewandelt");
});
await test("PDF: Bereinigung schreibt g\xFCltige Struktur und beh\xE4lt den Inhalt", async () => {
  const original = simplePdf();
  const result = await cleanPdf(original, { Title: "Freigabe" }, DEFAULT_PDF_CLEAN);
  equal(result.error, void 0, `Fehler: ${result.error}`);
  equal(verifyXref(result.bytes), "ok", "Querverweistabelle fehlerhaft");
  const before = await pdfStructure(original);
  const after = await pdfStructure(result.bytes);
  equal(after.pages, before.pages, "Seitenzahl ver\xE4ndert");
  equal(after.pages, 1, "Seite verloren");
  const text = asText(result.bytes);
  includes(text, "Sichtbarer Seitentext", "Seiteninhalt verloren");
  excludes(text, "Max Mustermann", "Autor noch enthalten");
  excludes(text, "Testprogramm 1.0", "Erzeuger noch enthalten");
  excludes(text, "Interner Entwurf", "Alter Titel noch enthalten");
  includes(text, "Freigabe", "Neuer Titel fehlt");
});
await test("PDF: alte Fassungen verschwinden vollst\xE4ndig", async () => {
  const original = incrementalPdf();
  const before = asText(original);
  includes(before, "Geheimer Erstentwurf", "Testdatei enth\xE4lt die alte Fassung nicht");
  includes(before, "Dieser Absatz wurde geloescht", "Testdatei enth\xE4lt den gel\xF6schten Absatz nicht");
  const info = await readPdf(original);
  const revisions = info.findings.find((f) => f.id === "revisions");
  assert(revisions, `Mehrfache Fassungen nicht gemeldet: ${info.findings.map((f) => f.id).join(", ")}`);
  equal(info.values.Title, "Freigegebene Fassung", "Es muss die neueste Fassung gelesen werden");
  const result = await cleanPdf(original, info.values, DEFAULT_PDF_CLEAN);
  equal(result.error, void 0, `Fehler: ${result.error}`);
  const text = asText(result.bytes);
  excludes(text, "Geheimer Erstentwurf", "Alter Titel \xFCberlebt");
  excludes(text, "Max Mustermann", "Alter Autor \xFCberlebt");
  excludes(text, "Dieser Absatz wurde geloescht", "Gel\xF6schter Absatz \xFCberlebt");
  includes(text, "Sichtbarer Seitentext", "Aktueller Inhalt verloren");
  includes(text, "Freigegebene Fassung", "Aktueller Titel verloren");
  equal(verifyXref(result.bytes), "ok", "Querverweistabelle fehlerhaft");
  equal((text.match(/%%EOF/g) ?? []).length, 1, "Mehr als eine Fassung geschrieben");
});
await test("PDF: Objektstr\xF6me werden ausgepackt", async () => {
  const original = objectStreamPdf();
  const structure = await pdfStructure(original);
  equal(structure.pages, 1, "Seite im Objektstrom nicht gefunden");
  const result = await cleanPdf(original, { Title: "Ohne Objektstrom" }, DEFAULT_PDF_CLEAN);
  equal(result.error, void 0, `Fehler: ${result.error}`);
  const text = asText(result.bytes);
  excludes(text, "/ObjStm", "Objektstrom wurde erneut geschrieben");
  includes(text, "/Type /Catalog", "Katalog fehlt nach dem Auspacken");
  includes(text, "Sichtbarer Seitentext", "Seiteninhalt verloren");
  equal((await pdfStructure(result.bytes)).pages, 1, "Seitenzahl ver\xE4ndert");
  equal(verifyXref(result.bytes), "ok", "Querverweistabelle fehlerhaft");
});
await test("PDF: Anh\xE4nge und Skripte werden gemeldet und entfernt", async () => {
  const original = pdfWithExtras();
  const info = await readPdf(original);
  const found = info.findings.map((f) => f.id);
  assert(found.includes("embeddedFiles"), `Anhang nicht gemeldet: ${found.join(", ")}`);
  assert(found.includes("javascript"), `Skript nicht gemeldet: ${found.join(", ")}`);
  assert(found.includes("annotations"), `Anmerkung nicht gemeldet: ${found.join(", ")}`);
  const result = await cleanPdf(original, {}, DEFAULT_PDF_CLEAN);
  equal(result.error, void 0, `Fehler: ${result.error}`);
  const text = asText(result.bytes);
  excludes(text, "Geheime Anhangsdaten", "Anhangsinhalt \xFCberlebt");
  excludes(text, "app.alert", "Skript \xFCberlebt");
  excludes(text, "Max Mustermann", "Name in der Anmerkung \xFCberlebt");
  includes(text, "Sichtbarer Seitentext", "Seiteninhalt verloren");
  equal((await pdfStructure(result.bytes)).pages, 1, "Seitenzahl ver\xE4ndert");
});
await test("PDF: verschl\xFCsselte Dateien werden abgelehnt statt besch\xE4digt", async () => {
  const original = encryptedPdf();
  const info = await readPdf(original);
  assert(info.error, "Verschl\xFCsselung nicht erkannt");
  includes(info.findings[0]?.detail ?? "", "Verschl\xFCsselte PDFs", "Hinweis fehlt");
  const result = await cleanPdf(original, {}, DEFAULT_PDF_CLEAN);
  assert(result.error, "Verschl\xFCsselte Datei wurde trotzdem geschrieben");
  equal(result.bytes, original, "Datei wurde trotz Ablehnung ver\xE4ndert");
});
await test("PDF: Nicht-PDF wird sauber abgelehnt", async () => {
  const info = await readPdf(new TextEncoder().encode("Das ist kein PDF"));
  assert(info.error, "Fremdformat nicht erkannt");
});
await test("PDF: ein eingebettetes PDF in einem Stream kapert keine Objekte", async () => {
  const inner = new TextDecoder("latin1").decode(simplePdf());
  const outer = new TextDecoder("latin1").decode(simplePdf());
  const injected = outer.replace(
    "4 0 obj",
    `12 0 obj
<< /Type /EmbeddedFile /Length ${inner.length} >>
stream
${inner}
endstream
endobj
4 0 obj`
  );
  const bytes = new Uint8Array(injected.length);
  for (let i = 0; i < injected.length; i++) bytes[i] = injected.charCodeAt(i) & 255;
  const info = await readPdf(bytes);
  equal(info.error, void 0, `Fehler: ${info.error}`);
  const result = await cleanPdf(bytes, info.values, DEFAULT_PDF_CLEAN);
  equal(result.error, void 0, `Fehler: ${result.error}`);
  const text = asText(result.bytes);
  includes(text, "Sichtbarer Seitentext", "Seiteninhalt des \xE4u\xDFeren PDFs verloren");
  equal((await pdfStructure(result.bytes)).pages, 1, "Seitenzahl ver\xE4ndert");
});
await test("PDF: eine sp\xE4tere direkte Definition schl\xE4gt den Objektstrom", async () => {
  const base = new TextDecoder("latin1").decode(objectStreamPdf());
  const update = `3 0 obj
<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Contents 4 0 R >>
endobj
trailer
<< /Root 1 0 R >>
%%EOF
`;
  const text = base + update;
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i) & 255;
  const result = await cleanPdf(bytes, {}, DEFAULT_PDF_CLEAN);
  equal(result.error, void 0, `Fehler: ${result.error}`);
  includes(asText(result.bytes), "/MediaBox [ 0 300 300 ]".replace("[ 0 300", "[ 0 0 300"), "Die neuere Definition wurde nicht \xFCbernommen");
});
await test("PDF: Escapes in Zeichenketten werden korrekt gelesen", async () => {
  const text = new TextDecoder("latin1").decode(simplePdf()).replace("(Interner Entwurf)", "(Zeile\\nUmbruch \\(Klammer\\) \\101\\102 Ende)");
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i) & 255;
  const info = await readPdf(bytes);
  equal(info.values.Title, "Zeile\nUmbruch (Klammer) AB Ende", "Escapes falsch aufgel\xF6st");
});
await test("PDF: ein besch\xE4digtes, ben\xF6tigtes Objekt f\xFChrt zur Ablehnung statt zu einer kaputten Datei", async () => {
  const text = new TextDecoder("latin1").decode(simplePdf()).replace("/Contents 4 0 R /Resources", "/Contents 4 0 R /Resources <<");
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i) & 255;
  const result = await cleanPdf(bytes, {}, DEFAULT_PDF_CLEAN);
  assert(result.error, "Besch\xE4digtes Objekt wurde nicht erkannt");
  equal(result.bytes, bytes, "Datei wurde trotz Ablehnung ver\xE4ndert");
});
