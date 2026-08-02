#!/bin/bash
#
# Installs the metadata editor as a macOS app.
#
# Preferred result is a real application: a compiled native shell with its own
# window, Dock icon and menu bar. That needs swiftc, which comes with the Xcode
# command line tools. Without it the script falls back to handing the page to
# the browser — same functionality, less of an app.
#
#   ./standalone/build-app.sh                -> nativ, sonst Browser (in ~/Applications)
#   sudo ./standalone/build-app.sh /Applications
#   ./standalone/build-app.sh --browser      -> Standardbrowser erzwingen
#   ./standalone/build-app.sh --fenster      -> Chrome im App-Modus erzwingen
#   ./standalone/build-app.sh --ohne-start   -> ohne Startprobe installieren
#
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HTML="$HERE/Metadaten-Editor.html"
ICON="$HERE/icon.icns"
SWIFT_SOURCE="$HERE/native/main.swift"

MODE=auto        # auto | nativ | fenster | browser
SELFTEST=true
TARGET_DIR=""
for arg in "$@"; do
  case "$arg" in
    --nativ|--native) MODE=nativ ;;
    --fenster|--window) MODE=fenster ;;
    --browser) MODE=browser ;;
    --ohne-start) SELFTEST=false ;;
    --open) ;;                    # the self-test starts the app anyway
    *) TARGET_DIR="$arg" ;;
  esac
done
TARGET_DIR="${TARGET_DIR:-$HOME/Applications}"
APP="$TARGET_DIR/Metadaten-Editor.app"

# Under sudo the app must still be started as the logged-in user: a GUI app has
# no business running as root, and its log belongs in that user's home.
TARGET_USER="${SUDO_USER:-$(id -un)}"
if [ "$(id -u)" = "0" ] && [ -n "${SUDO_USER:-}" ]; then
  RUN_AS_USER=(sudo -u "$TARGET_USER")
  USER_HOME="$(eval echo "~$TARGET_USER" 2>/dev/null || true)"
else
  RUN_AS_USER=()
  USER_HOME="$HOME"
fi
if [ ! -d "$USER_HOME" ]; then USER_HOME="$HOME"; fi

if [ ! -f "$HTML" ]; then
  echo "Die HTML-Datei fehlt. Erst bauen:  npm run build:standalone" >&2
  exit 1
fi

mkdir -p "$TARGET_DIR"
if [ ! -w "$TARGET_DIR" ]; then
  echo "Keine Schreibrechte für $TARGET_DIR — noch einmal mit sudo aufrufen." >&2
  exit 1
fi

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$HTML" "$APP/Contents/Resources/Metadaten-Editor.html"
if [ -f "$ICON" ]; then cp "$ICON" "$APP/Contents/Resources/icon.icns"; fi

# ---------------------------------------------------------------------------
# The executable — a compiled shell if we can, a launch script otherwise
# ---------------------------------------------------------------------------

EXECUTABLE="$APP/Contents/MacOS/metadaten-editor"
NATIVE=false

if [ "$MODE" = auto ] || [ "$MODE" = nativ ]; then
  if [ ! -f "$SWIFT_SOURCE" ]; then
    echo "Hinweis: native/main.swift fehlt — es wird die Browser-Variante gebaut."
  elif ! command -v swiftc >/dev/null 2>&1; then
    echo "Hinweis: swiftc nicht gefunden, daher keine native App."
    echo "         Einmalig nachinstallieren mit:  xcode-select --install"
    if [ "$MODE" = nativ ]; then exit 1; fi
  else
    echo "Baue die native App (das dauert einen Moment)…"
    BUILD_LOG="$(mktemp)"
    if swiftc -O "$SWIFT_SOURCE" -o "$EXECUTABLE" >"$BUILD_LOG" 2>&1; then
      NATIVE=true
      echo "  ok    übersetzt"
    else
      echo "  FEHLT Übersetzung fehlgeschlagen:" >&2
      sed 's/^/        /' "$BUILD_LOG" >&2
      if [ "$MODE" = nativ ]; then rm -f "$BUILD_LOG"; exit 1; fi
      echo "        Es wird stattdessen die Browser-Variante gebaut." >&2
    fi
    rm -f "$BUILD_LOG"
  fi
fi

