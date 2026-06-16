# 🃏 cardtable

A spatial canvas for your browser tabs. Each tab becomes a **Polaroid card** — a
screenshot of the last time it was open — on a pannable, zoomable 2D table. Group cards
into **hand-drawn chalk blobs**, annotate them, rename the groups, and let the tabs you
aren't using **sleep** to save memory. New tabs arrive as **cards in your hand** along
the bottom; drop them onto the table into a group, on their own, or into the bin.

It replaces your new-tab page, so the canvas *is* home.

> 💭 I was sad to learn about the dead **Kosmik** browser, so I put this together to see
> if it could help me keep my head together when juggling multiple git hosts and
> ticketing systems for work. Initial impressions are positive.

## ✨ Highlights

- 🖼️ **Tabs as cards** — every tab is a screenshot card you can arrange spatially.
- 😴 **Sleeping tabs** — only a few tabs stay live; the rest are discarded to ~no memory
  but keep their scroll, form, and session state.
- ✏️ **Chalk groups** — drop cards near each other to form hand-drawn outlines; rename
  them, and drag an outline to move the whole group.
- 🗒️ **Notes** — annotate any card on its bottom strip.
- 🔐 **SSO deep-link guard** — when a re-login bounces you around, it lands you back on
  the page you actually wanted.
- 💾 **Local only** — everything lives in your browser; nothing leaves your machine.

## 🚀 Install

The extension targets **Chromium (MV3)** and **Firefox (MV3)** from one source tree.

**Packaged builds** are attached to each [release](https://github.com/AberrantWolf/cardtable/releases):
the Firefox `.xpi` is Mozilla-signed (open it in Firefox to install); for Chrome, unzip the
build and load it via *Developer mode → Load unpacked*. To build from source instead:

```sh
cd extension && ./build.sh   # assembles dist/chromium and dist/firefox (needs Node.js)
```

- **Chromium** — `chrome://extensions` → enable *Developer mode* → *Load unpacked* → `dist/chromium`
- **Firefox** — `about:debugging#/runtime/this-firefox` → *Load Temporary Add-on* → `dist/firefox/manifest.json`

Then open a normal **new tab** — that's the canvas. Re-run `./build.sh` and reload the
extension after edits. See [`extension/README.md`](extension/README.md) for build
internals, debugging, and how to hide the tab strip.

## 🎮 Using it

- 🖐️ **Drag the felt** to pan, **scroll wheel** to zoom, **F** to fit everything.
- 🃏 **Click or drag a card** → it raises to the top of the stack (persisted).
- 🤝 **Drag a card** around and the group outline updates live. Joining is generous (no
  overlap needed — you can leave space between cards); leaving is sticky (you must drag
  well clear), so cards don't fall out of a group by accident. Drop next to a loose card
  to start a new group, or in open space to stand alone.
- ✏️ **Drag a group's outline** to move the whole group together.
- 👇 **Drag a card down into the hand** to pull it back for placing elsewhere.
- 🆕 **Drag a hand card** (the bottom fan) onto the table to place it, or onto **🗑** to discard.
- 🗒️ **Click a card's bottom strip** to type a note. **Click a group name** to rename it.
- 👆 **Double-click a card** to jump to that tab — it wakes, or is recreated if it was closed.

The status dot on each card shows **live / sleeping / cold**.

## ⌨️ Keyboard

| Key | Action |
|---|---|
| `/` | Search tabs |
| `F` | Fit all |
| `Enter` | Open selected |
| `Delete` | Close selected (with **Undo**) |
| `Ctrl/⌘-Z` | Undo |
| `Esc` | Deselect / close menu |
| `Alt+Shift+C` | Jump to the canvas (rebindable) |

## ⚙️ Settings (⚙ on the canvas)

Theme (slate / paper) & felt color · card width · label font & size · screenshot quality
· *keep N tabs awake* · new-tabs-land-in-hand · group-around-lone-cards · SSO deep-link
guard + auth-host list · reduce motion · **Export / Import board** (JSON).

Grouping feel is tuned by `ADD_PAD` / `REMOVE_PAD` (the join/leave hysteresis) and
`NEW_GROUP_DIST` near the top of `extension/src/app.js`. State (cards, groups, notes,
view, screenshots) persists locally in IndexedDB.

## 🔒 Privacy

The install prompt asks for access to all sites — required to screenshot pages and track
tabs. **All of it runs locally; nothing is sent anywhere** — no servers, no analytics, no
data collection of any kind. See the full [Privacy Policy](PRIVACY.md) for exactly what's
stored locally on your device.

## 🗺️ Status & roadmap

This is the first pass of something I've been using daily and find genuinely useful —
not yet formally released. Ideas for later (mostly as I want them myself): tiering /
cold-archive for hundreds of tabs · freeform sticky notes · rubber-band (marquee)
multi-select · arrow-key navigation & fuller a11y · sync across devices · screenshots
included in export.

Suggestions welcome. 🙌

## 📄 License

[MIT](LICENSE) © Scott Harper
