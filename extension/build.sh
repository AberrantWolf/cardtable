#!/usr/bin/env bash
# Assemble loadable, unpacked extensions for each browser. No dependencies.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
src="$here/src"

for t in chromium firefox; do
  out="$here/dist/$t"
  rm -rf "$out"
  mkdir -p "$out"
  cp -r "$src/." "$out/"
  cp "$here/manifest.$t.json" "$out/manifest.json"
  echo "built  $out"
done

cat <<'EOF'

Load it:
  Chromium  → chrome://extensions → enable Developer mode → "Load unpacked" → dist/chromium
  Firefox   → about:debugging#/runtime/this-firefox → "Load Temporary Add-on" → dist/firefox/manifest.json

Open a normal new tab to see the canvas (it overrides the new-tab page).
EOF
