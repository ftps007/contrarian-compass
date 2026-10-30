# Metadaten-Editor

Prüft Dateien auf identifizierende Spuren, zeigt sie mit Einstufung an, entfernt sie auf Wunsch und
protokolliert, was passiert ist. Es gibt drei Zugänge auf dieselbe Maschinerie:

| Zugang | Aufruf | Wofür |
| --- | --- | --- |
| Web-Seite | `/metadaten` in der App | Im Browser, mit Stapelverarbeitung |
| Mac-App | `./standalone/build-app.sh` | Echtes Programmfenster, aus Launchpad |
| Kommandozeile | `node cli/metadaten-clean.mjs` | Ordner, Skripte, Überwachung |

Die Verarbeitung läuft immer lokal. In der Web-Seite und der App verlässt keine Datei den Browser.

## Formate

| Format | Eigenschaften bearbeiten | Tiefenreinigung |
| --- | --- | --- |
| .docx/.xlsx/.pptx (+ Makro- und Vorlagenvarianten) | ja | vollständig |
| .odt/.ods/.odp (OpenDocument) | ja | Bilder, Vorschaubild, Benutzerfelder, Namen |
| .pdf | ja | Neuschreiben ohne Altfassungen, XMP, Skripte, Anhänge |
| .doc/.xls/.ppt (altes Binärformat) | ja | nur Eigenschaften — siehe Grenzen |
| .rtf | ja | Erzeuger, Revisionstabelle, Kommentarautoren |
| .jpg/.png/.gif/.webp | — | EXIF, GPS, XMP, IPTC, Kommentare |
| .mp3/.mp4/.m4a/.mov | — | ID3-Tags, udta/meta-Boxen, GPS |

## Was gefunden und entfernt wird

**Dokumenteigenschaften** — Titel, Thema, Autor, zuletzt geändert von, Stichwörter, Kommentare,
Kategorie, Status, Revisionsnummer, Version, Sprache, Erstellt/Geändert/Gedruckt, Firma,
Vorgesetzter, erzeugendes Programm, Vorlage, Bearbeitungszeit, Hyperlink-Basis sowie
benutzerdefinierte Eigenschaften.

**Versteckt in der Datei** (Word, Excel, PowerPoint):

- EXIF-Daten eingebetteter Bilder samt GPS-Position, Kameramodell und Seriennummer
- weggeschnittene Bildbereiche — das Bild wird auf den sichtbaren Ausschnitt neu berechnet
- Pivot-Caches mit den vollständigen Quelldaten
- ausgeblendete Tabellenblätter, Zeilen und Spalten (inklusive Aufräumen der Zeichenkettentabelle,
  die den Text sonst weiter lesbar hält)
- ausgeblendete Folien und Notizenseiten
- `printerSettings.bin` mit Druckername und Treiberkonfiguration
- externe Verknüpfungen und Seriendruckquellen mit lokalen oder Netzwerkpfaden
- Dokument-GUIDs (`w15:docId`), Absatz-IDs und Folien-Kennungen
- eingebettete Arbeitsmappen hinter Diagrammen
- Makros — die Datei wird dabei in ein makrofreies Format überführt (.docm → .docx)
- Personennamen in Kommentaren, Änderungsverfolgung und Personenliste

**Sonstige Spuren** — Word-RSIDs, Vorschaubilder, unterschiedliche ZIP-Zeitstempel.

Jede Entfernung räumt ihre Verweise mit auf, damit Office die Datei nicht als reparaturbedürftig
meldet.

## Vorlagen

Ein Satz Werte für alle geladenen Dateien eines Formats, mit einem Häkchen je Feld: **angehakt heißt
setzen, nicht angehakt heißt löschen**. Die Vorlage startet mit den Werten der ersten geladenen Datei
dieses Formats, sodass man vom Vorhandenen aus arbeitet.

Für Word, Excel und PowerPoint lassen sich zusätzlich die benutzerdefinierten Eigenschaften der
ausgewählten Datei mit übertragen. Sie können in derselben Ansicht angelegt, geändert und gelöscht
werden — auch in Dateien, die bisher gar keine haben.

Auf der Kommandozeile entspricht das `--setzen key=wert` sowie einem Profil, das unter `values` eine
Vorlage mitbringt:

```json
{
  "values": { "title": "Freigegeben", "creator": "Anon" },
  "deep": { "removeSpeakerNotes": true }
}
```

Direkt gesetzte Werte (`--setzen`) haben Vorrang vor der Vorlage im Profil. Ist zusätzlich das
Anonymisieren eingeschaltet, gewinnt dieses: ein selbst gesetzter Name wird ebenfalls durch
„Autor 1" ersetzt.

## Anonymisieren statt Löschen

