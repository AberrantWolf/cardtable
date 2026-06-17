# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

cardtable shows your browser tabs as Polaroid-style cards on a pannable/zoomable 2D
canvas. The canvas is a single tab you summon with the toolbar button or `Alt+Shift+C`
(focus-or-create, so it stays a singleton); pinned by default (`pinCanvasTab` toggles
it). It no longer overrides the new-tab page by default, though a `newTabOpensCanvas`
setting can opt back into that.
Cards can be grouped (drawn as hand-drawn chalk blobs), annotated, and let sleep. There is **no package.json, no npm, no test suite, and
no linter** — it's vanilla JS run directly by the browser; the only build step is a small
Node script that merges the per-browser manifest.

## Layout

`extension/` is the whole project — an MV3 browser extension. `extension/src/` holds the
source; `extension/build.sh` assembles loadable copies into `extension/dist/`
(gitignored). There is no separate app or build target.

(Historical note: this began as a standalone `web/` prototype with fake seeded data and
`localStorage`. That tree has been removed — the extension is the only codebase now.)

## Build & run the extension

```sh
cd extension && ./build.sh   # merges the manifest + copies src/ into dist/{chromium,firefox}
```

`build.sh` copies `src/` into each target, then generates `manifest.json` by merging
`manifest.base.json` with the per-target overlay via `build-manifest.mjs` (needs Node).
`extension/dist/` is gitignored.

Releases are cut by `.github/workflows/release.yml` on a `v*` tag: it stamps the version
from the tag (`CARDTABLE_VERSION` overrides the base manifest), zips the Chromium build,
signs the Firefox `.xpi` via AMO (`web-ext sign`; needs `AMO_API_KEY` / `AMO_API_SECRET`
repo secrets), and attaches both to a GitHub Release. Tags must be store-legal numeric
versions — Chrome allows only 1–4 dot-separated integers, no `-rc`/letters. Use `0.x` tags
(e.g. `v0.9.0`) for pre-1.0 release candidates — they sort below `v1.0.0` and are
auto-marked as GitHub pre-releases.

- **Chromium**: `chrome://extensions` → Developer mode → Load unpacked → `dist/chromium`
- **Firefox**: `about:debugging#/runtime/this-firefox` → Load Temporary Add-on → `dist/firefox/manifest.json`

After any edit to `extension/src/`, **re-run `./build.sh` and reload the extension**.
Debug the service worker via its console in `chrome://extensions`; debug the canvas via
the page console on a new tab.

## Extension architecture

Five source files, each in a distinct execution context. The `X = globalThis.browser ||
globalThis.chrome` idiom abstracts the WebExtension API across Firefox/Chromium.

| File | Context | Responsibility |
|---|---|---|
| `shared.js` | all (bg, content, page) | Single global `CT`: DB names, `MSG.*` message types, `DEFAULTS`, pure host/url helpers. Classic script; **no DOM or API calls at load time.** |
| `background.js` | service worker (Chromium) / event page (Firefox) | Tab lifecycle, screenshots, sleep policy, SSO deep-link guard, restart reconciliation, the `onMessage` command API. |
| `content.js` | every http(s) page | Reports title/favicon/url, pings for a capture while visible, saves scroll, restores scroll once after a cold reopen. |
| `app.js` | the canvas page (`newtab.html`) | All UI: card/group/hand rendering, dragging, grouping math, selection, notes, undo, settings, import/export. |
| `db.js` | page only | Page-side IndexedDB accessor (`DBP` default export). |
| `geometry.js` | page only | Pure group-outline math (convex hull → Chaikin smoothing → chalk strokes). |

### IndexedDB ownership is split (important)

One database (`CT.DB`), but writers are partitioned to avoid conflicts:

- **`background.js` owns `tabs` and `shots`** (tab records + screenshots).
- **`app.js` owns `layout`, `groups`, `notes`** (positions, group defs, annotations).

The schema/`onupgradeneeded` is **duplicated** in `background.js` (`idbOpen`) and `db.js`
(`open`) — if you change stores or `CT.DBV`, update **both**. A `layout` row keyed by
`cardId` is what makes a tab a placed card; absence means it lives in the hand (or is
auto-placed when `handOnNewTab` is off).

### Cross-context messaging

All via `X.runtime.sendMessage` with a `CT.MSG.*` type. Page/content → background for
commands and queries; background broadcasts `CHANGED` (re-read everything) and `SHOT`
(one screenshot updated) back to the page, which reacts in `app.js`'s `onMessage` →
`scheduleReload`/`loadShot`. Adding a message type means touching `shared.js`, the
`background.js` switch, and the page listener.

### Tab lifecycle: the sleeping model

A card's `state` is **live / sleeping / cold**. Only `maxLiveTabs` (default 1) tabs stay
live; the rest are `tabs.discard`ed (sleeping — session/scroll/form state survives, ~no
memory). A tab closed in the browser becomes a `cold` card reopenable from its URL.
`applySleepPolicy()` in `background.js` has a marked **TIERING HOOK** where, to scale past
dozens of tabs, the oldest could be fully closed (`tabs.remove`, cold) instead of merely
discarded. Because tab IDs change across browser restarts, `reconcile()` re-matches open
tabs to existing cards by normalized URL on startup/install.

### SSO deep-link guard

When a card is opened, `armGuard` records the intended URL. If navigation bounces through
an auth host (`CT.isAuthHost`, configurable list in Settings) and lands elsewhere on the
same origin, the background redirects back to the intended page once authenticated. Logic
lives in the `webNavigation` listeners in `background.js`.

## Grouping logic (in `app.js`)

Grouping uses hysteresis tuned by constants at the top of `app.js`:
`ADD_PAD` (generous join — center entering an inflated hull, no overlap needed),
`REMOVE_PAD` (sticky leave — must clear a larger hull), and `NEW_GROUP_DIST` (two loose
cards this close form a new group on drop). `liveGroup()` decides membership during a
drag; `finalizeGroup()` commits on drop. `soloGroups` mode draws a 1-member outline
around every lone card.

## Cross-cutting rules

- **One base manifest, two overlays.** Shared manifest fields **and `version`** live once
  in `manifest.base.json`; `build-manifest.mjs` merges it with a per-target overlay at
  build time. Only browser-specific keys go in the overlays — `manifest.chromium.json`
  (service-worker background) and `manifest.firefox.json` (scripts background + `gecko`
  block). So permission/command/content-script changes are made **once**, in the base. The
  Chromium service worker pulls in `shared.js` via `importScripts`; Firefox lists it before
  `background.js` in its background `scripts` — so `shared.js` must remain a side-effect-free
  classic script.
- **Settings** live in `X.storage.local` under `settings`, merged over `CT.DEFAULTS`.
  Both `app.js` and `background.js` keep a live copy synced via `storage.onChanged`.
