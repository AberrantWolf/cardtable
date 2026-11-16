# Privacy Policy

**Last updated: June 16, 2026**

cardtable is a browser extension that shows your open tabs as cards on a spatial canvas.
This policy explains, plainly and completely, how it handles data.

## 🟢 The short version

**cardtable collects nothing.** It has no servers, no analytics, no telemetry, no
accounts, and no third-party services. No data is ever transmitted off your device —
there is nowhere for it to go. Everything the extension creates stays in your own
browser's local storage, on your own computer, under your control.

## 🚫 What we collect: nothing

cardtable does not collect, transmit, sell, share, or receive any personal or
non-personal data. There is no network communication of your information of any kind.
The developer has no access to anything you do with the extension.

## 💾 What is stored locally on your device

To do its job, cardtable saves data **locally, inside your browser** (using the browser's
IndexedDB and extension storage). This data never leaves your machine. For full
transparency, it includes:

- **Tab information** — the URL, title, and favicon of tabs you have open or have placed
  on the canvas.
- **Site icons** — only locally available raster image bytes are displayed. The canvas
  never requests remote favicon URLs; unavailable icons use a letter placeholder.
- **Page screenshots** — a low-resolution image of a page, captured while that page is
  visible, used as the card's thumbnail. These can show whatever was on screen, including
  content from pages you are logged in to.
- **Your arrangement** — card positions, groups, group names, and any notes you write on
  cards.
- **Settings** — your preferences (theme, card size, fonts, and so on).
- **Undo history** — recent affected records and screenshot bytes are retained locally
  to undo deletion and movement. The journal is bounded to 50 actions and 32 MiB;
  newer actions evict old entries, and replacing a board clears the journal.
- **Transient session state** — a one-time scroll position kept only in
  `storage.session`, which the browser holds in
  memory and erases when you close it. This never includes authentication tokens or
  login URLs.

You can export this data to a JSON file and re-import it yourself. That file is created
locally and is shared only if you choose to share it.

## 🔑 Permissions and why they are needed

| Permission | Why it is requested |
|---|---|
| `tabs` | To see your open tabs and represent them as cards, and to activate, open, or close tabs on your behalf. |
| Access to all websites (`<all_urls>`) | To capture the screenshot thumbnail of a page and read its title, favicon, and scroll position. A card can be any site, so this cannot be narrowed in advance. All of it runs locally. |
| `storage`, `unlimitedStorage` | To save everything listed above in your browser's local storage. |

cardtable does not inject ads, modify the pages you visit, or read page content beyond
what is described above.

## 🗑️ Retention and deletion

Your data stays on your device until you remove it. You are always in control:

- **Uninstalling** the extension removes its stored data.
- Closing the browser clears the transient session state.
- You can clear the extension's stored data through your browser's settings at any time.

## 👶 Children

cardtable is a general-purpose productivity tool and is not directed at children. Because
it collects no data from anyone, it collects no data from children.

## 📝 Changes to this policy

If this policy ever changes, the updated version will be published in the extension's
public repository with a new "last updated" date. Because the extension collects nothing,
any change would only clarify wording or describe new local features.

## ✉️ Contact

Questions or concerns? Open an issue at the project's repository:
<https://github.com/AberrantWolf/cardtable/issues>