Der Schalter „Namen durch Autor 1, 2, 3 ersetzen" bildet jeden gefundenen Namen konsistent auf einen
Platzhalter ab — über Dokumenteigenschaften, Kommentare, Änderungsverfolgung und Personenliste
hinweg. Kommentare bleiben damit einander zuordenbar, ohne die Personen zu benennen. Die Zuordnung
steht im Protokoll.

## DSGVO-Bereinigung

Vorweg, weil es darauf ankommt: **Kein Werkzeug kann ein Dokument „100 % DSGVO-konform" machen.**
Konformität ist eine Eigenschaft der Verarbeitung — Rechtsgrundlage, Zweck, Speicherdauer,
Betroffenenrechte, Verträge — und nicht einer Datei. Was ein Werkzeug leisten kann, ist die
technische Maßnahme nach Art. 32: personenbezogene Daten finden, ersetzen und das nachweisbar
protokollieren. Genau das tut diese Funktion, und ihr Protokoll sagt ausdrücklich, was danach noch
in der Verantwortung des Verantwortlichen liegt.

**Was gefunden wird** — in den Dokumenteigenschaften und im Text:

| Kategorie | Erkennung |
| --- | --- |
| Personennamen | Namen aus den Eigenschaften (Autor, Bearbeiter, Vorgesetzter), aus Kommentaren und Änderungsverfolgung, nach Anrede oder Titel („Frau Dr. …", „Herrn …"), unter Grußformeln sowie eine eigene Namensliste |
| E-Mail-Adressen | auch in Hyperlink-Zielen (`mailto:`) und Feldfunktionen |
| Telefonnummern | internationale und nationale Schreibweisen mit mindestens sieben Ziffern |
| Postanschriften | Straße mit Hausnummer, Postleitzahl und Ort |
| Geburtsdaten | Datumsangaben neben „geb.", „Geburtsdatum", „date of birth" |
| IBAN, Kartennummern | nur mit gültiger Prüfsumme (ISO 7064 bzw. Luhn) — Rechnungsnummern bleiben in Ruhe |
| Steuer-ID, Sozialversicherungsnummer | deutsche Formate mit gültiger Prüfziffer |
| IP-Adressen | IPv4 und IPv6 |

**Wie ersetzt wird.** Jede Fundstelle bekommt einen nummerierten Platzhalter — `[Person 1]`,
`[E-Mail 2]`, `[IBAN 1]` — und dieselbe Angabe immer denselben, über Eigenschaften, Text,
Kommentare, Notizen, Alternativtexte und Hyperlinks hinweg. Das ist Pseudonymisierung im Sinne von
Art. 4 Nr. 5: Das Dokument bleibt lesbar und in sich schlüssig, nennt aber niemanden mehr. Wer
stattdessen ersatzlos löschen will, schaltet „Löschen statt Platzhalter" ein.

Die eigentliche Schwierigkeit ist nicht das Erkennen, sondern dass Word eine E-Mail-Adresse
routinemäßig auf mehrere Textläufe verteilt (`max@` + `fir` + `ma.de`). Deshalb wird der Text eines
Absatzes erst zusammengesetzt, dann geprüft, und der Platzhalter über die Laufgrenzen hinweg
zurückgeschrieben — der erste Lauf bekommt den Platzhalter, die anderen verlieren ihren Anteil. Die
Formatierung bleibt erhalten. Das gilt für Word (Text, Kopf- und Fußzeilen, Fuß- und Endnoten,
Kommentare, Textfelder, gelöschter Text in Änderungen), Excel (Zeichenkettentabelle inklusive
Rich-Text, Inline-Zellen, Kommentare), PowerPoint (Folien, Notizen, Kommentare), OpenDocument
(`content.xml`, `styles.xml`, Anmerkungen) und RTF (mit Steuerwörtern, `\'hh`-Escapes und Unicode
zwischen den Buchstaben).

**PDF** wird geprüft, aber nicht verändert: Der Seitentext wird gelesen, soweit die Schriftkodierung
das zulässt, und die Funde stehen im Befund mit dem Vermerk, dass sie im Quelldokument zu bereinigen
sind. Die Eigenschaften werden auch beim PDF pseudonymisiert. Schriften mit CID-Kodierung liefern
keine lesbaren Zeichen; das wird als eigener Fund gemeldet.

**Zuordnungsliste.** Platzhalter → Original wird als eigene Datei ausgegeben
(`zuordnungsliste-vertraulich.txt`, CLI `--zuordnung`), nie im Protokoll. Sie ist der Schlüssel zur
Pseudonymisierung und damit selbst ein personenbezogenes Datum: getrennt aufbewahren, zugriffsschützen,
mit Löschfrist versehen — oder vernichten, wenn keine Rückführung nötig ist.

