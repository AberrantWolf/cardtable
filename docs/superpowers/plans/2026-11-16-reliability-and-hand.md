# Reliability and hand implementation plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task by task. Use subagent-driven development only if the user chooses delegation. Steps use checkbox syntax for tracking.

**Status:** Implemented and reviewed on November 16, 2026. See [execution ledger](2026-11-16-progress.md) and [verification](../../testing.md) for evidence and remaining manual browser checks. Task steps below record the intended sequence; equivalent named regressions are grouped in the implemented suite.

**Goal:** Fix all findings from the full review while keeping cardtable focused on spatial tab organization and making the hand predictable at scale.

**Architecture:** Introduce shared transactional persistence and background-owned durable commands incrementally. Keep stable, indexed page models and DOM; apply revisioned deltas after commits. Unify interaction lifecycles and separate pure hand layout/geometry from DOM rendering.

**Tech stack:** Vanilla JavaScript/HTML/CSS, IndexedDB, browser extension APIs, Node.js 26 LTS and npm; Node's built-in test runner plus `fake-indexeddb` as a development dependency for transaction tests.

**Spec:** [Reliability and hand design](../specs/2026-11-16-reliability-and-hand-design.md). The hand geometry and merge policy are proposals for review, not already-approved implementation details.

## Global constraints

- Browser runtime remains vanilla JavaScript, HTML, and CSS; no browser-side bundler.
- Preserve Chromium MV3 service-worker and Firefox MV3 event-page loading order.
- Use Node.js 26 LTS and npm for development and verification.
- Keep data local; preserve font licenses and existing content-security restrictions.
- Preserve existing boards and unrelated working-tree edits. No automatic commits.
- Add meaningful regression tests for the identified failures, not implementation-mirroring tests.
- After each source/build/dependency task, run its focused tests, the full existing suite, `npm run lint`, and `git diff --check`.
- Browser smoke tests use disposable profiles and boards; report unavailable browsers.

## Review focus

- Duplicate URLs, fragments, transient IDs and worker restart must preserve identity (Task 2).
- Invalid/large imports, write aborts and concurrent tab events must preserve the old board (Task 3).
- Editing, capture and deletion overlapping must never resurrect records or discard drafts (Tasks 4–6).
- Capture loss, visibility changes and mixed selections must leave no stale listeners or partial gestures (Tasks 7–8).
- Hand edge targets, fast pointer reversal, overflow and reduced motion must remain predictable (Task 11).

## Boundaries and file map

- `extension/src/storage.js` (new classic script): one shared schema and transaction helper, global `CTStore`. Load after shared.js in page and Firefox background; import in Chromium worker. Keep `db.js` as a thin page adapter during migration.
- `extension/src/commands.js` (new classic script): background command queue, atomic board mutations, post-commit change sets. `background.js` retains browser event wiring and browser effects.
- `extension/src/board-model.js` (new page module): card/group/sticky maps, membership indexes, draft overlay and revisions.
- `extension/src/interactions.js` (new page module): gesture and editing leases, cleanup and cancellation.
- `extension/src/hand-layout.js` and `hand.js` (new page modules): pure pointer/layout math and hand rendering/input, respectively.
- `extension/src/geometry.js`: retain pure geometry; introduce per-group caches at its caller.
- `tests/`: Node regression tests, an isolated fake-browser harness and IndexedDB fixtures. No framework in extension assets.
- `docs/testing.md` (new): disposable-profile smoke cases and measured performance scenarios.

The names below are intended contracts. Preserve public behavior while extracting each boundary; do not split app.js into generic layers without a concrete consumer.

## Task 0: Remove SSO interception — implemented in this turn

**Files:** background.js, shared.js, app.js, newtab.html/css, base manifest, store metadata, README/privacy/repository guidance.

- [x] Remove redirect listeners, guard session helpers and calls, auth-host defaults/helpers, settings controls and CSS.
- [x] Remove `webNavigation` permission and related store/privacy documentation.
- [x] Retain one-shot scroll restoration. Existing settings normalization drops removed settings on load/import/save/export.
- [x] Verify syntax, settings compatibility, both builds, lint and whitespace. Two existing Firefox compatibility warnings remain.
- [x] Smoke-test ordinary open/reopen in separate Chromium and Firefox development profiles.

## Task 1: Shared storage, committed transactions and command ownership

**Files:** create storage.js, commands.js, tests/storage.test.cjs, tests/helpers/browser.cjs; modify db.js, background.js, newtab.html, manifest.firefox.json, package.json/lock, CI.

