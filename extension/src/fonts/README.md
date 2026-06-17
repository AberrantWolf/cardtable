# Bundled fonts

These are packaged with the extension so the default title and group label fonts render
identically on every OS. They're referenced via `@font-face` in `../newtab.css` and surfaced
in the Settings font pickers under the **Bundled** category (which always renders, unlike
OS-installed fonts).

Each file is the **latin** subset only (the web-font subset Google Fonts serves to modern
browsers), so the footprint is small.

| File | Family | Used for | Source | License |
|---|---|---|---|---|
| `caveat.woff2` | Caveat | card titles (default) | https://fonts.google.com/specimen/Caveat | SIL OFL 1.1 — `Caveat-OFL.txt` |
| `permanent-marker.woff2` | Permanent Marker | group labels (default) | https://fonts.google.com/specimen/Permanent+Marker | Apache 2.0 — `PermanentMarker-LICENSE.txt` |

Both licenses permit redistribution and embedding. The license text accompanies each font as
required.

To refresh (e.g. a newer version), re-download the latin-subset `woff2` from the Google Fonts
CSS endpoint with a modern browser User-Agent, e.g.:

```sh
UA="Mozilla/5.0 (X11; Linux x86_64; rv:121.0) Gecko/20100101 Firefox/121.0"
curl -s -A "$UA" "https://fonts.googleapis.com/css2?family=Caveat:wght@600" \
  | grep -o 'https://[^)]*woff2' | tail -1   # last block is the latin subset
```
