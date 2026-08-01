#!/bin/bash
#
# Wraps the standalone HTML in a macOS .app bundle so the editor can be started
# from the Finder, Launchpad or Spotlight like any other program.
#
#   ./standalone/build-app.sh              -> standalone/Metadaten-Editor.app
#   ./standalone/build-app.sh ~/Applications
#
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HTML="$HERE/Metadaten-Editor.html"
TARGET_DIR="${1:-$HERE}"
APP="$TARGET_DIR/Metadaten-Editor.app"

if [ ! -f "$HTML" ]; then
  echo "Die HTML-Datei fehlt. Erst bauen:  npm run build:standalone" >&2
  exit 1
fi

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$HTML" "$APP/Contents/Resources/Metadaten-Editor.html"

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
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
PLIST

cat > "$APP/Contents/MacOS/metadaten-editor" <<'LAUNCHER'
#!/bin/bash
# Opens the bundled page in the default browser. A file dragged onto the app
# icon is passed along as an argument — we only use it to show the folder,
# since the browser has to receive the file through the page itself.
RESOURCES="$(cd "$(dirname "${BASH_SOURCE[0]}")/../Resources" && pwd)"
open "$RESOURCES/Metadaten-Editor.html"
LAUNCHER

chmod +x "$APP/Contents/MacOS/metadaten-editor"

echo "Fertig: $APP"
echo "Zum Installieren ins Programme-Verzeichnis ziehen — oder gleich:"
echo "  ./standalone/build-app.sh ~/Applications"