**Interfaces:** `CTStore.open(): Promise<IDBDatabase>`; `CTStore.transaction(storeNames, mode, enqueue): Promise<Result>` where enqueue synchronously registers IDB work, request callbacks may enqueue dependent IDB requests, and the returned promise resolves only on transaction complete. No browser/network awaits inside a transaction. `CTCommands.run(name, input): Promise<{value, change}>` serializes durable mutations; change is published only after commit.

- [x] Add `npm test` using `node --test`, fake IndexedDB fixtures and a controllable fake browser. Test `transaction_rejects_on_abort_after_request_success` and `command_failure_does_not_publish_change` first.
- [x] Run `node --test tests/storage.test.cjs`; verify the regression assertions fail before implementation.
- [x] Share the existing version-1 schema without data loss. Cache the open promise, clear it on failure/versionchange, and report save failures rather than swallowing them. Keep adapters compatible until their callers migrate.
- [x] Introduce the mutation queue and structured `{ok:false,error:{code,message}}` responses. Queue browser events before reconciliation finishes. Browser effects are prepared outside transactions and compensated/reconciled on failure.
- [x] Add a `meta` store keyed by `key`, increment CT.DBV to 2, and test the v1→v2 migration preserving every existing store and blob. Store `{key:"revision",value:number}` and increment it inside each mutation transaction. Update both adapters to consume the shared schema definition.
- [x] Run the focused/full tests, lint and diff check. Add `npm test` to CI.

## Task 2: Tab identity and reopen coordination

**Files:** background.js, commands.js, shared.js; create tests/tab-identity.test.cjs.

**Interfaces:** `openCard({cardId, destination:'current'|'newWindow'}): Promise<{cardId,tabId}>`; session map `{tabId:cardId}` lives in storage.session and is rebuilt on browser restart. All creation/update/removal events use the command queue.

- [x] Write failing tests: `restart_does_not_trust_reused_tab_id`, `cold_reopen_adopts_provisional_card`, `concurrent_open_creates_one_tab`, `worker_restart_preserves_session_binding`, `same_url_cards_remain_distinct`, `fragment_routes_match_exactly`.
- [x] Run `node --test tests/tab-identity.test.cjs`; confirm failure for the existing identity/reopen races.
- [x] Use only current-session bindings as ID authority; at browser restart match exact canonical URLs including fragment/query, assign each candidate once, and preserve unmatched closed cards. Stop using hash-dropping normalization as card identity.
- [x] Coordinate tab creation and binding: events queue behind the originating open command; adopt any provisional record from a browser event and transfer its screenshot if necessary before removing it. Track in-flight open promises per card and recheck bindings before side effects.
- [x] Test activation/removal failures and two cards intentionally sharing a URL. Verify command completion, browser state and stored records agree after reconciliation.
- [x] Run focused/full tests, lint and diff check.

## Task 3: Validated, atomic import and consistent export

**Files:** app.js, commands.js, storage.js; create board-format.js (classic pure validator loaded by background/page), tests/import-export.test.cjs.

**Interfaces:** `CTBoardFormat.validate(data): ValidatedBoard` throws before mutation; `CTCommands.run('importBoard',{mode,board})` returns added/skipped counts; `exportBoard` returns one consistent committed snapshot. Version remains v1 unless the payload actually changes.

- [x] Write failing tests: `unrelated_json_rejected_without_changes`, `bad_second_record_preserves_all_stores`, `aborted_replace_rolls_back`, `merge_preserves_live_binding_and_current_note`, `export_waits_for_dirty_edits`, `capture_and_import_are_serialized`.
- [x] Validate v1, required arrays, unique IDs, cross-references, HTTP(S) URLs, finite coordinates/zoom, supported settings types/ranges, and string fields before clearing anything. Accept missing notes for legacy v1 exports; reject missing tabs/layout/groups. Show validation errors without changing state.
- [x] Route page import through background. Replace all stores in one transaction; merge skips colliding IDs, adds new IDs, never overwrites live bindings, and reports counts. Clear pending page writes only after drafts are safely committed or explicitly canceled; invalidate undo only after successful replacement.
- [x] Preserve existing replace semantics for browser tabs: import does not close real tabs; reconcile/retrack open tabs after commit. Document this behavior. Never let pre-import events restore pre-import rows during the transaction.
- [x] Export after committing pending edits and use a single readonly snapshot transaction. Preserve the documented omission of screenshot blobs; importing does not silently promise a complete image backup.
- [x] Run tests, lint and diff check; manually test merge/replace on disposable boards in both browsers.

