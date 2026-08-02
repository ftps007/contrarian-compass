#!/bin/bash
#
# One command to install the metadata editor.
#
# Downloads every part fresh into a temporary folder, checks that what arrived
# is really the current version — GitHub's delivery caches files for a few
# minutes, and a half-updated folder is the one failure that looks exactly like
# a broken program — and then runs the installer.
#
#   curl -fsSL <url>/install.sh -o /tmp/mde-install.sh && sudo bash /tmp/mde-install.sh
#
set -euo pipefail

BASE="${BASE:-https://raw.githubusercontent.com/ftps007/contrarian-compass/refs/heads/claude/ms-document-metadata-editor-njx859/standalone}"
TARGET="${1:-/Applications}"
shift || true

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/native"

# A unique query string defeats the cache in front of GitHub; local paths used
# for testing take it unchanged.
stamp="$(date +%s)"
hole() {
  local url="$BASE/$1"
  case "$BASE" in
    http*) url="$url?frisch=$stamp" ;;
  esac
  if ! curl -fsSL "$url" -o "$WORK/$1"; then
    echo "  FEHLT $1 konnte nicht geladen werden." >&2
    exit 1
  fi
}

echo "Lade die aktuellen Dateien…"
hole Metadaten-Editor.html
hole icon.icns
hole build-app.sh
hole native/main.swift

# --- Prüfen, dass es wirklich die aktuelle Fassung ist ---------------------

probleme=0
pruefe() {
  if eval "$2" >/dev/null 2>&1; then
    echo "  ok    $1"
  else
    echo "  FEHLT $1" >&2
    probleme=$((probleme + 1))
  fi
}

pruefe "Oberfläche geladen ($(wc -c < "$WORK/Metadaten-Editor.html" | tr -d ' ') Bytes)" \
  '[ "$(wc -c < "$WORK/Metadaten-Editor.html")" -gt 100000 ]'
pruefe "Oberfläche enthält die Korrektur für das Hineinziehen" \
  'grep -q "Ablage kam keine Datei an" "$WORK/Metadaten-Editor.html"'
pruefe "Symbol geladen" '[ -s "$WORK/icon.icns" ]'
pruefe "Installationsskript geladen" '[ -s "$WORK/build-app.sh" ]'
pruefe "Native Hülle geladen" '[ -s "$WORK/native/main.swift" ]'
pruefe "Native Hülle ist die korrigierte Fassung" \
  '! grep -q "Swift.log" "$WORK/native/main.swift" && grep -q "protokolliere" "$WORK/native/main.swift"'

if [ "$probleme" -gt 0 ]; then
  echo
  echo "Der Download ist unvollständig oder veraltet. In ein paar Minuten noch einmal versuchen." >&2
  exit 1
fi

echo
chmod +x "$WORK/build-app.sh"
bash "$WORK/build-app.sh" "$TARGET" "$@"
