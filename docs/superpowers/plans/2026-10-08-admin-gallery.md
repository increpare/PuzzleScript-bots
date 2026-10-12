# Admin Gallery Implementation Plan

> **For agentic workers:** Use test-driven development and review the final changes against the approved spec. Execute in this session on the existing workshop branch; the tree holds other uncommitted work, which is to be left as it is. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `/admin_gallery` gives the owner a private page on which a game is played in the real engine, a GIF is made of one level's play, and the game is filed in the PuzzleScript gallery.

**Architecture:** Three small modules beside the bot: the text edit of `games_dat.js` and the checks on a submission (pure), the commit through GitHub's Git Data API, and the submitter that runs the three landings in order. The existing http server gains two token-guarded endpoints and serves the master engine under its own path. The page is plain HTML and one script that hooks the engine's two recording stubs.

**Tech Stack:** Node.js (`node --test`), native HTTP and `fetch`, discord.js, the PuzzleScript master engine and its `jsgif` encoder in the browser, Chromium/Playwright (from the labs checkout) for the page check.

**Spec:** `docs/superpowers/specs/2026-10-08-admin-gallery-design.md`

## Global Constraints

- Nothing under `puzzlescript/` is changed.
- The command, endpoints and page exist only when `OWNER_USER_ID`, `GALLERY_TOKEN`, `GALLERY_SITE_DIR` and `DISCORD_CLIENT_SECRET` are all set.
- Token: `{ kind: 'gallery', uid, gistId }`, six hours, carried in the URL fragment and returned as `Authorization: Bearer`.
- GIF at most 2 MB; request body at most 3 MB; title and author 1–100 characters; homepage empty or at most 200 characters with no whitespace.
- Record: `{ url: 'https://www.puzzlescript.net/play.html?p=<gist id>', thumb: '<gist id>.gif', title, author, homepage }`, `homepage` left out when empty.
- Repository `increpare/PuzzleScript`, branch `master`, paths `src/games_dat.js` and `src/Gallery/gifs/<gist id>.gif`, message `gallery: add <title> by <author>`.
- Comments and wording follow the surrounding code: plain sentences that say why.

---

## Task 1: The record and the edit

Files: create `discord-bot/gallery-entry.js` and `discord-bot/test/gallery-entry.test.js`.

Produces:
- `class GalleryError extends Error` (`name: 'GalleryError'`)
- `readRecords(text) → object[]` — evaluates a `games_dat.js` as `gallery.js` does
- `gistOf(record) → string|null` — the lower-cased id in a record's `url`
- `hasGist(text, gistId) → boolean`
- `checkSubmission({ gif, title, author, homepage }) → { gif: Buffer, title, author, homepage }` — trims the fields, decodes `gif` from base64, throws `GalleryError` with a message fit to show
- `galleryRecord({ gistId, title, author, homepage }) → record`
- `appendRecord(text, record) → string` — throws `GalleryError` for a text that does not end in `]`, or already has the gist

- [x] Tests: a record appended to the real `puzzlescript/src/games_dat.js` evaluates to one entry more, the last deep-equal to the record, and everything before the closing `]` is byte-for-byte the old text; the new block uses two-space indent, four-space keys and a trailing comma; a file whose last entry has no trailing comma gets one added; text without a closing `]` is refused; a gist already present (any case) is refused; titles with quotes and backslashes survive; `homepage` is omitted when empty. `checkSubmission`: accepts `GIF89a`/`GIF87a`, refuses other bytes, 2 MB + 1, empty or 101-character title/author, 201-character homepage, homepage with a space, non-string fields.
- [x] Run `node --test test/gallery-entry.test.js`; confirm it fails for want of the module.
- [x] Implement. The block is built with `JSON.stringify(record, null, 4)` re-indented by two spaces, so that it matches the file's own layout; the result is checked by `readRecords` before it is returned.
- [x] Run the test again; confirm it passes.

## Task 2: The commit

Files: create `discord-bot/gallery-github.js` and `discord-bot/test/gallery-github.test.js`.

Consumes: `GalleryError`.

Produces: `createGalleryRepo({ token, fetchImpl = globalThis.fetch, repo = 'increpare/PuzzleScript', branch = 'master' })` →
- `readGamesDat() → Promise<string>` — master's `src/games_dat.js` now
- `addGame({ gifPath, gif, edit, message }) → Promise<{ commitUrl }>` — `edit(text) → text` is applied to the `games_dat.js` at the head the commit is made on

- [x] Tests against a fake `fetchImpl` that keeps a ref, commits and trees in memory: one commit is made whose tree carries the GIF blob (base64) and the edited text, on the head's tree, with the head as its only parent; the ref update is not forced; headers carry the token and API version; when the ref update answers 422 once, the whole sequence is run again from the new head and `edit` is called with the new text; a second 422 throws `GalleryError`; 401/403 throws `GalleryError` naming the token; a `GalleryError` thrown by `edit` passes through and nothing is written.
- [x] Run `node --test test/gallery-github.test.js`; confirm it fails.
- [x] Implement with: `GET git/ref/heads/<branch>`, `GET git/commits/<sha>`, `GET contents/src/games_dat.js?ref=<sha>` (raw), `POST git/blobs`, `POST git/trees` (`base_tree`), `POST git/commits`, `PATCH git/refs/heads/<branch>` with `force: false`. `commitUrl` is `https://github.com/<repo>/commit/<sha>`.
- [x] Run the test again; confirm it passes.

## Task 3: The submitter

Files: create `discord-bot/gallery-submit.js` and `discord-bot/test/gallery-submit.test.js`; modify `discord-bot/gallery.js` (export `forgetGallery()`, which drops the cached list) and `discord-bot/test/gallery.test.js`.

