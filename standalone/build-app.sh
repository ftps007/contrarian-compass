#!/bin/bash
#
# Installs the metadata editor as a macOS app, so it can be started from
# Launchpad, Spotlight or the app switcher instead of from a file in the Finder.
#
#   ./standalone/build-app.sh              -> ~/Applications (shows up in Launchpad)
#   ./standalone/build-app.sh --open       -> install and start it right away
#   ./standalone/build-app.sh /Applications
#
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HTML="$HERE/Metadaten-Editor.html"
ICON="$HERE/icon.icns"

OPEN_AFTER=false
TARGET_DIR=""
for arg in "$@"; do
  case "$arg" in
    --open) OPEN_AFTER=true ;;
    *) TARGET_DIR="$arg" ;;
  esac
done
TARGET_DIR="${TARGET_DIR:-$HOME/Applications}"
APP="$TARGET_DIR/Metadaten-Editor.app"

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
[ -f "$ICON" ] && cp "$ICON" "$APP/Contents/Resources/icon.icns"

cat > "$APP/Contents/Info.plist" <<'PLIST'
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
</dict>
</plist>
PLIST

cat > "$APP/Contents/MacOS/metadaten-editor" <<'LAUNCHER'
#!/bin/bash
# Shows the bundled page. With a Chrome-family browser installed it runs in its
# own window without tabs or address bar, in a browser profile used by nothing
# else. Otherwise it falls back to the default browser.
RESOURCES="$(cd "$(dirname "${BASH_SOURCE[0]}")/../Resources" && pwd)"
PAGE="file://$RESOURCES/Metadaten-Editor.html"
PROFILE="$HOME/Library/Application Support/Metadaten-Editor/browser"

while IFS= read -r BROWSER; do
  if [ -x "$BROWSER" ]; then
    mkdir -p "$PROFILE"
    exec "$BROWSER" \
      --app="$PAGE" \
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

# No Chrome-family browser: hand the page to the default browser. If even that
# fails, say so on screen instead of quitting without a trace.
if ! open "$PAGE"; then
  osascript -e "display alert \"Metadaten-Editor\" message \"Die Seite konnte nicht geöffnet werden: $PAGE\"" >/dev/null 2>&1
  exit 1
fi
LAUNCHER

chmod +x "$APP/Contents/MacOS/metadaten-editor"

# Downloads can carry a quarantine flag, and unsigned bundles are refused on
# Apple silicon — an ad-hoc signature is enough for a locally built app.
xattr -cr "$APP" 2>/dev/null || true
codesign --force --deep --sign - "$APP" >/dev/null 2>&1 || true

# Nudge Launch Services so the app turns up in Launchpad and Spotlight at once.
LSREGISTER="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"
if [ -x "$LSREGISTER" ]; then "$LSREGISTER" -f "$APP" >/dev/null 2>&1 || true; fi
touch "$APP" 2>/dev/null || true

echo "Installiert: $APP"
echo "Zu finden über Launchpad, Spotlight (cmd+Leertaste) oder den Programme-Ordner."

if [ "$OPEN_AFTER" = true ]; then
  open "$APP"
fi