if [ "$NATIVE" = false ] && [ "$MODE" = fenster ]; then
  cat > "$EXECUTABLE" <<'LAUNCHER'
#!/bin/bash
# Own window without tabs or address bar, in a browser profile used by nothing
# else. Needs a Chrome-family browser; falls back to the default browser.
SELF="${BASH_SOURCE[0]:-$0}"
RESOURCES="$(cd "$(dirname "$SELF")/../Resources" && pwd)"
PAGE="$RESOURCES/Metadaten-Editor.html"
PROFILE="$HOME/Library/Application Support/Metadaten-Editor/browser"
LOG="$HOME/Library/Logs/Metadaten-Editor.log"

mkdir -p "$(dirname "$LOG")" 2>/dev/null
note() { echo "$(/bin/date '+%Y-%m-%d %H:%M:%S') $*" >> "$LOG" 2>/dev/null; }

note "Start im Fenstermodus (Seite: $PAGE)"

while IFS= read -r BROWSER; do
  if [ -x "$BROWSER" ]; then
    mkdir -p "$PROFILE"
    note "OK: starte $BROWSER im App-Modus"
    exec "$BROWSER" \
      --app="file://$PAGE" \
      --user-data-dir="$PROFILE" \
      --window-size=1180,900 \
      --no-first-run \
      --no-default-browser-check
  fi
done <<'BROWSERS'
/Applications/Google Chrome.app/Contents/MacOS/Google Chrome
/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge
/Applications/Brave Browser.app/Contents/MacOS/Brave Browser
/Applications/Chromium.app/Contents/MacOS/Chromium
BROWSERS

note "Kein Chrome-Browser gefunden, weiter mit dem Standardbrowser"
/usr/bin/open "$PAGE"
LAUNCHER
elif [ "$NATIVE" = false ]; then
  cat > "$EXECUTABLE" <<'LAUNCHER'
#!/bin/bash
# Hands the bundled page to the default browser. This is the dependable route:
# every browser opens a local file this way.
#
# Launched from Launchpad the environment is bare — no user PATH, no working
# directory — so everything here uses absolute paths and resolves its own
# location from $0. Every run leaves a line in the log, which is what the
# installer's self-test reads.
SELF="${BASH_SOURCE[0]:-$0}"
RESOURCES="$(cd "$(dirname "$SELF")/../Resources" && pwd)"
PAGE="$RESOURCES/Metadaten-Editor.html"
LOG="$HOME/Library/Logs/Metadaten-Editor.log"

mkdir -p "$(dirname "$LOG")" 2>/dev/null
note() { echo "$(/bin/date '+%Y-%m-%d %H:%M:%S') $*" >> "$LOG" 2>/dev/null; }
alert() { /usr/bin/osascript -e "display alert \"Metadaten-Editor\" message \"$1\"" >/dev/null 2>&1; }

note "Start (Seite: $PAGE)"

if [ ! -f "$PAGE" ]; then
  note "FEHLER: Seite fehlt im Programmpaket"
  alert "Die Seite fehlt im Programmpaket. Bitte build-app.sh erneut ausführen."
  exit 1
fi

if /usr/bin/open "$PAGE"; then
  note "OK: an den Standardbrowser übergeben"
  exit 0
fi

note "FEHLER: open hat die Seite abgelehnt"
alert "Die Seite konnte nicht geöffnet werden: $PAGE"
exit 1
LAUNCHER
fi

chmod +x "$EXECUTABLE"

# ---------------------------------------------------------------------------
# Bundle metadata
# ---------------------------------------------------------------------------

{
  cat <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Metadaten-Editor</string>
  <key>CFBundleDisplayName</key><string>Metadaten-Editor</string>
  <key>CFBundleIdentifier</key><string>local.metadaten-editor</string>
  <key>CFBundleVersion</key><string>1.0</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleExecutable</key><string>metadaten-editor</string>
  <key>CFBundleIconFile</key><string>icon</string>
  <key>NSHighResolutionCapable</key><true/>
PLIST
  if [ "$NATIVE" = true ]; then
    # A compiled AppKit application has to name its principal class.
    echo '  <key>NSPrincipalClass</key><string>NSApplication</string>'
    echo '  <key>LSMinimumSystemVersion</key><string>11.0</string>'
  fi
  echo '</dict>'
  echo '</plist>'
} > "$APP/Contents/Info.plist"

