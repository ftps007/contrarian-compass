# Metadaten-Editor als Mac-App

## Installieren

```
./standalone/build-app.sh --open
```

Legt `Metadaten-Editor.app` in `~/Applications` an, registriert sie bei Launch Services und startet
sie gleich. Danach ist sie über Launchpad, Spotlight (cmd+Leertaste) und den App-Umschalter
erreichbar wie jedes andere Programm.

Für alle Benutzer des Rechners stattdessen:

```
sudo ./standalone/build-app.sh /Applications
```

Weil die App lokal erzeugt, von der Quarantäne befreit und ad-hoc signiert wird, startet sie ohne
Gatekeeper-Nachfrage. Deinstallieren heißt: App in den Papierkorb ziehen.

## Wie sie läuft

Die App ist ein Bundle um eine einzelne HTML-Datei — kein Server, kein Netz, keine Laufzeit-
Abhängigkeit. Ist Chrome, Edge, Brave oder Chromium installiert, öffnet sie sich in einem eigenen
Fenster ohne Tabs und Adresszeile, in einem separaten Browserprofil unter
`~/Library/Application Support/Metadaten-Editor/`, das sonst nichts benutzt. Ohne einen dieser
Browser fällt sie auf den Standardbrowser zurück und erscheint dort als normaler Tab.

Weil die Anzeige ein Browser übernimmt, kann im Dock der Name bzw. das Symbol des Browsers stehen
statt das der App — das wäre nur mit einer nativen Hülle (Electron & Co.) zu ändern, die aus
170 KB rund 200 MB machen würde.

Ein Dokument, das auf das App-Symbol gezogen wird, nimmt die App bewusst nicht an: ein Browser
lässt sich von außen keine Datei in die Seite reichen. Gezogen wird ins geöffnete Fenster —
einzelne Dateien oder ganze Ordner, die gesamte Fensterfläche ist Ablagezone.

Gebraucht wird die `CompressionStream`-API: Safari 16.4+, Chrome/Edge 80+, Firefox 113+. Ältere
Browser bekommen einen Hinweis statt einer kaputten Oberfläche. Ergebnisse landen im
Download-Ordner; mehrere Dateien kommen als ZIP.

## Ohne Installation

`standalone/Metadaten-Editor.html` funktioniert auch direkt per Doppelklick — dieselbe Datei, die
im Bundle steckt.

## Neu bauen

```
npm run build:standalone            # bündelt lib/ + standalone/app.js -> Metadaten-Editor.html
python3 standalone/make-icon.py     # nur nötig, wenn das Icon geändert wird
./standalone/build-app.sh           # App neu bauen und installieren
```

Die fertige HTML-Datei und das Icon sind eingecheckt, die Schritte sind also nur nach Änderungen
nötig. Web-Seite, App und Kommandozeile teilen sich die gesamte Logik in `lib/`; doppelt vorhanden
ist nur die Oberfläche (React bzw. Vanilla-JS).

Was das Werkzeug findet, entfernt und bewusst nicht anfasst, steht in
[`docs/metadaten-editor.md`](../docs/metadaten-editor.md).
