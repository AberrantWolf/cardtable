# Repository guidance

cardtable is a local-only Manifest V3 extension for Chromium and Firefox. It shows
tabs as cards on a spatial canvas. Keep the browser runtime vanilla JavaScript,
HTML, and CSS; there is no app framework or browser-side bundler.

## Setup and verification

Run commands from the repository root. Use Node.js 26 LTS (see `.nvmrc`) and npm.

```sh
npm ci         # reproducible install from package-lock.json
npm test       # Node regression suite
npm run build  # generates extension/dist/{chromium,firefox}
npm run lint   # rebuilds both targets, then runs Mozilla web-ext lint on Firefox
```

- Edit `extension/src/` and the source manifests, never generated `extension/dist/`.
- Run `npm run lint` after source, manifest, dependency, or build changes. For docs
  alone, check referenced commands and paths and run `git diff --check`.
- `npm run test:browser` runs Chromium smoke checks in a disposable profile after
  `npx playwright install chromium`. `npm run test:firefox` uses a temporary Firefox
  add-on after `npx playwright install firefox`. See `docs/testing.md`. Lint is not a browser smoke test.
  For behavior changes, rebuild and reload the extension in both browsers when
  available; report any checks you could not run.
- Load `extension/dist/chromium` through `chrome://extensions` (Developer mode),
  or `extension/dist/firefox/manifest.json` through
  `about:debugging#/runtime/this-firefox` (Load Temporary Add-on).
- Use a separate browser development profile: tab tracking, deletion,
  and replace-mode imports affect real tabs and stored boards.
- For UI/tab changes, smoke-test toolbar/`Alt+Shift+C` singleton canvas opening,
  card capture/open/close/reopen, grouping and notes, and persistence after reload.
  For import/export changes, test merge and replace with a disposable board.
- Before handing off, run `git diff --check`, review the diff, and state what
  changed, what was verified, and any remaining limitations.

## Code map

| File | Execution context and responsibility |
|---|---|
| `extension/src/shared.js` | Classic script in all contexts: global `CT`, message types, defaults, pure URL/host helpers. No DOM or browser API calls at load time. |
| `extension/src/background.js` | Chromium service worker / Firefox event page: tab lifecycle, screenshots, reconciliation, command handlers. |
| `extension/src/content.js` | HTTP(S) pages: title/favicon/URL updates, capture pings, scroll save/restore. |
| `extension/src/app.js` | Canvas page UI, layout, grouping, selection, notes, undo, settings, import/export. |
| `extension/src/db.js` | Page reads; sends writes to the background command owner. |
| `extension/src/storage.js`, `commands.js` | Shared IndexedDB schema/transactions and serialized background mutations. |
| `extension/src/board-format.js`, `board-undo.js` | Validated atomic imports and durable bounded undo. |
| `extension/src/board-model.js`, `interactions.js`, `hand*.js` | Indexed model/drafts, gesture cancellation, stable Dock targeting. |
| `extension/src/geometry.js` | Pure group-outline geometry. |
| `extension/src/newtab.html`, `newtab.css` | Canvas markup and styling. |
| `extension/build.sh`, `build-manifest.mjs` | Copy source and merge per-browser manifests. |

Use `globalThis.browser || globalThis.chrome` for browser APIs. Keep classic
scripts compatible with their existing loading contexts; page modules use ES imports.

## Storage and message contracts

- `CT.DB` is shared. The background owns all durable board writes. Page code uses
  `DBP.mutate` or board commands; preserve that ordering for import and undo too.
- `storage.js` defines the schema for all contexts. Change it and `CT.DBV` together
  when upgrading, and test existing-record/blob preservation. Version 2 adds `meta`.
- Commands publish revisioned change sets only after commit. `boardEpoch` protects
  against stale writes and retries across replacement imports.
- A `layout` row keyed by `cardId` makes a card placed. Without it, the card lives
  in the hand (or is auto-placed with `handOnNewTab` disabled).
- Messages use `CT.MSG` constants in `shared.js`. Add command handlers in the
  background and update relevant senders/receivers. Only broadcasts require a
  page listener: `CHANGED` applies a revisioned delta; gaps/reset recover from a snapshot.
- Settings live under `settings` in `X.storage.local`, merged over `CT.DEFAULTS`.
  Both app and background synchronize via `storage.onChanged`.

## Behavior to preserve

- The canvas is focus-or-create from the toolbar or `Alt+Shift+C`, pinned by
  default (`pinCanvasTab`). New-tab interception is opt-in (`newTabOpensCanvas`).
- Card states are `live` (open tab) and `cold` (closed tab).
  Browser tab IDs are transient; startup `reconcile()`
  uses current-session bindings first, then exact canonical URLs including fragments.
- Group hysteresis uses `ADD_PAD`, `REMOVE_PAD`, and `NEW_GROUP_DIST` in `app.js`.
  `liveGroup()` previews membership; `finalizeGroup()` commits it. Standalone sticky
  notes can move with groups without becoming outlined members.
- Keep tab data, screenshots, notes, and settings local. Preserve bundled font
  licenses and the extension's existing content-security restrictions.

## Manifests and releases

- Shared fields, permissions, commands, content scripts, and version belong in
  `extension/manifest.base.json`. Overlays contain browser-specific keys only.
- Chromium imports classic dependencies with `importScripts`; Firefox lists
  `shared.js`, storage/command/format/undo/capture scripts, then `background.js`.
  Preserve that dependency order.
- `.github/workflows/release.yml` builds numeric `v*` tags, stamps
  `CARDTABLE_VERSION`, uploads a Chromium ZIP, and submits stable Firefox releases
  to AMO. AMO signing credentials are release-only; local development needs none.
- Versions must be 1–4 dot-separated integers. The workflow treats `0.x` and
  four-component versions as prereleases and skips AMO submission for them.
  See the workflow before changing release behavior.

## Code Review Rules

- Flag mismatched IndexedDB schemas, migration data loss, or tab/card identity
  mistakes across close/reopen/restart.
- Flag browser-specific APIs or script-loading changes that break either target.
- Flag screenshot races that attach another active tab's image to a card.
- Flag unintended network transmission of locally stored browsing data.
