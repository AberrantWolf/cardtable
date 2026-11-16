# cardtable (browser extension)

Your open tabs as **Polaroid cards on a spatial canvas**. The canvas opens as a
single tab from the toolbar button or `Alt+Shift+C`, with an optional setting to route
new tabs there. Cards can carry short notes, and standalone sticky notes can sit with
the groups they describe. Double-click a card to jump to that tab.

It targets **Chromium (MV3)** and **Firefox (MV3)** from one source tree.

## Build & load

For the full development setup, use Node.js 26 LTS and run `npm ci`, `npm test`, then
`npm run lint` from the repository root (see [Development](../README.md#development)).
The build-only command below runs from `extension/`:

```sh
./build.sh        # assembles dist/chromium and dist/firefox (needs Node.js)
```

- **Chromium**: `chrome://extensions` → enable *Developer mode* → *Load unpacked* → `dist/chromium`
- **Firefox**: `about:debugging#/runtime/this-firefox` → *Load Temporary Add-on* → `dist/firefox/manifest.json`

Open the canvas with the toolbar button or `Alt+Shift+C`. Re-run `./build.sh` and reload the
extension after edits. To make every new tab jump to the canvas, enable **Open the canvas on every new tab** in Settings.

> Install prompt asks for access to all sites. That's required to screenshot pages and
> track tabs — all of it runs locally; nothing leaves your machine.

### Hide the tab strip (the "canvas is home" experience)

An extension can't hide Chromium's tab strip. On **Firefox** you can: turn on native
vertical tabs, or add to `userChrome.css`:

```css
#TabsToolbar { visibility: collapse !important; }
```

## How it works

| Concern | Where |
|---|---|
| Tab → card tracking, screenshots, restart reconcile | `src/background.js` |
| Title/favicon, capture pings while visible, scroll save/restore | `src/content.js` |
| Canvas: cards, groups, hand, notes, search, selection, menus, settings, undo | `src/app.js` |
| Group-outline geometry (hull → smooth → chalk) | `src/geometry.js` |
| Shared constants/defaults (all contexts) | `src/shared.js` |
| Shared committed storage and command queue | `src/storage.js`, `src/commands.js` |
| Validation and bounded undo journal | `src/board-format.js`, `src/board-undo.js` |
| Indexed model, gesture lifecycle, Dock-style hand | `src/board-model.js`, `src/interactions.js`, `src/hand*.js` |

**Tab lifecycle.** Open tabs are live; closed tabs are cold. Cards show the last
screenshot taken while the tab was visible. Double-clicking a card activates its tab;
if the tab was closed, it's recreated from its URL.

- **Single click** = select (shift/ctrl-click for multi-select).
- **Double click** = open/activate the tab.
- **Close for good** = the card's ✕, the 🗑 zone, or `Delete` (closes the tab and removes the card — with **Undo**).
- **Sticky notes** = drag from **+ note** / the sticky pile; notes inside or near a group move with it but do not become outlined group members.
- Closing a tab in the browser instead leaves a **cold** card you can reopen.
- The status dot shows **live / cold** (open / closed).

## Settings (⚙ on the canvas)

Theme (slate/paper) & felt color · card width · label font · sticky color / size / font · screenshot quality ·
new-tabs-land-in-hand · hand-card close behavior ·
reduce motion · **Export / Import board** (replace or merge JSON; cards come back as cold until opened).

The hand is a horizontally scrollable strip with stable pointer targets, magnified
hover, and keyboard navigation. See [verification](../docs/testing.md) for automated
checks and the Firefox smoke checklist.

## Keyboard

`/` search · `F` fit · `Delete` close selected · `Ctrl/⌘-Z` undo · `Enter` open selected ·
`Esc` deselect · `Alt+Shift+C` jump to canvas (rebind at `chrome://extensions/shortcuts`).

## Status & known rough edges

In daily personal use. Tagged releases build Chromium ZIPs and submit stable
Firefox versions to AMO; submission does not imply store approval. Known rough edges:

- The "sticky outline on remove" glitch can still surface.
- Live new-group preview only shows for single-card drags, not multi-select drags.

## Roadmap (not in this cut)

Rubber-band (marquee) multi-select ·
arrow-key navigation & fuller a11y · sync across devices · screenshots included in
export.