# Downloads can carry a quarantine flag, and unsigned bundles are refused on
# Apple silicon — an ad-hoc signature is enough for a locally built app.
xattr -cr "$APP" 2>/dev/null || true
codesign --force --deep --sign - "$APP" >/dev/null 2>&1 || true

# Nudge Launch Services so the app turns up in Launchpad and Spotlight at once.
LSREGISTER="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"
if [ -x "$LSREGISTER" ]; then "$LSREGISTER" -f "$APP" >/dev/null 2>&1 || true; fi
touch "$APP" 2>/dev/null || true

# ---------------------------------------------------------------------------
# Checks
# ---------------------------------------------------------------------------

problems=0
check() {
  if eval "$2" >/dev/null 2>&1; then
    echo "  ok    $1"
  else
    echo "  FEHLT $1"
    problems=$((problems + 1))
  fi
}

echo "Installiert: $APP"
echo "Prüfe das Programmpaket:"
check "Startprogramm ist ausführbar" '[ -x "$APP/Contents/MacOS/metadaten-editor" ]'
check "Seite liegt im Paket"        '[ -s "$APP/Contents/Resources/Metadaten-Editor.html" ]'
check "Symbol liegt im Paket"       '[ -s "$APP/Contents/Resources/icon.icns" ]'
if command -v plutil >/dev/null 2>&1; then
  check "Info.plist ist gültig" 'plutil -lint "$APP/Contents/Info.plist"'
  check "Name im Info.plist"    '[ "$(plutil -extract CFBundleExecutable raw "$APP/Contents/Info.plist")" = "metadaten-editor" ]'
fi
if [ "$NATIVE" = true ] && command -v file >/dev/null 2>&1; then
  check "Startprogramm ist übersetzt" 'file "$APP/Contents/MacOS/metadaten-editor" | grep -q Mach-O'
fi
if command -v codesign >/dev/null 2>&1; then
  check "Signatur ist gültig" 'codesign --verify --deep "$APP"'
fi
check "keine Quarantäne" '! xattr -p com.apple.quarantine "$APP" 2>/dev/null'

if [ "$problems" -gt 0 ]; then
  echo
  echo "$problems Punkt(e) stimmen nicht — die App würde beim Klick nicht starten." >&2
  exit 1
fi

# --- Startprobe über Launch Services, also genau wie ein Klick in „Apps" ----

LOG="$USER_HOME/Library/Logs/Metadaten-Editor.log"
if [ "$SELFTEST" = true ] && command -v open >/dev/null 2>&1; then
  echo
  echo "Startprobe (genau der Weg, den ein Klick im Apps-Ordner nimmt):"
  BEFORE=0
  [ -f "$LOG" ] && BEFORE=$(wc -l < "$LOG" | tr -d ' ')
  if "${RUN_AS_USER[@]}" open "$APP" 2>/dev/null; then
    for _ in 1 2 3 4 5 6 7 8 9 10; do
      sleep 0.5
      AFTER=0
      [ -f "$LOG" ] && AFTER=$(wc -l < "$LOG" | tr -d ' ')
      [ "$AFTER" -gt "$BEFORE" ] && break
    done
    if [ "${AFTER:-0}" -gt "$BEFORE" ]; then
      echo "  ok    App wurde gestartet und hat sich gemeldet:"
      tail -n 2 "$LOG" | sed 's/^/        /'
    else
      echo "  FEHLT App hat sich nicht gemeldet — Protokoll: $LOG" >&2
      exit 1
    fi
  else
    echo "  FEHLT Launch Services konnte die App nicht starten." >&2
    exit 1
  fi
fi

echo
echo "Zu finden über Launchpad, Spotlight (cmd+Leertaste) oder den Programme-Ordner."
if [ "$NATIVE" = true ]; then
  echo "Startmodus: eigenes Programmfenster mit eigenem Dock-Symbol."
elif [ "$MODE" = fenster ]; then
  echo "Startmodus: eigenes Fenster über einen Chrome-Browser."
else
  echo "Startmodus: Standardbrowser."
fi
echo "Protokoll jedes Starts: $LOG"
