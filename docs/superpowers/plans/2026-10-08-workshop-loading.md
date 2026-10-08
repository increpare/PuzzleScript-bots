# Workshop loading confirmation implementation plan

> **For agentic workers:** Execute this approved plan inline with the executing-plans workflow; request a focused code review before integration.

**Goal:** Allow examples and room saves to load in Discord's sandbox while preserving the current shared game.

**Architecture:** Add `activity/workshop/loading.js`, installed by `main.js` after room sharing starts and included by `workshop-page.js`. Replace the two synchronous native-confirm dropdown handlers with one awaited HTML dialog, an acknowledged room save, and checked loading. Preserve the selected saved text before the room save refreshes the dropdown. Refuse replacement if the shared text changes during the save.

**Tech stack:** Browser JavaScript, HTML dialog, existing authenticated saves API, Node tests and Playwright Chromium.

- [x] Add `scripts/check-workshop-loading.js` using the real labs editor in a cross-origin sandbox without allow-modals. Check Cancel and Escape, successful backup and shared replacement, failed saves and example fetches, edits during a pending save, saved-game selection preservation, and clean shared-document confirmation. Run it and observe the absent in-page dialog failure.
- [x] Implement the loader with `WorkshopLoading.install({api, say, onSaved})`. Show Cancel and Save current game & load, explain replacement for everyone, disable loading controls during the operation, fetch examples with checked status, await `POST workshop/saves`, then replace and compile. Print failures and progress in the editor console; leave text and dirty status intact on cancellation/failure.
- [x] Include the new script before main, install after `share(view, first.body)`, update the page ordering test, and add the npm command `test:workshop-loading`.
- [x] Run the new sandbox checks, the existing browser checks and `npm test`. Review the scoped diff and address findings.
- [ ] Fetch master, integrate the fix onto master without touching concurrent edits, verify the integrated result, push master, deploy that clean checkout, and check the service and published loader.

Review addition: `workshop-saves.js` must update its in-memory list and revision only after file write and atomic rename succeed. Real filesystem obstruction tests cover both failures and prove a retry persists the backup.