## Task 4: Capture concurrency and bounded scheduling

**Files:** background.js, content.js, commands.js; create tests/capture.test.cjs.

**Interfaces:** capture token `{cardId,tabId,url,generation}` is checked at commit; `commitCapture(token,blob,metadata)` refuses deleted/rebound/navigated cards and changes only fields owned by capture. `scheduleCapture(tabId,reason)` coalesces per-tab requests.

- [x] Write failing tests: `delete_during_capture_does_not_resurrect`, `navigation_during_capture_drops_result`, `capture_preserves_newer_scroll`, `active_tab_switch_drops_wrong_image`, `repeated_requests_coalesce`, `closed_tab_releases_scheduler_state`.
- [x] Perform browser capture/resize outside IDB; recheck current binding/navigation generation inside the serialized commit and atomically write valid screenshot state. Do not recreate a card during capture completion.
- [x] Keep active-tab checks before/after capture; retain one encode/decode path unless measurement demonstrates a safe simplification. Limit to one capture in flight per window and one pending request per tab.
- [x] Use activation, completed load, debounced scroll and visibility triggers with a 5-second per-tab minimum capture spacing; replace the 6-second interval with one 60-second visible-page fallback. Remove unused captureIntervalMs default. Bound/clean error and throttle maps when tabs close.
- [x] Run tests, lint and diff check. Measure capture counts on a static page over five minutes; verify event-triggered refresh without continuous six-second writes.

## Task 5: Stable model, revisioned updates and draft preservation

**Files:** app.js, commands.js; create board-model.js, tests/board-model.test.cjs.

**Interfaces:** changes `{revision,upserts:{tabs,layout,groups,notes,shots},deletes:{tabs,layout,groups,notes,shots}}`; `BoardModel.apply(change)` updates indexed maps; drafts keyed by entity ID overlay committed state. A revision gap triggers a snapshot rather than applying an incomplete delta.

- [x] Write failing tests: `incoming_title_preserves_note_draft`, `sticky_draft_survives_update`, `revision_gap_requests_snapshot`, `stale_snapshot_does_not_replace_newer_state`, `failed_save_retains_dirty_draft`.
- [x] Move all durable page writes, including layout, group and note writes, through background commands. Batch dirty layouts and await commit acknowledgements; keep unsaved drafts on failure with a visible retry action.
- [x] Replace whole-store reloads with post-commit change sets; use a full snapshot for boot/recovery/import. Reuse DOM nodes keyed by IDs and patch only affected elements. Do not replace focused editors or captured drag nodes.
- [x] Preserve compatibility broadcasts during migration, then remove broad reload consumers once every sender publishes changes. Recheck interaction/revision at both delayed callback execution and snapshot application.
- [x] Run tests, lint and diff check; type continuously while another tab changes title/navigates and confirm the draft and caret remain intact.

## Task 6: Complete undo and persistence barriers

**Files:** app.js, commands.js, board-model.js; create tests/undo.test.cjs.

**Interfaces:** `beginMutationSnapshot(entityIds): Snapshot`; `commitMutation({before,after}): UndoToken`; `undo(token)` restores affected board records atomically. Tokens are held by the background for the browser session, capped at 50 entries and 32 MiB of retained blob data; evict oldest whole entries.

- [x] Write failing tests: `long_drag_undo_restores_start`, `move_undo_restores_group_name_and_partner`, `delete_undo_restores_screenshot`, `undo_cannot_overtake_pending_save`, `mixed_delete_is_one_undo`, `eviction_releases_retained_blobs`.
- [x] Capture immutable before-state at gesture/delete start, including affected neighbors, groups, layouts, notes and screenshots. Stop reading the supposed before-state from IndexedDB at pointer release.
- [x] Route undo through the same command queue. Delete undo restores closed cards and cached images without reopening tabs; move undo preserves current tab bindings and metadata. A stale token must fail visibly rather than overwrite an intervening import.
- [x] Flush or order pending edits before export/delete/undo and before intentional canvas navigation. Save edits on input with debounce plus blur/pagehide barriers; do not rely on unload completing asynchronous work.
- [x] Run tests, lint and diff check; manually verify undo after long drags, group dissolution and card deletion.

## Task 7: Unified gesture lifecycle and mixed selections

**Files:** app.js; create interactions.js, tests/interactions.test.cjs.

