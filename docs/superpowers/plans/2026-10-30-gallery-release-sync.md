# Gallery Release Sync Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task-by-task in this session. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Support gallery source links and refresh the bot's suggestions after new releases threads.

**Architecture:** Keep gist resolution in `gallery-entry.js`, gallery projection in `gallery.js`, and fetching, cache persistence and event filtering in `gallery-sync.js`. Wire the service into the existing Discord client with the existing Guilds intent.

**Tech Stack:** Node.js, node:test, discord.js, native fetch and filesystem APIs.

---

### Task 1: Resolve gallery source links consistently

**Files:** `discord-bot/gallery-entry.js`, `discord-bot/gallery.js`, `discord-bot/test/gallery-entry.test.js`, `discord-bot/test/gallery.test.js`.

- [x] Add regression cases for external URLs with editor/play/gist sources, source precedence, fallback to a playable URL, case normalization, duplicate sources and submission duplicate detection. Expected identities are lowercase gist IDs, and repeated identities appear once.
- [x] Run `node --test discord-bot/test/gallery.test.js discord-bot/test/gallery-entry.test.js`; confirm the new cases fail.
- [x] Change `gistOf(record)` to `parseGistId(record && record.source) || parseGistId(record && record.url)`. Add `galleryFromRecords(records)` using `gistOf`, retaining the first instance of each identity. Have `loadGallery` use it and the existing bounded `readRecords` reader.
- [x] Repeat the targeted command; expect no failures.

### Task 2: Fetch and cache on releases events

**Files:** new `discord-bot/gallery-sync.js`, new `discord-bot/test/gallery-sync.test.js`.

- [x] Write service tests using temporary directories, native Response objects and injected fetch functions. Verify `refresh()` updates suggestions and a JSON cache, `restore()` restores it, `onThread(thread, newlyCreated)` fetches only for the configured new releases threads, and concurrent refreshes execute sequentially. For HTTP errors, invalid/empty/oversized lists and disk failures, expect `false`, an error log and the previous cache/list intact. Check a script containing executable statements is rejected without execution.
- [x] Run `node --test discord-bot/test/gallery-sync.test.js`; expect failure because the module is absent.
- [x] Implement `createGallerySync({dataDir, guildId, releasesChannelId, onRefresh, fetchImpl = globalThis.fetch, log = console.error})`, returning `restore`, `refresh` and `onThread`. Parse only the gallery declaration's JSON array, removing its optional final comma and semicolon. Require a nonempty array of records with string URL/title/author and at least one usable gist. Fetch the fixed public URL with `AbortSignal.timeout(10000)`, limit to 1,000,000 bytes, atomically write `gallery.json`, then call `onRefresh(galleryFromRecords(records))`. Catch failures inside each serialized refresh. Ignore `newlyCreated !== true`, a different parent ID and a different guild ID.
- [x] Repeat the service test command; expect no failures.

### Task 3: Configure and wire the existing bot

**Files:** `discord-bot/config.js`, `discord-bot/.env.example`, `discord-bot/test/config.test.js`, `discord-bot/bot.js`, `discord-bot/README.md`.

- [x] Test `galleryReleasesChannelId` defaults to `1562643319341715486` and is overridden by `GALLERY_RELEASES_CHANNEL_ID`. Run config tests and observe failure, then implement that returned property.
- [x] Create the sync service beside `games` and `client`; its callback is `gallery => { games = loadGames({gallery}); }`. Call `restore()` before login and register `client.on('threadCreate', gallerySync.onThread)`. Call `gallerySync.refresh()` on ready and after the existing immediate `/admin_gallery` reload.
- [x] Document source support, startup/release refresh, existing-thread exclusion, cache fallback, channel visibility and the configuration override. Add the default channel to `.env.example`.
- [x] Run `node --check discord-bot/bot.js` and `cd discord-bot && npm test`; expect all checks to pass. Fetch the real public gallery through the service using a temporary cache and verify the new source games are included.

### Task 4: Apply the researched source links and deliver

**Files:** main PuzzleScript `src/games_dat.js`; the bot files listed above.

- [x] Read `gallery-source-audit.json` from this chat's visualization directory. Add only its eleven `missingSourceLinks` source fields to matching URL/title records in the main PuzzleScript checkout. Evaluate the local data-only file with the existing bounded reader and verify each added source resolves to the audited identity; preserve the existing source fields and every official URL.
- [x] Review the feature diff and apply only these changes to the original bot checkout, merging the existing scoreboard edits without overwriting them. Run the full suite there as well.
- [x] Compare production versions of the bot files against the feature's base before copying. Back up and deploy only the gallery-related runtime files, restart the existing puzzlescript-bot service and verify its active state and successful gallery-refresh log. Read releases channel metadata and effective ViewChannel permission without posting a test thread.
- [x] Report source support, the exact releases trigger, tests and deployment results, and the existing realtime limitation. Keep the researched source additions local unless separately authorized to publish them.

## Validation record

- 441 feature-branch tests passed; 454 tests passed with the existing scoreboard changes merged in the main checkout.
- Code review found no actionable issues; 40 focused tests were independently rerun.
- The live public list parsed as 143 records with 132 gist identities; its eight existing source links were recognized.
- The bot can view forum channel 1562643319341715486 in the configured guild.
- Five runtime files were deployed with SHA256 guards and rollback backups. The existing service is active and logged `gallery refreshed: 132 games`. No test thread was posted.
- Eleven verified source fields were added locally to the main PuzzleScript gallery. Publishing those fields remains part of the user’s next gallery upload.
