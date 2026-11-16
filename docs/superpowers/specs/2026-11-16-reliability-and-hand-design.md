# Reliability and hand design

Status: implemented following the user's authorization to execute the full plan. See the execution ledger and docs/testing.md for verification.

## Intent

Keep cardtable focused on spatial organization of tabs, groups, and notes. Remove
SSO interception as requested. Fix every issue in the full review before expanding
features. Preserve existing boards and vanilla browser code.

## Decisions and proposals

- User decision: remove the SSO guard, host settings, redirect logic, and
  `webNavigation` permission. Keep one-shot scroll restoration on reopening.
- User intent: hand neighbors must remain reliably reachable while the aimed-at
  card enlarges and neighbors move aside, with behavior similar to the macOS Dock.
- Proposed hand: a bounded, horizontally scrollable strip with stable logical hit
  regions independent of visual card transforms. Magnification is decorative;
  selecting, opening, and dragging always target the logical region under the cursor.
- Proposed architecture: a shared transactional storage adapter, background-owned
  durable commands, revisioned change notifications, stable page models and DOM,
  unified gesture finalization, and cached geometry. No framework or runtime bundler.

## Alternatives considered

1. Patch each race in place: smaller initial edits, but independent full-record
   writes and broad reloads would continue creating similar bugs. Not recommended.
2. Rebuild with a framework: introduces migration and packaging work unrelated to
   the failures. Not recommended.
3. Incremental transactional commands and stable rendering: recommended. Ship
   independently verifiable fixes first and introduce boundaries with their users.

For the hand, cascading z-order alone preserves the unstable transformed hit targets
and does not solve overflow. A scrollbar alone solves access but loses the desired
magnification. The proposed strip combines stable pointer mapping, scroll access,
and Dock-like displacement. The user authorized implementation without another approval pause; the result was verified in disposable browser profiles.

## Required behavior

- Invalid imports leave the entire existing board untouched. Replacement is atomic.
- Merge preserves current records on ID collision, including notes, layout, and live
  bindings; new IDs are added. Report added/skipped counts. Never deduplicate by URL:
  multiple intentional tabs can share one URL.
- One browser tab binds to at most one card; one card binds to at most one tab.
  Session bindings are authoritative only for their current browser session.
  Restart matching preserves fragments, queries, card IDs, and existing annotations.
- Deleting, opening, capture, import, and undo cannot interleave into stale writes.
- Draft text and gestures survive unrelated updates. Failed saves remain visibly
  unsaved and retryable. Undo restores positions, groups/names, and screenshot data.
- Mixed selections move together. Canceled gestures follow one documented rule:
  roll back their preview, except a drag ending in an explicit successful drop.
- Fit includes cards and sticky notes. Search includes hand cards and placed cards.
- Open in new window moves an existing live tab to a new window, or opens a closed
  card in a new window and binds it through the normal reopen path.
- Canvas rendering must not load remote favicon URLs. Existing remote URLs may
  remain metadata; missing locally cached icons use the letter placeholder.
- Capture is event-driven, deduplicated, and bounded, with a slow fallback only
  while a trackable tab is visible. Preserve guards against capturing another tab.

## Hand proposal and acceptance criteria

- Keep a stable visible order based on card creation order, with card ID as tie-breaker;
  filtering preserves that order. Hover, screenshots, and focus never reorder cards.
- Reserve a fixed-height bottom interaction band and a horizontally scrollable base
  track. Base cells are 82 CSS px; resting cards are 158 CSS px; the focused card is
  230 CSS px (independent of canvas card-width settings). Treat these as initial
  proposed values to tune during visual review.
- Compute target index from pointer x, track origin, scroll offset, and base cell
  pitch; never from transformed card pointerenter/pointerleave events. Expand the
  selected card about its aimed-at anchor, clamped within the band. Displace
  neighbors outwards with monotonically increasing centers; do not reorder them.
- Keep the pointer anchor stable as focus crosses cell boundaries: magnification
  follows a continuous logical coordinate, while the selected ID changes only at
  fixed cell boundaries. A stationary pointer never changes selection because
  another card animated underneath it.
- Use one interaction surface over the visual track. Card visuals do not intercept
  hit testing. Pointerdown freezes the selected card ID for click/double-click/drag;
  keep the same target throughout a gesture. Toolbar and trash remain separate.
- Provide native horizontal scrolling, Shift+wheel and trackpad horizontal scroll;
  ordinary vertical wheel over the hand also scrolls the track without canvas zoom.
  Do not auto-scroll simply because the cursor is resting near an edge. Freeze
  magnification while scrolling and recompute it after scrolling settles.
- Focused/hovered card paints above its nearest neighbors, then progressively
  farther neighbors. Only viewport cards plus a small overscan are rendered.
- Search filters the hand immediately. Keyboard arrows select/reveal neighboring
  hand cards; Enter opens, Escape exits hand focus. Touch uses tap focus and a
  second explicit activation; dragging must still work without hover.
- Reduced motion disables magnification/displacement transitions and uses a stable
  focus highlight. Every visible logical cell remains reachable at either edge.
- Validate 0, 1, 2, 10, 50, and 200 cards, narrow/wide viewports, both direction
  approaches, fast reversals, scrolling, search, pointer cancellation, and drag-out.

## Constraints

- Browser runtime remains vanilla JavaScript, HTML, and CSS; no browser-side bundler.
- Preserve Chromium MV3 service-worker and Firefox MV3 event-page loading order.
- Use Node.js 26 LTS and npm for development and verification.
- Keep data local; preserve font licenses and existing content-security restrictions.
- Preserve existing data; any schema change updates both consumers and CT.DBV with
  a migration. Prefer sharing the schema definition to prevent future divergence.
- Existing unrelated workspace edits must be preserved. No automatic commits,
  releases, permission prompts, or browser tests against the user's ordinary profile.

## Acceptance

Every review item maps to a task in the companion implementation plan. Use focused
regression tests for data loss, concurrency, and pure hand/geometry algorithms, plus
separate-profile Chromium and Firefox smoke tests for actual browser interactions.
Lint alone is not acceptance. Performance claims require measured browser results.