Consumes: Task 1 and Task 2's exports.

Produces: `createGallerySubmitter({ repo, getSource, siteDir, botGamesDat, onAdded = () => {}, log = console.error })` →
- `game(gistId) → Promise<{ gistId, source, inGallery }>`
- `submit(gistId, body) → Promise<{ ok: true, commitUrl, galleryUrl, site: null|string, botCopy: null|string } | { ok: false, error }>` — `site` and `botCopy` are null when written, else what went wrong

- [x] Tests with a fake repo and a temporary directory: a good submission commits once with `gifPath` `src/Gallery/gifs/<id>.gif` and the message from the spec, writes the GIF and edits `games_dat.js` in the site directory, edits the bot's copy, and calls `onAdded`; no `.tmp` file is left; a bad field or a gist already in master's list answers `{ ok: false }` and commits nothing; a failed commit leaves both directories untouched; a site directory without `Gallery/gifs` reports `site` and still edits the bot's copy; a site `games_dat.js` that already has the gist is reported, not duplicated; two submissions at once run one after the other; `game()` says whether the gist is in master's list.
- [x] Run `node --test test/gallery-submit.test.js test/gallery.test.js`; confirm the new cases fail.
- [x] Implement. Files are written to `<name>.tmp` and renamed. Submissions go through one promise chain. `galleryUrl` is `https://www.puzzlescript.net/Gallery/index.html`.
- [x] Run the tests again; confirm they pass.

## Task 4: The endpoints and the engine's path

Files: modify `discord-bot/http-server.js` and `discord-bot/test/http-server.test.js`.

Consumes: `createGallerySubmitter`'s `game` and `submit`.

Produces: `createHttpServer` options `gallery = null` (`{ ownerId, game, submit, engineDir }`); `GET /api/gallery/game`, `POST /api/gallery/submit`; static files of `engineDir` at `/gallery/engine/js/`.

- [x] Tests: both endpoints answer 404 when there is no gallery; 401 without a token, with a session token (no `kind`), with a gallery token of another uid, and with an expired one; `game` and `submit` are called with the token's `gistId` (never one from the body); a body over 3 MB answers 413; a `GalleryError` from `game` answers 400 with its message; `/gallery/engine/js/engine.js` serves from `engineDir` and `..` cannot leave it; without a gallery that path is 404.
- [x] Run `node --test test/http-server.test.js`; confirm the new cases fail.
- [x] Implement: `serveStatic` takes the roots to look in; the gallery block sits before the `/api/` 404.
- [x] Run the test again; confirm it passes.

## Task 5: Config, command and wiring

Files: modify `discord-bot/config.js`, `discord-bot/test/config.test.js`, `discord-bot/register-commands.js`, `discord-bot/bot.js`, `discord-bot/.env.example`, `discord-bot/README.md`.

Produces: `cfg.ownerUserId`, `cfg.galleryToken`, `cfg.gallerySiteDir` (null when unset), `cfg.gallery` (true when all three and the client secret are set).

- [x] Tests: the three settings default to null and `cfg.gallery` to false; all four set gives true; any one missing gives false.
- [x] Run `node --test test/config.test.js`; confirm the new case fails.
- [x] Implement the config. Register `admin_gallery` (one required string option `game`, no default member permissions) only when `cfg.gallery`. In `bot.js`: build the repo and submitter, pass `gallery` to the http server, make `games` reloadable through `onAdded`, and answer the command: refuse a user who is not the owner, refuse an unreadable gist id, else an ephemeral link `<public app url>gallery/#t=<token>`.
- [x] Document the three settings in `.env.example` and a "Gallery" section in the README (what the command does, the token's scope, the known limits from the spec).
- [x] Run `node --test`; confirm the whole suite passes.

## Task 6: The page

Files: create `discord-bot/activity/gallery/index.html`, `discord-bot/activity/gallery/main.js`, `discord-bot/scripts/check-gallery-browser.js`; modify `discord-bot/package.json` (`test:gallery-browser`).

Consumes: the two endpoints; the engine at `engine/js/` relative to the page.

- [x] Write the Chromium check first, in the manner of `check-workshop-browser.js`: the real http server with a fake `gallery` over a turn-based fixture (`sokoban_basic`) and a realtime one; open the page with a token in the fragment; the level picker lists the real levels; arrow keys recorded as a take; typing in the title field does not move the player and spaces are typed; Start again empties the take; winning a level closes the take with the winning input last; Make GIF yields a looping GIF whose size is the level's and which has more than one frame; the realtime take records ticks and its GIF has fewer frames than ticks plus moves; Submit posts the GIF, the edited fields and the token, and the page shows the links; a page opened without a token says so.
- [x] Run `npm run test:gallery-browser`; confirm it fails for want of the page.
- [x] Implement the page: `play.html`'s scripts from `engine/js/` plus `jsgif`, a 400 by 400 play area, the picker, the take line, Start again, Make GIF, the preview with its size, the three fields, Submit, and the outcome. `main.js` replaces `pushInput` and `clearInputHistory`, loads levels with `compile(['loadLevel', index], source, seed)`, and replays with `unitTesting` set and `processInput(input, true)`.
- [x] Run the check again; confirm it passes. Run `node --test`.

## Task 7: Review and delivery

- [x] Read the whole diff against the spec, section by section; fix what does not match.
- [x] Run `node --test` and both browser checks.
- [x] Report what is left for the owner: making the fine-grained token, setting the three variables on the server, confirming `~/sites/puzzlescript` there, running `node register-commands.js`, deploying.

Not checked here, and to be watched the first time it is used: the commit itself against the real GitHub API (only the reading half was run against it), the command in Discord, and whether master takes a direct commit from the token.