**Protokoll.** Zusätzlich zu Funden, Schritten, Hashes und Nachkontrolle enthält es je Datei die
Zahl der ersetzten Stellen nach Kategorie und am Ende den Abschnitt „In Ihrer Verantwortung bleibt":
Rechtsgrundlage, Zweckbindung, Vollständigkeit der Erkennung, Pseudonymisierung ≠ Anonymisierung,
Speicherdauer, Betroffenenrechte, Auftragsverarbeitung, Verzeichnis. Die Kopfzeile sagt, dass das
Protokoll eine technische Maßnahme belegt und keine Konformität bescheinigt.

**Grenzen der Erkennung**, ehrlich: Namen ohne Anrede, die weder in den Eigenschaften noch in der
Namensliste stehen, werden nicht gefunden. Namen in Bildern, eingebetteten Objekten und
Diagrammdaten ebenfalls nicht (letztere entfernt das Profil mit dem Diagramm-Schalter). Freie
Beschreibungen („der Kollege aus dem dritten Stock") sind keine Muster. Das Protokoll weist auf die
Handprüfung hin.

## Profile

| Profil | Wirkung |
| --- | --- |
| `standard` | Metadaten bereinigen, Inhalte unangetastet lassen |
| `weitergabe` | Zusätzlich Namen anonymisieren, Notizen, Diagrammdaten und Makros entfernen |
| `dsgvo` | Personenbezogene Daten in Eigenschaften und Text pseudonymisieren, Namen anonymisieren, versteckte Inhalte (Blätter, Zeilen, Folien, Notizen, Pivot-Caches, Diagrammdaten, Anmerkungen) entfernen |
| `streng` | Alles entfernen, was entfernt werden kann, Text pseudonymisieren und alle Felder leeren |

Eigene Profile als JSON-Datei mit `--profil-datei`; die Struktur entspricht `Options` aus
`lib/clean.ts` (`base`, `deep`, `odf`, `pdf`, `rtf`, `pii`, dazu `clearAll`). Unter `pii` stehen
`enabled`, `remove`, ein Schalter je Kategorie und `knownNames` als Liste.

## Kommandozeile

```
npm run build:cli                       # einmalig, erzeugt cli/metadaten-clean.mjs

node cli/metadaten-clean.mjs --hilfe
node cli/metadaten-clean.mjs --nur-bericht --rekursiv ~/Dokumente
node cli/metadaten-clean.mjs --profil weitergabe --ziel ~/Ausgehend ~/Entwürfe
node cli/metadaten-clean.mjs --ueberwachen --intervall 30 ~/Ausgehend
node cli/metadaten-clean.mjs --profil dsgvo --namen "Max Mustermann, Erika Musterfrau" \
    --bericht protokoll.txt --zuordnung zuordnung-vertraulich.txt ~/Akte
```

`--nur-bericht` verändert nichts und listet nur die Funde. `--ueberwachen` beobachtet Ordner und
bereinigt neue oder geänderte Dateien automatisch. `--dsgvo` schaltet die Pseudonymisierung zu
jedem Profil dazu, `--namen` ergänzt die Namensliste (und schaltet sie mit ein), `--zuordnung`
schreibt die vertrauliche Zuordnungsliste. `--json` gibt alles maschinenlesbar aus, der Rückgabewert
ist 1, sobald eine Datei nicht verarbeitet werden konnte.

## Nachweisbarkeit

Jeder Lauf liefert: die Funde vor der Bereinigung mit Einstufung (hoch/mittel/niedrig), die
tatsächlich durchgeführten Schritte, SHA-256 vor und nach der Bearbeitung sowie eine Nachkontrolle —
das Ergebnis wird erneut eingelesen und gescannt, sodass im Protokoll steht, was noch da ist. Das
Protokoll lässt sich als Textdatei herunterladen bzw. mit `--bericht` schreiben.

## Zuverlässigkeit und Geschwindigkeit

Das Werkzeug darf nie eine Datei beschädigen und nie abstürzen. Dafür sorgen drei Schichten:

- **Strenges Lesen.** ZIP-Archive werden mit Prüfsumme gelesen; passwortgeschützte oder fremd
  komprimierte Einträge, abgeschnittene Archive und falsche Längen werden als Fehler gemeldet statt
  als Daten weitergereicht. PDFs, deren benötigte Objekte nicht sauber bis `endobj` lesbar sind oder
  deren Objektströme Filter nutzen, die nicht aufgelöst werden können, werden zum Neuschreiben
  abgelehnt. Bildfilter geben bei widersprüchlichen Längenfeldern das Original zurück, nie ein
  abgeschnittenes Bild.
- **Verifiziertes Schreiben.** Jedes PDF wird nach dem Schreiben erneut eingelesen; stimmen
  Seitenzahl oder Zahl der Inhaltsströme nicht oder liest sich ein Objekt nicht sauber zurück, wird
  die Originaldatei zurückgegeben. Bilder und Mediendateien, von denen nach dem Entfernen nichts
  Gültiges übrig bliebe, werden abgelehnt. Jede Datei durchläuft nach der Bereinigung eine
  Nachkontrolle, deren Ergebnis im Protokoll steht.
- **Zerstörungstests.** Jede Testdatei wird abgeschnitten, mit Bitfehlern versehen, genullt und mit
  Müll ergänzt und muss ohne Ausnahme verarbeitet werden; was ohne Fehler zurückkommt, muss sich
  wieder einlesen lassen (`tests/robustness.test.ts`).

Geschwindigkeit: Unveränderte Teile eines Office-Pakets werden in ihrer vorhandenen komprimierten
Form kopiert statt neu komprimiert, bereits komprimierte Formate (Bilder, Medien) werden ungepackt
abgelegt, und Komprimieren wie Entpacken laufen parallel. Ein Paket mit 150 Folien und 16 MB Bildern
braucht damit rund 0,6 s statt 1,4 s, 47 MB rund 2 s.

## Grenzen

Ehrlich benannt statt stillschweigend übergangen:

- **Nachverfolgte Änderungen** bleiben erhalten. Sie sind Inhalt, kein Metadatum, und müssen in Word
  bzw. LibreOffice angenommen werden. Der Bericht weist darauf hin.
- **Eingebettete Fremddokumente (OLE) und SmartArt-Datenmodelle** werden gemeldet, aber nicht
  automatisch verändert — jeder Eingriff würde die Einbettung bzw. die Grafik zerstören.
- **Alte Binärformate** (.doc/.xls/.ppt): Eigenschaften werden gelesen und geschrieben, aber der
  „Schnellspeichern"-Rest gelöschten Textes lässt sich nicht zuverlässig entfernen. Für heikle
  Dokumente in Office öffnen und als .docx neu speichern.
- **Verschlüsselte PDFs** werden abgelehnt statt beschädigt.
- **Zuschnitte** lassen sich nur im Browser wirklich entfernen (dafür wird eine Canvas gebraucht);
  die Kommandozeile meldet sie als übersprungen. Wird ein Bild mehrfach verwendet, bleibt es
  unangetastet, weil ein Beschneiden die anderen Verwendungen verfälschen würde.
- **Außerhalb der Datei** bleibt alles, woran kein Editor herankommt: Zeitstempel des Dateisystems,
  Versionsverlauf in OneDrive/SharePoint/DMS, bereits versendete Kopien.
- **DSGVO-Konformität** lässt sich nicht bescheinigen, nur die technische Bereinigung belegen —
  siehe den Abschnitt oben.

Bearbeitete Metadaten sind kein sauberer, sondern ein bearbeiteter Zustand. Rückdatierung fällt in
forensischen Prüfungen regelmäßig auf und ist im rechtlichen Kontext strafbar.

## Aufbau

```
lib/zip.ts              ZIP lesen/schreiben über CompressionStream, ohne Abhängigkeit
lib/ooxmlPackage.ts     Teile, Beziehungen, Inhaltstypen eines OOXML-Pakets
lib/officeMetadata.ts   Dokumenteigenschaften (docProps) und Grundbereinigung
lib/ooxmlDeepClean.ts   Versteckte Inhalte finden und entfernen
lib/imageMeta.ts        EXIF/XMP/IPTC lesen und entfernen
lib/imageCrop.ts        Zuschnitte wirklich beschneiden (nur im Browser)
lib/pdf.ts              PDF parsen und neu schreiben
lib/odf.ts              OpenDocument
lib/rtf.ts              RTF
lib/ole2.ts             .doc/.xls/.ppt
lib/mediaMeta.ts        MP3/MP4
lib/pii.ts              Personenbezogene Daten erkennen, prüfen, pseudonymisieren
lib/piiDocument.ts      Textersatz über Laufgrenzen in OOXML, ODF und RTF
lib/clean.ts            Dachmodul: Format erkennen, bereinigen, Bericht
lib/profiles.ts         Profile und Beschriftungen der Schalter
app/metadaten/page.tsx  Web-Oberfläche
standalone/             Einzeldatei-Build und Mac-App
standalone/native/      AppKit-Hülle (WKWebView) für die native Variante
cli/                    Kommandozeile
tests/                  npm test — bündelt die TypeScript-Quellen und prüft sie in Node
```

## Tests

```
npm test              # alle
npm test pdf          # nur Dateien, deren Name "pdf" enthält
npm run typecheck
```

Die Testdateien werden im Code aufgebaut, damit genau bekannt ist, welche Spur wo steckt. Der
PDF-Schreiber wurde zusätzlich gegen echte PDFs aus fremder Erzeugung geprüft, darunter zwei mit
Objektströmen; die Querverweistabelle der Ausgabe wird dabei unabhängig nachgerechnet.
