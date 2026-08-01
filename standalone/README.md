# Metadaten-Editor — Version zum Starten aus dem Finder

`Metadaten-Editor.html` ist eine einzelne, in sich geschlossene Datei: kein Server, keine
Installation, keine Internetverbindung. Doppelklick im Finder genügt — die Datei öffnet sich im
Standardbrowser, und die Office-Datei wird per Drag & Drop hineingezogen.

Die Verarbeitung passiert komplett im Browserfenster. Es wird nichts hochgeladen; die bearbeitete
Datei landet im Download-Ordner.

## Als richtige App im Programme-Verzeichnis

```
./standalone/build-app.sh ~/Applications
```

Erzeugt `Metadaten-Editor.app` — danach über Launchpad, Spotlight oder das Dock startbar. Ohne
Argument landet die App neben der HTML-Datei in `standalone/`.

Das Bundle enthält nur ein Startskript und die HTML-Datei; ein per Drag & Drop auf das App-Icon
gezogenes Dokument wird *nicht* übernommen, das Ziehen muss im geöffneten Fenster passieren.

Weil die App lokal erzeugt wird, hat sie kein Gatekeeper-Quarantäneflag und startet ohne
Sicherheitsnachfrage.

## Neu bauen

```
npm run build:standalone
```

Bündelt `standalone/app.js` samt der gemeinsam genutzten Logik aus `lib/` per esbuild in
`standalone/template.html` und schreibt `standalone/Metadaten-Editor.html`. Die fertige HTML-Datei
ist eingecheckt, der Schritt ist also nur nach Änderungen an `lib/` oder der Oberfläche nötig.

Dieselbe Logik steckt hinter der Seite `/metadaten` der Web-App — geteilt werden `lib/zip.ts` und
`lib/officeMetadata.ts`, doppelt vorhanden ist nur die Oberfläche (React bzw. Vanilla-JS).

## Browser

Gebraucht wird die `CompressionStream`-API: Safari 16.4+, Chrome/Edge 80+, Firefox 113+. Ältere
Browser bekommen einen entsprechenden Hinweis statt einer kaputten Oberfläche. Falls Safari die
fertige Datei in einem Tab anzeigt statt sie zu sichern, die HTML-Datei einmal mit Chrome öffnen
(Rechtsklick → „Öffnen mit").
