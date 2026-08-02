# Metadaten-Editor als Mac-App

## Installieren — ein Befehl

```
curl -fsSL https://raw.githubusercontent.com/ftps007/contrarian-compass/refs/heads/claude/ms-document-metadata-editor-njx859/standalone/install.sh -o /tmp/mde-install.sh && sudo bash /tmp/mde-install.sh
```

`install.sh` lädt alle Teile frisch in einen temporären Ordner, prüft anhand von Merkmalen im
Inhalt, dass wirklich die aktuelle Fassung angekommen ist — GitHubs Auslieferung cacht Dateien
einige Minuten, und ein halb aktualisierter Ordner sieht aus wie ein kaputtes Programm — und startet
dann die Installation.

## Installieren aus einer Arbeitskopie

```
./standalone/build-app.sh
```

Entsteht dabei ein echtes Programm — eigenes Fenster, eigenes Dock-Symbol, eigene Menüleiste, cmd+Q
—, sofern `swiftc` vorhanden ist. Das gehört zu den Xcode-Befehlszeilenwerkzeugen; fehlt es, sagt
das Skript das und installiert die Browser-Variante. Nachrüsten mit:

```
xcode-select --install
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

## Startprobe

Das Installationsskript prüft zum Schluss das fertige Paket — Startprogramm ausführbar, Seite und
Symbol vorhanden, Info.plist gültig, Signatur in Ordnung, keine Quarantäne — und startet die App
anschließend über Launch Services. Das ist genau der Weg, den ein Klick auf das Symbol in der
Apps-Übersicht nimmt. Meldet sich die App dabei nicht, endet das Skript mit einem Fehler, statt eine
Installation zu melden, die beim Klicken nicht funktioniert.

Jeder Start schreibt eine Zeile nach `~/Library/Logs/Metadaten-Editor.log`. Falls die App später
einmal nicht aufgeht, steht dort, ob sie überhaupt gestartet ist und woran es lag:

```
tail -5 ~/Library/Logs/Metadaten-Editor.log
```

Mit `--ohne-start` lässt sich die Probe überspringen.

## Die drei Startarten

| Aufruf | Ergebnis |
| --- | --- |
| ohne Zusatz | Native App, falls `swiftc` da ist — sonst Standardbrowser |
| `--browser` | Immer der Standardbrowser |
| `--fenster` | Chrome/Edge/Brave im App-Modus mit eigenem Browserprofil |

**Nativ** ist die Empfehlung: `standalone/native/main.swift` ist eine schlanke AppKit-Hülle um eine
WKWebView, rund 200 Zeilen, ohne Fremdcode. Sie wird beim Installieren auf dem eigenen Rechner
übersetzt, ist also ein normales Programm mit Fenster, Dock-Symbol, Menüleiste und cmd+Q. Zwei
Dinge kann eine WebView nicht allein, deshalb macht die Hülle sie: den Dateiauswahl-Dialog öffnen
und die fertigen Dateien über einen echten Sichern-Dialog schreiben. Die Oberfläche erkennt die
Hülle und beschriftet ihre Knöpfe entsprechend („sichern" statt „herunterladen").

**Browser** ist der verlässliche Rückfall: die Seite wird dem Standardbrowser übergeben, die
Ergebnisse landen im Download-Ordner. Im Dock erscheint dann der Browser.

**Fenster** startet Chrome im App-Modus mit einem separaten Profil unter
`~/Library/Application Support/Metadaten-Editor/`. Dieser Weg hängt vom Browser ab: manche
Chrome-Fassungen öffnen lokale Dateien im App-Modus nicht und zeigen ein leeres Fenster.

In der Dateiliste entfernt das ✕ einzelne Einträge; „Liste leeren" wirft alles weg.

Ein Dokument, das auf das App-Symbol gezogen wird, nimmt die App nicht an. Gezogen wird ins
geöffnete Fenster — einzelne Dateien oder ganze Ordner, die gesamte Fensterfläche ist Ablagezone.
Alternativ auf das Feld klicken und im Dialog auswählen.

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
