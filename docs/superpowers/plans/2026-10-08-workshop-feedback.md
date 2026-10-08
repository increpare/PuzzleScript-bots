# Workshop Feedback Implementation Plan

> **For agentic workers:** Use test-driven development and review the final changes against the approved spec. Execute in this session on the existing workshop branch; keep unrelated animation edits intact.

**Goal:** Repair workshop controls and add cursor navigation and temporary editor signals.

**Architecture:** Keep labs adaptations in the workshop browser scripts. Extend the existing HTTP long-poll service with bounded ephemeral exports and signals. Reuse CodeMirror position mapping and scroll effects, with a viewport overlay for labels/signals.

**Tech Stack:** Node.js, native HTTP, CodeMirror 6, Discord Embedded App SDK, Chromium/Playwright for editor verification.

## Task 1: Downloads

Files: create `discord-bot/workshop-exports.js` and `discord-bot/test/workshop-exports.test.js`; modify `discord-bot/http-server.js`, `discord-bot/bot.js`, `discord-bot/config.js`, and `discord-bot/test/http-server.test.js`.

- [x] Write regression tests for snapshot content, UTF-8 filenames, expiry, capacity, unauthorized creation and token-only downloads. API shape: `createExports({now, ttlMs, maxBytes}).add({html, source, filename})` returns `{html, source}` token strings; `get(token)` returns an attachment or null. POST `/api/workshop/export` returns public URLs; GET `/downloads/<token>` serves the bytes as an attachment.
- [x] Run `node --test test/workshop-exports.test.js test/http-server.test.js`, confirm new cases fail before implementation.
- [x] Implement the store with 24 random bytes per token, 15-minute expiry, 8 MB request limit and 32 MB total cap. Validate HTML/source/filename; clean expired entries before adding and retrieving. Use sanitized ASCII fallback plus RFC5987 UTF-8 filename, `content-disposition: attachment`, `cache-control: no-store`, `x-content-type-options: nosniff`.
- [x] Wire store and configurable `WORKSHOP_PUBLIC_URL` (default `https://games.increpare.com/puzzlescriptbot/app/`) through the bot and server. Test bad/expired/missing tokens return 404 and cannot authorize any API operation.

## Task 2: Signals

Files: create `discord-bot/workshop-signals.js` and `discord-bot/test/workshop-signals.test.js`; modify `discord-bot/http-server.js`, `discord-bot/bot.js`, and HTTP tests.

- [x] Write failing tests for five-second expiry, session-derived names, maximum positions/document version, position mapping and stale-version refusal. API shape: `add({uid,name,pos,version})`, `list()`, `map(changes)`. POST `/api/workshop/signal` takes `{pos,version}` and responses to workshop pulls carry `signals` and the current `version`.
- [x] Run `node --test test/workshop-signals.test.js test/http-server.test.js` and confirm missing behavior fails.
- [x] Implement in-memory signals, one active signal per user, five-second TTL, stable sender colours, random identifiers and bounded capacity. Only accept a position in the current document version. Map existing signals through every accepted push before long-poll responses are sent; nudge waiting editors when a signal is added.
- [x] Re-run store and HTTP tests.

## Task 3: Browser adaptations

Files: create `discord-bot/activity/workshop/controls.js`, `discord-bot/activity/workshop/navigation.js`, and browser test harness under `discord-bot/scripts/`; modify `discord-bot/activity/workshop/main.js`, `discord-bot/workshop-page.js`, and page tests.

- [x] Add failing browser assertions against the actual labs editor for sound output, real export links, first-visible-line labels, roster scroll without selection change, signal delivery/edge arrow/expiry, and document mapping. Use two browser contexts and the real bot HTTP server in dev-session mode.
- [x] Replace `newSound` without parent access; print the seed before playing sound. Override `saveAs` only inside Discord: POST both immutable output and source; print real links and report upload failures. Keep external downloads on the actual configured app URL rather than remapping them to puzzlescript.net.
- [x] Render cursor labels and signals in a CodeMirror viewport overlay refreshed with `requestMeasure`, scroll and resize. Use `EditorView.scrollIntoView(pos,{y:'center'})` for roster and arrows. Use `posAtCoords` to place signals, prevent the second contextmenu, and map received positions through pending collaboration updates.
- [x] Re-run browser regressions, including ordinary right-click and disconnect/expiry.

## Task 4: Review and delivery

- [x] Document export links, cursor navigation, signals and `WORKSHOP_PUBLIC_URL` in the bot README/environment example, preserving unrelated edits.
- [x] Run `npm test` in `discord-bot`, browser regressions and `git diff --check`.
- [x] Request independent code review, address actionable findings, and re-run affected checks.
- [x] Leave the reviewed implementation in the user's workspace and report verification and any real-Discord limitation. Deployment requires a separate request.

## Verification result

On 8 October 2026, all 273 Discord bot tests and all 10 opt-in Chromium checks passed. Independent server export, server signal and browser reviews found no remaining actionable issues. Screenshots confirmed label placement and visible/off-screen signals. Actual Discord SDK authentication and external-link opening were simulated in the browser harness; the live Discord client was not tested. Changes remain in the workshop working tree for deployment.
