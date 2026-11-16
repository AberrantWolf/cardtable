# Verification

Use Node.js 26 LTS and npm from the repository root:

```sh
npm ci
npm test
npm run lint
```

`npm test` runs the Node regression suite. It uses fake IndexedDB for real
transaction, migration, revision, merge and undo semantics, a controllable browser
adapter for event interleavings, and pure/model/input tests. `npm run lint` rebuilds
both distributions and validates the Firefox build. It currently reports two
existing minimum-version warnings for `data_collection_permissions` (desktop 140 /
Android 142 versus declared 121); neither is a runtime test.

## Chromium smoke test

```sh
npx playwright install chromium
npm run test:browser
```

On Linux, use `npx playwright install --with-deps chromium` when system libraries
are missing. The runner launches an isolated temporary profile, loads the unpacked
MV3 extension and serves only local test pages. It never connects to your ordinary
browser profile. The profile and local server are removed at exit.

Set `CARDTABLE_CHROMIUM` to use another compatible Chromium executable. Branded
Chrome may disable command-line unpacked-extension loading; use Playwright's Chrome
for Testing distribution. `CARDTABLE_SMOKE_SCREENSHOT` sets the success screenshot
path; otherwise screenshots are written to the operating system temporary folder.

Coverage includes validated import, hand overflow/search/keyboard targeting,
editing during updates, concurrent canvases, placement and move undo, named group
restoration, deletion with screenshot restoration, invalid imports, actual new
windows, real tab capture/close/reopen, singleton canvas opening, pointer
cancellation, service-worker restart, reload persistence, no canvas HTTP(S)
resource requests and no page errors.

The completed implementation passed 58 Node regressions, 18 Chromium smoke
checks, and seven Firefox native smoke checks. The latter uses synthetic DOM
pointer/keyboard events inside the actual Firefox extension page; Chromium uses
real browser input automation. Physical touch remains a manual check.

## Browser performance

```sh
npm run test:performance
```

The runner measures 50, 200 and 500-card boards with groups of ten and with solo
groups. Each scenario uses 45 frames with three synthetic pointer moves per frame;
frame statistics omit the first five warmup frames. Input-burst time includes the
three synchronous handlers; frame time also includes scheduled geometry work.
The updated build reports actual geometry-cache rebuild counts.

For a before/after comparison, set `CARDTABLE_BASELINE` to another unpacked
extension directory and `CARDTABLE_PERFORMANCE_OUTPUT` to a JSON output path.
Direct IndexedDB seeding in this benchmark is fixture setup only; normal extension
writes go through background commands.

Observed on November 16, 2026, using macOS ARM64, headless Chrome for Testing
151.0.7922.34, viewport 1440×1000:

| Cards | Grouping | Original frame p95 (ms) | Updated frame p95 (ms) | Original input burst p95 (ms) | Updated input burst p95 (ms) |
|---|---|---:|---:|---:|---:|
| 50 | groups of ten | 10.0 | 9.5 | 1.5 | 1.9 |
| 50 | solo | 8.5 | 9.1 | 3.7 | 1.3 |
| 200 | groups of ten | 8.5 | 9.1 | 2.4 | 2.0 |
| 200 | solo | 13.8 | 9.6 | 12.5 | 1.0 |
| 500 | groups of ten | 8.5 | 8.5 | 4.3 | 1.0 |
| 500 | solo | 27.2 | 9.3 | 25.1 | 1.6 |

All updated scenarios met the 16.7 ms p95 frame target in this run. Small changes
near the refresh interval are noise; these measurements are not a promise for
other machines or browser configurations. The meaningful improvement is the large
solo-group case. The five-minute static-page capture budget is verified with a
controlled clock against the actual content script: at most six requests, rather
than six-second polling.

## Firefox and manual interaction checks

```sh
npx playwright install firefox
npm run test:firefox
```

Set `CARDTABLE_FIREFOX` to use a compatible Firefox test executable. This runner
installs the distribution as a temporary add-on in a disposable profile. Firefox
extension principals cannot currently be attached through Playwright's DOM API;
the test uses Firefox's native debugger protocol through the locked `web-ext`
tooling to verify the actual canvas and event-page runtime.

Firefox 153.0 passed initialization with schema v2, validated import and hand/sticky
rendering, note persistence, pointer movement and undo, screenshot Blob deletion
and restoration, actual tab tracking/close/reopen, and singleton canvas opening.
The Firefox check caught and now protects against its initial `about:blank` tab
creation state overwriting a reopening card's intended URL.

Firefox's native screenshot permission prompt, physical touch input, browser-level
shortcut binding, and a full Firefox process restart remain manual checks. Chromium
automation covers actual screenshots, service-worker restart, and full process
restart with session restoration. The Node suite also covers restart matching and
touch/keyboard state transitions.

Load `extension/dist/firefox/manifest.json` through
`about:debugging#/runtime/this-firefox` in a separate development profile. Grant
site access through the extension's screenshot prompt. Use a disposable board:

1. Open canvas through toolbar and `Alt+Shift+C`; check singleton, pinning and opt-in
   new-tab routing. Repeat capture/open/close/reopen and restart the browser.
2. Edit card and sticky notes while another tab navigates. Open a second canvas and
   edit a note while moving its card in the other. Confirm both edits persist.
3. Drag cards, mixed selections and group outlines with nearby notes. Cancel using
   pointer cancellation or switching tabs. Cancellation rolls the preview back.
4. Undo long drags, dissolution of a named group, mixed deletion and deletion with
   screenshots. Confirm stored notes, groups and images return.
5. Exercise merge and replace, malformed/foreign JSON, ID collisions, same-ID
   exports and failed-save retry. Replace keeps actual browser tabs open, then
   retracks them. Merge keeps existing records on collisions and reports counts.
6. Test 0, 1, 2, 10, 50 and 200 hand cards, narrow/wide windows, fast left/right
   sweeps, scrolling, keyboard navigation, touch and reduced motion. No stationary
   pointer should select a different card solely because visuals animate.
7. Check developer network tools: the canvas must not load remote favicons or other
   HTTP(S) resources. Locally unavailable icons intentionally use a letter placeholder.
8. Export, reload and import. JSON excludes screenshot blobs. Imported cards begin
   closed, except existing browser tabs rebound during reconciliation.

Do not run deletion, import or tracking checks against a normal browsing profile.
