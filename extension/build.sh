#!/usr/bin/env bash
# Assemble loadable, unpacked extensions for each browser.
# Shared manifest fields + version live once in manifest.base.json; per-browser
# differences live in manifest.<target>.json and are merged in by build-manifest.mjs.
# Requires Node.js (only for the manifest merge).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
src="$here/src"

command -v node >/dev/null 2>&1 || { echo "error: Node.js is required (it merges the manifest)"; exit 1; }

for t in chromium firefox; do
  out="$here/dist/$t"
  rm -rf "$out"
  mkdir -p "$out"
  cp -r "$src/." "$out/"
  node "$here/build-manifest.mjs" "$t" "$out/manifest.json"
  echo "built  $out"
done

cat <<'EOF'

Load it:
  Chromium  → chrome://extensions → enable Developer mode → "Load unpacked" → dist/chromium
  Firefox   → about:debugging#/runtime/this-firefox → "Load Temporary Add-on" → dist/firefox/manifest.json

Open a normal new tab to see the canvas (it overrides the new-tab page).
EOF
