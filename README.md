# 🃏 cardtable

A spatial canvas for your browser tabs. Each tab becomes a **Polaroid card** — a
screenshot of the last time it was open — on a pannable, zoomable 2D table. Group cards
into **hand-drawn chalk blobs**, annotate them, and rename the groups.
New tabs arrive as **cards in your hand** along the bottom; drop them onto the table into a group, on their own, or into the bin.

Open the canvas from the toolbar button or `Alt+Shift+C`; a setting can also route every new tab there if you want the canvas-as-home workflow.

> 💭 I was sad to learn about the dead **Kosmik** browser, so I put this together to see
> if it could help me keep my head together when juggling multiple git hosts and
> ticketing systems for work. Initial impressions are positive.

## ✨ Highlights

- 🖼️ **Tabs as cards** — every tab is a screenshot card you can arrange spatially.
- ✏️ **Chalk groups** — drop cards near each other to form hand-drawn outlines; rename
  them, and drag an outline to move the whole group.
- 🗒️ **Notes & stickies** — annotate any card, or drop standalone sticky notes onto the table.
- 💾 **Local only** — everything lives in your browser; nothing leaves your machine.

## 🚀 Install

The extension targets **Chromium (MV3)** and **Firefox (MV3)** from one source tree.

Chromium build ZIPs are attached to each [release](https://github.com/AberrantWolf/cardtable/releases),
and production Firefox builds are submitted directly to Firefox Add-ons. For local development,
unzip the Chromium build and use *Developer mode → Load unpacked*, or build from source:

```sh
cd extension && ./build.sh   # assembles dist/chromium and dist/firefox (needs Node.js)
```

- **Chromium** — `chrome://extensions` → enable *Developer mode* → *Load unpacked* → `dist/chromium`
- **Firefox** — `about:debugging#/runtime/this-firefox` → *Load Temporary Add-on* → `dist/firefox/manifest.json`

Open the canvas with the toolbar button or `Alt+Shift+C`. Re-run `./build.sh` and reload the
extension after edits. See [`extension/README.md`](extension/README.md) for build
internals, debugging, and how to opt into routing every new tab to the canvas.

## Development

Use **Node.js 26 LTS** and npm. With [nvm](https://github.com/nvm-sh/nvm), run
`nvm install` and `nvm use` from the repository root; `.nvmrc` selects the same
Node major used in CI. Other Node installers work too, provided `node` and `npm`
are on your shell's PATH (including the shell Codex uses).

```sh
npm ci
npm test
npm run lint
```

`npm ci` installs the locked development tools. `npm run lint` rebuilds both browser
targets and runs Mozilla's extension validator on the Firefox output. Use
`npm run build` for just the build. Generated files under `extension/dist/` are
ignored; edit the source and rebuild before reloading the extension.

`npm test` runs the storage, identity, concurrency and interaction regressions.
For a real Chromium extension smoke test, run `npx playwright install chromium`
then `npm run test:browser`; it uses a disposable profile. Firefox checks use
`npx playwright install firefox` and `npm run test:firefox`. See
[verification and performance checks](docs/testing.md) for coverage and the Firefox
manual checklist. [AGENTS.md](AGENTS.md) describes architecture and review rules.

The validator currently reports two compatibility warnings: the Firefox minimum
version is 121, while the `data_collection_permissions` manifest key was introduced
in desktop Firefox 140 and Android Firefox 142. Keep the declaration for AMO;
changing supported browser versions is a separate compatibility decision.

## 🎮 Using it

- 🖐️ **Drag the felt** to pan, **scroll wheel** to zoom, **F** to fit everything.
- 🃏 **Click or drag a card** → it raises to the top of the stack (persisted).
- 🤝 **Drag a card** around and the group outline updates live. Joining is generous (no
  overlap needed — you can leave space between cards); leaving is sticky (you must drag
  well clear), so cards don't fall out of a group by accident. Drop next to a loose card
  to start a new group, or in open space to stand alone.
- ✏️ **Drag a group's outline** to move the whole group together; nearby stickies come along without being included in the chalk outline.
- 🃏 **The hand** scrolls horizontally; hover enlarges the aimed-at card and moves neighbors aside. Arrow keys navigate and Enter opens a focused hand card. Search includes the hand.
- 👇 **Drag a card down into the hand** to pull it back for placing elsewhere.
- 🆕 **Drag a hand card** (the bottom strip) onto the table to place it, or onto **🗑** to discard.
- 🗒️ **Click a card's bottom strip** to type a note. **Click a group name** to rename it. Drag from **+ note** / the sticky pile to add standalone notes.
- 👆 **Double-click a card** to jump to that tab — it activates, or is recreated if it was closed.

The status dot on each card shows **live / cold** (open / closed).

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

Theme (slate / paper) & felt color · card width · label font & size · sticky color / size / font · screenshot quality
· new-tabs-land-in-hand · hand-card close behavior · group-around-lone-cards · reduce motion · **Export / Import board** (replace or merge JSON).

Grouping feel is tuned by `ADD_PAD` / `REMOVE_PAD` (the join/leave hysteresis) and
`NEW_GROUP_DIST` near the top of `extension/src/app.js`. State (cards, groups, notes,
view, screenshots) persists locally in IndexedDB. Site icons render only from local image bytes; unavailable icons use a letter placeholder.

## 🔒 Privacy

The install prompt asks for access to all sites — required to screenshot pages and track
tabs. **All of it runs locally; nothing is sent anywhere** — no servers, no analytics, no
data collection of any kind. See the full [Privacy Policy](PRIVACY.md) for exactly what's
stored locally on your device.

## 🗺️ Status & roadmap

This is the first pass of something I've been using daily and find genuinely useful —
with an automated release workflow. Ideas for later (mostly as I want them myself):
rubber-band (marquee) multi-select · arrow-key
navigation & fuller a11y · sync across devices · screenshots included in export.

Suggestions welcome. 🙌

## 📄 License

[MIT](LICENSE) © Scott Harper
