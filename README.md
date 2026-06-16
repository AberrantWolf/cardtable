# cardtable

A spatial canvas for browser tabs: each tab is a **Polaroid card** (screenshot of the
last time it was open) on a 2D table you pan and zoom. New tabs arrive as a **fan of
cards in your hand** along the bottom — drop them onto the table into a group or on
their own, or discard them. Groups are drawn as **hand-drawn chalk blobs**. You can
annotate cards and name groups.

This replaces the dead **Kosmik** workflow, and it deliberately does *not* embed live
pages — a screenshot is enough, which is what lets it be a plain browser extension
instead of a from-scratch browser. (See `../cef-sso-spike` for the abandoned
live-embedding path and why it's not needed.)

## Status

This is **increment 1: the visual prototype** — the look and the core interactions,
running as a dependency-free static web page with *mock* tabs. No build step, no npm.
The browser-extension plumbing (real tab list, `captureVisibleTab` screenshots,
persistent storage, click-to-focus-the-real-tab) is increment 2.

## Run it

No package manager needed. From this directory:

```sh
cd web
python3 -m http.server 8099
```

Then open <http://localhost:8099/>. (Open via a server, not `file://` — ES modules
need HTTP.)

### Try

- **Drag the felt** to pan, **scroll wheel** to zoom.
- **Click or drag a card** → it raises to the top of the stack (persisted).
- **Drag a card** around; the group outline updates live as you drag it in or out.
  Joining is generous (no overlap needed — you can leave space between cards); leaving
  is sticky (you must drag well clear), so cards don't fall out of a group by accident.
  Drop next to a loose card to start a new group, or in open space to stand alone.
- **Drag a card down into the hand** to pull it back for placing elsewhere.
- **Drag the ⠿ grip** by a group's name to move the whole group together.
- **Drag a hand card** (bottom fan) onto the table to place it, or onto **🗑** to discard.
- **Double-click a card's bottom strip** to type a note. **Click a group name** to rename.
- **+ open tab** simulates a new tab landing in your hand. **fit** frames everything.
  **reset** clears saved state and reseeds.

Grouping feel is tuned by `ADD_PAD` / `REMOVE_PAD` (the join/leave hysteresis) and
`NEW_GROUP_DIST` at the top of `app.js`.

State (positions, groups, notes, view) persists in `localStorage`.

## How the pieces map to your spec

| Your ask | Where it lives |
|---|---|
| Cards = Polaroids, white frame + wide bottom label strip | `.card` in `style.css` |
| Screenshot of last-open | `.shot` (mock gradient now; real `captureVisibleTab` later) |
| New tabs fan into a "hand" (MTG-style) | `#hand`, `renderHand()` / `startHandDrag()` in `app.js` |
| Discard from hand | drop on `#trash` |
| Groups = blobby chalk circles, smooth > tight fit | `geometry.js` (convex hull → Chaikin → jittered strokes + SVG `#chalk` turbulence filter) |
| "Close for good" = delete the card | the `✕` on a card / drop on 🗑 → `discard()` |
| User can modify the look | CSS custom properties at the top of `style.css` |

## Customization surface

Edit the `:root` variables in `style.css`: `--card-w`, `--label-h`, `--label-font`,
`--card-paper`, `--table-bg`, `--chalk`, `--shot-ratio`. The chalk wobble is the
`#chalk` filter in `index.html`; group padding/roundness is `groupOutline(rects, pad)`
and the Chaikin iteration count in `geometry.js`.

## Next (increment 2 — the extension)

- MV3 (Chromium) + WebExtension (Firefox) manifests.
- Background worker: track tabs, `captureVisibleTab` on focus/load (debounced ~2/s),
  store thumbnails in IndexedDB keyed by URL.
- Replace mock `SITES`/`localStorage` with messages to the background worker.
- Click a card → focus the real tab, or reopen its URL if closed.
- Canvas as the new-tab page; on Firefox, hide the tab strip (native vertical tabs or
  `userChrome.css`: `#TabsToolbar { visibility: collapse; }`).
