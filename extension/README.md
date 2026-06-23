# cardtable (browser extension)

Your open tabs as **Polaroid cards on a spatial canvas**. The canvas opens as a
single tab from the toolbar button or `Alt+Shift+C`, with an optional setting to route
new tabs there. Tabs you don't have open in front of you **sleep** (discarded) to stay
cheap, but keep their scroll/form/session state. Double-click a card to jump to that
tab; the **SSO deep-link guard** sends you back to the exact page after a re-login.

It targets **Chromium (MV3)** and **Firefox (MV3)** from one source tree.

## Build & load

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
| Tab → card tracking, screenshots, sleep policy, deep-link guard, restart reconcile | `src/background.js` |
| Title/favicon, capture pings while visible, scroll save/restore | `src/content.js` |
| Canvas: cards, groups, hand, notes, search, selection, menus, settings, undo | `src/app.js` |
| Group-outline geometry (hull → smooth → chalk) | `src/geometry.js` |
| Shared constants/defaults (all contexts) | `src/shared.js` |
| Storage schema (IndexedDB) | `src/db.js` + background |

**Tab lifecycle (sleeping model).** The active tab is live; everything else is
*discarded* — still in the browser session (so scroll, form fields, and `sessionStorage`
survive), but using ~no memory. Cards show the last screenshot taken while the tab was
visible. Double-clicking a card wakes its tab; if the tab was fully closed, it's
recreated from its URL.

- **Single click** = select (shift/ctrl-click for multi-select).
- **Double click** = open/activate the tab.
- **Close for good** = the card's ✕, the 🗑 zone, or `Delete` (closes the tab and removes the card — with **Undo**).
- Closing a tab in the browser instead leaves a **cold** card you can reopen.
- The status dot shows **live / sleeping / cold**.

**SSO deep-link guard.** When you open a card, the background remembers its intended
URL. If the navigation bounces through an auth host (configurable in Settings) and lands
somewhere other than that URL on the same site, it sends you back to the page you wanted
once you're authenticated.

**Scale knob (no corner).** The sleep policy is one setting, *“keep N tabs awake”*
(`maxLiveTabs`, default 1). The code has a marked **tiering hook** in
`applySleepPolicy()` where, to scale past dozens of tabs, the oldest tabs can be fully
closed (cold) instead of merely discarded — a config/policy change, not a rewrite.

## Settings (⚙ on the canvas)

Theme (slate/paper) & felt color · card width · label font · screenshot quality ·
keep-N-tabs-awake · new-tabs-land-in-hand · deep-link guard on/off · auth-host list ·
reduce motion · **Export / Import board** (replace or merge JSON; cards come back as cold until opened).

## Keyboard

`/` search · `F` fit · `Delete` close selected · `Ctrl/⌘-Z` undo · `Enter` open selected ·
`Esc` deselect · `Alt+Shift+C` jump to canvas (rebind at `chrome://extensions/shortcuts`).

## Status & known rough edges

In daily personal use, but not yet formally released or store-reviewed. Known rough edges:

- The "sticky outline on remove" glitch can still surface.
- Live new-group preview only shows for single-card drags, not multi-select drags.
- Aggressive sleeping (default keep-1) means lots of tabs in Chromium's strip; pair with
  Firefox + hidden strip for the intended feel.

## Roadmap (not in this cut)

Tiering / cold-archive for hundreds of tabs · freeform sticky notes · rubber-band
(marquee) multi-select · arrow-key navigation & fuller a11y · sync across devices ·
screenshots included in export.