**Interfaces:** `beginGesture({pointerId,element,before,onMove,onCommit,onCancel})`; a terminal event runs exactly one finalizer and then releases capture/listeners. `withEditor(entityId)` participates in the same interaction lease.

- [x] Write failing tests: `cancel_finalizes_once`, `capture_loss_rolls_back`, `hide_rolls_back_group_and_carried_notes`, `pan_cancel_removes_listeners`, `mixed_selection_moves_every_entity`, `deselected_card_does_not_start_group_move`.
- [x] Route card, sticky, group, pile, hand and pan interactions through this owner. Keep movement as a preview until explicit drop, then commit once; cancel/hide/capture-loss roll back to the start snapshot. A canceled pile click creates nothing.
- [x] Use one selection movement snapshot across cards/stickies. Preserve grouping rules for cards and carried-note behavior for group-outline dragging. Mixed deletion creates one undo command.
- [x] Block/rebase conflicting external updates while a gesture/editor owns an entity; apply queued nonconflicting updates without replacing its node. Ensure new interactions cannot run into a pending async finalizer.
- [x] Run tests, lint and diff check; smoke-test touch/pointer cancellation and tab hiding in both browsers.

## Task 8: Honest commands, fit and search

**Files:** app.js, commands.js, shared.js; create tests/canvas-commands.test.cjs.

**Interfaces:** reuse Task 2's destination parameter; `fitBounds(cards,notes,sizes): Bounds|null`; one search result set feeds placed-card dimming and hand filtering.

- [x] Write failing tests: `new_window_moves_live_tab_without_duplicate`, `new_window_reopens_closed_card_once`, `fit_includes_only_notes`, `fit_includes_outlying_note`, `search_finds_hand_cards`.
- [x] Implement Open in new window with browser windows.create and the existing tab ID when live, or the coordinated reopen path when cold. Preserve card identity; reconcile failed browser effects.
- [x] Fit cards and stickies, including rotation-aware bounds, and reserve actual toolbar/hand viewport space. Empty boards are a no-op. Preserve existing placed-card search dimming and filter hand results without reordering them.
- [x] Run tests, lint and diff check and verify actual window creation in both browsers.

## Task 9: Local favicon rendering and accurate privacy text

**Files:** background.js, content.js, commands.js, app.js, shared.js, manifests if needed, PRIVACY.md and store/README text; create tests/favicons.test.cjs.

**Interfaces:** `storeFavicon({cardId,blob,sourceUrl})` accepts bounded local image bytes only; canvas receives blob references, never a remote image src. Missing/unsupported icons render the existing letter placeholder.

- [x] Write failing tests: `cold_card_render_has_no_remote_image_src`, `imported_icon_url_is_metadata_only`, `cached_blob_renders`, `oversized_or_invalid_icon_is_rejected`, `favicon_url_cleanup_on_delete`.
- [x] First stop remote favicon loads in canvas. Cache bytes only when available from the active page/browser without an additional request; support existing data URLs after validation. Do not introduce a remote-fetch proxy simply to preserve every favicon. Unsupported icons use placeholders.
- [x] Store valid image blobs alongside screenshot records in an optional favicon field, preserving existing screenshot blobs and avoiding schema changes if possible. Preserve showFavicons as a local-display toggle.
- [x] Audit all canvas image/style sources and imported values. Update privacy/store text to state actual behavior, and verify zero remote canvas requests on cold/imported boards. Loading the user's chosen real tab remains normal browsing.
- [x] Run tests, lint and diff check; confirm via browser network tools with a disposable board.

## Task 10: Incremental group geometry and bounded resources

**Files:** app.js, geometry.js, board-model.js; create tests/group-cache.test.cjs; extend docs/testing.md.

**Interfaces:** `GroupGeometry.get(groupId,{pad,geometryRevision})`; membership Map<groupId,Set<cardId>> updates incrementally. Cache normal/join/leave outlines separately; label placement reuses cached bounds.

- [x] Write failing tests: `moving_one_card_invalidates_only_affected_groups`, `rename_does_not_rebuild_hull`, `settings_size_change_invalidates_geometry`, `removed_cards_release_object_urls`.
- [x] Schedule one drag-render pass per animation frame; update only affected group paths/labels. Use maps for entity lookup/membership and retain pure geometry functions. Start with bounding-box rejection for hit tests; add a spatial index only if profiling justifies it.
- [x] Revoke screenshot/favicon object URLs on external deletion/replacement as well as local actions; bound caches and remove references to deleted entities.
- [x] Measure 50, 200 and 500-card boards with both a few large groups and many solo groups. Record p50/p95 frame duration and counts of geometry recomputations before/after; target p95 under 16.7 ms on the recorded development machine, and report misses honestly.
- [x] Run tests, lint and diff check. Preserve group hysteresis and note carriage behavior visually.

