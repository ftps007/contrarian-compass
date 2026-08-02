# Metadaten-Editor

Prüft Dateien auf identifizierende Spuren, zeigt sie mit Einstufung an, entfernt sie auf Wunsch und
protokolliert, was passiert ist. Es gibt drei Zugänge auf dieselbe Maschinerie:

| Zugang | Aufruf | Wofür |
| --- | --- | --- |
| Web-Seite | `/metadaten` in der App | Im Browser, mit Stapelverarbeitung |
| Mac-App | `./standalone/build-app.sh --open` | Ohne Server, aus Launchpad |
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

## Anonymisieren statt Löschen

Der Schalter „Namen durch Autor 1, 2, 3 ersetzen" bildet jeden gefundenen Namen konsistent auf einen
Platzhalter ab — über Dokumenteigenschaften, Kommentare, Änderungsverfolgung und Personenliste
hinweg. Kommentare bleiben damit einander zuordenbar, ohne die Personen zu benennen. Die Zuordnung
steht im Protokoll.

## Profile

| Profil | Wirkung |
| --- | --- |
| `standard` | Metadaten bereinigen, Inhalte unangetastet lassen |
| `weitergabe` | Zusätzlich Namen anonymisieren, Notizen, Diagrammdaten und Makros entfernen |
| `streng` | Alles entfernen, was entfernt werden kann, und alle Felder leeren |

Eigene Profile als JSON-Datei mit `--profil-datei`; die Struktur entspricht `Options` aus
`lib/clean.ts` (`base`, `deep`, `odf`, `pdf`, `rtf`, dazu `clearAll`).

## Kommandozeile

```
npm run build:cli                       # einmalig, erzeugt cli/metadaten-clean.mjs

node cli/metadaten-clean.mjs --hilfe
node cli/metadaten-clean.mjs --nur-bericht --rekursiv ~/Dokumente
node cli/metadaten-clean.mjs --profil weitergabe --ziel ~/Ausgehend ~/Entwürfe
node cli/metadaten-clean.mjs --ueberwachen --intervall 30 ~/Ausgehend
```

`--nur-bericht` verändert nichts und listet nur die Funde. `--ueberwachen` beobachtet Ordner und
bereinigt neue oder geänderte Dateien automatisch. `--json` gibt alles maschinenlesbar aus, der
Rückgabewert ist 1, sobald eine Datei nicht verarbeitet werden konnte.

## Nachweisbarkeit

Jeder Lauf liefert: die Funde vor der Bereinigung mit Einstufung (hoch/mittel/niedrig), die
tatsächlich durchgeführten Schritte, SHA-256 vor und nach der Bearbeitung sowie eine Nachkontrolle —
das Ergebnis wird erneut eingelesen und gescannt, sodass im Protokoll steht, was noch da ist. Das
Protokoll lässt sich als Textdatei herunterladen bzw. mit `--bericht` schreiben.

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
lib/clean.ts            Dachmodul: Format erkennen, bereinigen, Bericht
lib/profiles.ts         Profile und Beschriftungen der Schalter
app/metadaten/page.tsx  Web-Oberfläche
standalone/             Einzeldatei-Build und Mac-App
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