## Task 11: Dock-style hand with stable targeting

**Files:** create hand-layout.js, hand.js, tests/hand-layout.test.cjs; modify app.js, newtab.html/css, interactions.js.

**Interfaces:** `hitHand({clientX,trackLeft,scrollLeft,pitch,count}): index|null`; `layoutHand({count,focusCoordinate,scrollLeft,viewportWidth,reducedMotion}): {index,x,width,z}[]` returns viewport plus overscan; hand gestures consume the selected card ID, never transformed-element hover events.

- [x] Implement the user-authorized hand proposal directly and verify it visually in the disposable browser, without another approval pause (per the user's execution instruction).
- [x] Write failing tests: `stationary_pointer_keeps_target_during_animation`, `neighbors_reachable_from_both_sides`, `centers_remain_ordered`, `scroll_offset_maps_correctly`, `edge_focus_stays_visible`, `filter_preserves_order`, `reduced_motion_keeps_stable_hit_cells`, `render_count_is_bounded_for_200_cards`.
- [x] Implement the spec's stable 82 px logical cells, 158 px resting / 230 px focused card geometry, continuous focus coordinate and neighbor displacement. Keep the hovered card above progressively farther neighbors; no reordering.
- [x] Use a single fixed interaction surface and bounded scroll track. Freeze ID at pointerdown; preserve double-click activation and drag-out via Task 7. Scrolling must not trigger canvas zoom or change a held gesture's target; native scroll completion recomputes hover.
- [x] Add keyboard navigation/reveal, touch focus/activation, reduced-motion highlighting and accessible labels/focus. Search filters/reveals hand results. Keep trash/pile outside hand hit regions.
- [x] Verify pure layout/input matrices and real browser hand rendering/targeting. Physical touch and native permission/shortcut checks remain manual; see verification notes. Run focused/full tests, lint and diff check.

## Task 12: Whole-extension validation and handoff

**Files:** docs/testing.md, relevant README/AGENTS guidance and test fixtures.

- [x] Run `npm ci`, `npm test`, `npm run lint`, and `git diff --check` under Node 26. Distinguish the two known Firefox metadata warnings from new failures.
- [x] In disposable Chromium and Firefox profiles, verify toolbar/Alt+Shift+C singleton canvas, pin/new-tab settings, capture, close/reopen, new-window behavior, multi-selection, groups, notes, cancellation, undo, search, hand overflow, import/export and persistence across browser/worker restart.
- [x] Exercise capture+delete, import+capture, edit+navigation and queued-reload+drag interleavings. Verify one tab/card binding invariant after each operation.
- [x] Recheck manifests and script order, both schema consumers/migrations, local-only resources, font licenses, release artifact contents and documentation. Keep unrelated release changes out of implementation commits.
- [x] Compare measured capture/geometry/DOM work with the recorded baseline. Record unavailable smoke checks and unresolved findings explicitly; do not call the work complete while data-loss regressions remain.

## Coverage map

| Review finding | Task |
|---|---|
| Invalid replacement erases board | 3 |
| Restart tab identity / duplicate reopening | 2 |
| Editing drafts lost / reload interrupts drag | 5, 7 |
| Merge overwrites data/live binding | 3 |
| Capture resurrects deleted card | 4 |
| Move undo snapshot / group restoration | 6 |
| Delete undo loses screenshot | 6 |
| Gesture cancellation / pan listener leaks | 7 |
| SSO complexity / false redirects | 0 (removed) |
| Remote favicons / privacy contradiction | 9 |
| Open in new window is another tab | 8 |
| Hand overflow / neighbor targeting / search | 8, 11 |
| Mixed selection movement | 7 |
| Fit ignores sticky notes | 8 |
| Shared transactions / ownership / silent errors | 1, 3–6 |
| Broad reload/DOM churn | 5 |
| Group algorithm waste | 10 |
| Redundant screenshot work | 4 |

## Execution sequence

Implement 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9 → 10 → 11 → 12. Each task must leave a working extension with its regression checks passing. All tasks are implemented. Milestone reviews and the full integration review were followed by regression-backed fixes. Remaining manual checks are listed in docs/testing.md. No framework rewrite or unrelated new feature is part of this plan.
