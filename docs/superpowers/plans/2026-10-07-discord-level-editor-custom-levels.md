# Discord level editor, part 2: custom levels, end to end — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pressing the pencil under a game opens a page with that level as text; pressing Send there posts the edited level to the game's thread as a new game anyone can play, replay and tweak again.

**Architecture:** This is the whole path with the simplest possible editor, a text box, so that every piece behind it is real and tested before the canvas editor is built: the level store, games that run on a stored level, the thread and the post, the sign-in session, the signed ticket that says what is being edited, and the api. Part 3 replaces the text box with the engine's own editor and changes nothing behind it.

**Tech Stack:** Node 18+ compatible (24 on the server), discord.js 14.27, node's `http` and `crypto`, `node:test`.

**Spec:** `docs/superpowers/specs/2026-10-07-discord-level-editor-design.md` (build steps 3 and 5; step 4, the canvas editor, is part 3).

## Global Constraints

- No new runtime dependencies.
- PuzzleScript master is not changed. Anything needed from the engine is wrapped from this repository.
- The pencil appears only where `TWEAK_CHANNEL_IDS` allows (the private `#mapeditor-test` channel during the beta).
- Limits, from the spec: level text 10,000 characters; level size 100 × 100 cells; 10 levels sent per user an hour; pending tweak 15 minutes; session and ticket 24 hours; level store 5 MB, after which new levels are refused; request body 64 KB.
- Solving a custom level gives no rank credit.
- Send never changes the game that was tweaked.
- A sent level is a new game message in the thread. There is no separate card.
- Secrets are never logged. Reports and logs hold no user names beyond what the spec says is stored.
- Tests: `cd discord-bot && npm test`. Style as the existing code: `'use strict'`, two spaces, comments that say why.
- Commit after each task on `discord-level-editor`, ending messages with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- The code is written test-first by the author of this plan while executing it, so tasks give interfaces, behaviour and the tests to write rather than a second copy of the code.

## File structure

| File | Responsibility |
|---|---|
| `activity/level-text.js` (new) | `levelToText()`: the level in the engine's memory as glyph text. Runs in the engine's own global scope, in the browser and in the bot's engine host. |
| `engine-host.js`, `worker-ops.js`, `pool.js` | A `levelText` operation, so the bot can ask for a level's starting layout as text. |
| `levels.js` (new) | Level text rules (`checkLevelText`, `levelId`), `splice(source, text)`, and the level store. |
| `games.js` | Games on a stored level; `again(gameId)`. |
| `signing.js` (new) | Signed, expiring tokens (sessions and tickets). |
| `tweaks.js` | Adds the pending-tweak map to the channel rules already there. |
| `threads.js` (new) | Which thread holds the levels of which game in which channel. |
| `level-posts.js` (new) | The Send path: check, compile, store, find or start the thread, post the game. Discord is injected, so it is tested with fakes. |
| `presentation.js` | A custom level's embed and its solved state. |
| `http-server.js` | Sessions, `GET /api/tweak`, `POST /api/levels`. The spike's routes go. |
| `activity/index.html`, `activity/app.js` | The text-box page. `activity/spike.js` goes. |
| `bot.js` | Wiring: pending tweak on a pencil press, Play again, solvers. |
| `legal/puzzlescriptbot_privacy.html` | Says what is now stored. |

---

### Task 1: A level as text, from the engine

**Files:** create `activity/level-text.js`, `test/level-text.test.js`; modify `engine-host.js`, `worker-ops.js`, `pool.js`.

**Interfaces — produces:**
- In the engine's scope: `levelToText() → string`. Rows joined by `\n`, one glyph per cell, chosen by the engine's own `matchGlyph` as `printLevel` does (single-character legend names only; for each, the mask with the background layer cleared and the full mask). Throws `Error('no glyph for a cell')` when `matchGlyph` cannot place one, instead of printing a `.` as upstream does.
- `host.levelText() → string` (the engine host evaluates `activity/level-text.js` after the engine files).
- Worker op `levelText`; `pool.levelText(gameId) → Promise<string>`.

**Tests (`test/level-text.test.js`):**
- Sokoban Basic, level 0: `host.levelText()` equals the first level's rows as written in the demo file.
- Round trip on five demos (`sokoban_basic`, `microban`, `coincounter`, `2048`, `atlasshrugged` or whichever five compile): for the first real level, text → `splice` is not yet available, so compare shape only here: the row count and row length equal the snapshot's `height` and `width`.
- After a move, `levelText()` reflects the moved state (it reads the live level).
- `pool.levelText` returns the same text through a worker.

- [ ] Write the tests; run; see them fail.
- [ ] Implement; run; pass. Whole suite passes.
- [ ] Commit: `discord-bot: a level as glyph text, from the engine`.

### Task 2: Level text rules and splice

**Files:** create `levels.js`, `test/levels.test.js`.

**Interfaces — produces:**
- `checkLevelText(text) → { ok: true, text } | { ok: false, error }`. Normalises line endings, trims trailing spaces on each row, drops blank lines at the start and end. Refuses, with a sentence for the player: empty; over 10,000 characters; a blank line inside (more than one level); a row starting with `message` (case-insensitive); more than 100 rows or a row over 100 characters; rows of different lengths; a `(` or `)` anywhere (a comment would swallow rows).
- `levelId(gistId, text) → string`: first 10 hex digits of SHA-256 over `gistId + '\n' + text.toLowerCase()`.
- `splice(source, levelText) → string`: the source up to and including its `LEVELS` header line (and a row of `=` directly under it), then a blank line, the level, and a newline. Throws `CompileError`-named error `'game has no LEVELS section'` if there is none.
- The header is found outside comments. Comments are `( … )`, nest, and span lines. Text after a `message` word on a line is not scanned for comments, as in the parser (`message :(` must not open one). Once the header is found nothing after it is read.

**Tests:**
- `checkLevelText`: each refusal; `\r\n` input; trailing spaces; a valid level comes back normalised.
- `levelId`: same for different case and for the same text; different for another gist.
- `splice` on a hand-written source: header in mixed case; with and without the `=` row; the word `levels` inside a comment before the real header; a multi-line comment containing `LEVELS`; a rule `message` with an unbalanced `(` before the header.
- `splice` against the engine: for every demo in `puzzlescript/src/demo` that compiles, splicing in that game's own first level (from `host.levelText()`) gives a source that compiles to exactly one level whose cells equal the original's. (One host, reused; skip demos that do not compile as they are.)

- [ ] Tests first; fail; implement; pass; suite passes.
- [ ] Commit: `discord-bot: level text rules, and splicing one level into a game`.

### Task 3: The level store

**Files:** modify `levels.js`, `test/levels.test.js`.

**Interfaces — produces:** `createLevelStore({ dataDir, maxBytes = 5_000_000, now = Date.now }) → { get(id), add(record), setPost(id, { channelId, threadId, messageId }), addSolver(id, { id, name }) }`.
- Record: `{ id, gistId, baseSourceHash, text, authorId, authorName, createdAt, channelId, threadId, messageId, solvedBy: [{ id, name }] }`, one JSON file each in `data/levels/`, written by rename.
- `add` returns the stored record. If the id exists it returns the existing record unchanged. If adding would pass `maxBytes` it throws an error named `LevelStoreFullError`.
- `addSolver` adds a solver once (by id), keeps at most 50, and returns the record. Names are cut to 80 characters.
- `get` validates the id shape (`/^[0-9a-f]{10}$/`) and returns `null` for anything else or a missing file.

**Tests:** round trip through a fresh store on the same directory; duplicate add; the cap; solver added once; bad ids.

- [ ] Tests first; fail; implement; pass.
- [ ] Commit: `discord-bot: a store for sent levels`.

### Task 4: Games on a stored level

**Files:** modify `games.js`, `test/games.test.js`.

**Interfaces — consumes:** `splice`, the level store. **Produces:**
- `createRegistry({ …, levels })` (the level store; optional, so existing callers and tests are unaffected).
- `start({ gameId, channelId, gistId, startLevelNumber, level })`: with `level` (a level record) the source is `splice(base, level.text)`, where base is the stored source `level.baseSourceHash` or, if that is gone, the gist as it is now. The record gains `levelId`. `startLevelNumber` is ignored.
- Rebuild (`ensureLive`) for a record with `levelId`: stored spliced source by `sourceHash` if present; otherwise re-splice from the level record. A different hash is accepted and recorded (the base game changed). A `CompileError` then stops the game with `this level no longer works with the current version of the game`. A missing level record stops it with `this level is no longer available`.
- `again(gameId)`: for a finished game with a `levelId`, empties the input log, sets it playing, loads it afresh and returns `{ record, snapshot }`. For any other game it returns `{ record, snapshot, applied: false }` without change.
- `press` is unchanged; it already reports `solvedLevel`.

**Tests:** a game on a level of Sokoban plays and finishes when solved (a one-move level: `#####\n#P*O#\n#####` with Sokoban Basic's legend, checked against that demo's glyphs); it survives eviction and rebuild; rebuild after the spliced source has been evicted from the source store; base changed so that it no longer compiles; `again` after finishing, and `again` on a normal game.

- [ ] Tests first; fail; implement; pass; suite passes.
- [ ] Commit: `discord-bot: games that run on a stored level, and playing one again`.

### Task 5: Signed tokens, pending tweaks, threads

**Files:** create `signing.js`, `threads.js`, `test/signing.test.js`, `test/threads.test.js`; modify `tweaks.js`, `test/tweaks.test.js`.

**Interfaces — produces:**
- `createSigner(key: Buffer|string, { now = Date.now } = {}) → { sign(payload: object, ttlMs) → string, verify(token) → object | null }`. Token: base64url of JSON `{ p: payload, e: expiry }`, a dot, base64url HMAC-SHA-256. `verify` returns the payload, or `null` if malformed, altered or expired; the comparison is constant-time.
- `signingKey(discordToken) → Buffer`: HMAC-SHA-256 of the fixed string `psbot-tweak-v1` keyed by the bot token, so no new secret is needed and the token itself is never used directly.
- `createPending({ ttlMs = 15 * 60 * 1000, now = Date.now, max = 1000 }) → { set(userId, entry), get(userId) }`. Newest wins; expired entries are forgotten; at `max` users the oldest is dropped.
- `createThreadIndex({ dataDir }) → { get(channelId, gistId) → threadId | null, set(channelId, gistId, threadId) }`, kept in `data/threads.json`, written by rename.

**Tests:** sign and verify; expiry; any altered character refused; a token signed with another key refused; garbage refused. Pending: newest wins, expiry, the cap. Threads: round trip across instances; a corrupt file is treated as empty.

- [ ] Tests first; fail; implement; pass.
- [ ] Commit: `discord-bot: signed sessions and tickets, pending tweaks, and the thread index`.

### Task 6: Presentation of a custom level

**Files:** modify `presentation.js`, `test/presentation.test.js`.

**Interfaces — produces:**
- `buildEmbed({ record, snapshot, attachmentName, level })`: with `level`, the title is `<game> — level by <author>`; the description is the level text in a code block when it is at most 900 characters, otherwise `Level text attached.`; the footer is `Custom level` (with `(Last move: …)` as now) while playing, and `Solved by A, B and C` when finished (`Solved` alone if the list is empty; at most ten names, then `and N more`).
- `buildComponents(snapshot, meta, { tweak, again })`: for `snapshot.kind === 'finished'` with `again`, one row: 🔁 `ps:again`, and ✏️ `ps:tweak` when `tweak`. Otherwise as now.
- `parseCustomId('ps:again') === 'again'`.
- `levelFile(level) → { name: 'level.txt', data: Buffer } | null`: the attachment for a level whose text is too long for the embed.

**Tests:** each of the above, including Markdown in an author's name not breaking the title (names are shown as text: backticks and asterisks escaped), and a level text containing a backtick fence being attached rather than embedded.

- [ ] Tests first; fail; implement; pass.
- [ ] Commit: `discord-bot: how a custom level and its solved state are shown`.

### Task 7: The Send path

**Files:** create `level-posts.js`, `test/level-posts.test.js`.

**Interfaces — consumes:** `checkLevelText`, `levelId`, `splice`, the level store, `registry.start`, `pool.load/levelText/drop`, the source store, `getSource`, the thread index. **Produces:**
`createLevelPoster({ registry, levels, pool, sources, getSource, threads, discord, frame, now = Date.now, perHour = 10 }) → { textFor(pending) → Promise<{ title, levelText }>, submit({ ticket, text }) → Promise<{ ok: true, url } | { ok: false, error }> }`.
- `discord` is the only way it touches Discord: `{ channel(id) → Promise<channel>, guildId }`, where a channel offers what discord.js offers (`isThread()`, `parentId`, `threads.fetch(id)`, `threads.create({ name })`, `messages.fetch(id)`, `send(payload)`), a message offers `startThread({ name })`, `edit(payload)`, `id`. Tests pass fakes.
- `frame(record, snapshot, level)` builds the message payload (the bot's own `frame`).
- `textFor(pending)`: for a pending tweak of a stored level, its text; otherwise the level's starting layout, by loading the game's stored source at `levelIndex` under a scratch id and asking for `levelText`.
- `submit`: in order — rate limit (`perHour` per `ticket.uid`, counted only for levels actually posted); `checkLevelText`; the base source (stored by `ticket.baseSourceHash`, else the gist); compile the spliced source under a scratch id (a `CompileError` answers `that level does not compile: <first error>`; more than one level, or a level over 100 × 100, is refused); `levels.add`; if the level already has a post, answer with its link; find the thread (the ticket's channel if that is a thread; else the indexed thread if it still exists; else start one on the tweaked game's message, named `Levels: <game>` cut to 100 characters, or on its own if that fails); send a placeholder, start the game with the placeholder's id as the game id, edit the placeholder into the game; `levels.setPost`; answer with `https://discord.com/channels/<guild>/<thread>/<message>`.
- Any failure after the placeholder is sent removes nothing but edits the placeholder to say the level could not be started.

**Tests (fakes for Discord; real pool, registry and stores):** a good level is posted into a new thread and is playable through `registry.press`; a second level for the same game goes to the same thread; a tweak made inside a thread posts there; the indexed thread having gone starts a new one; the same level twice answers with the first link and posts nothing; a level that does not compile; two levels in one text; the rate limit; the store being full.

- [ ] Tests first; fail; implement; pass; suite passes.
- [ ] Commit: `discord-bot: sending a level posts it to the game's thread as a new game`.

### Task 8: The api

**Files:** modify `http-server.js`, `test/http-server.test.js`.

**Interfaces — produces:** `createHttpServer({ staticDir, oauth, signer, api, log })`, where `api = { tweak(uid) → Promise<object | null>, submit(uid, body) → Promise<object> }`.
- `POST /api/token {code}` → `{ access_token, session }`; `session = signer.sign({ uid }, 24 h)`.
- `GET /api/tweak`, `POST /api/levels`: need `authorization: Bearer <session>`; without a valid one, 401 `{ error: 'sign in again' }`. `tweak` answers 404 `{ error: 'nothing to edit' }` when `api.tweak` gives `null`.
- The spike's `/api/ping` and `/api/spike-report`, `onReport`, and the `/.proxy` stripping are removed (the spike found Discord strips the prefix itself).

**Tests:** replace the spike route tests; add the session cases (missing, altered, expired, valid), and that the `uid` the api sees is the session's.

- [ ] Tests first; fail; implement; pass.
- [ ] Commit: `discord-bot: sessions, and the api for fetching and sending a level`.

### Task 9: The text-box page

**Files:** replace `activity/index.html`; create `activity/app.js`; delete `activity/spike.js`.

**Behaviour:** the page signs in as the spike did (SDK `ready`, `authorize` with `identify`, `POST api/token`, `authenticate`), then `GET api/tweak`. It shows the game's title, the level in a monospaced text box, and Send. Send posts `{ ticket, text }` to `api/levels` and shows either `Sent.` with a link opened through `sdk.commands.openExternalLink`, or the error under the box, leaving the text as it was. With nothing to edit it says to press the pencil under a game. Outside Discord it says it only works inside Discord. No game engine is loaded yet.

- [ ] Write the page.
- [ ] Check it loads outside Discord and shows the "only works inside Discord" message (local server as in part 1, Task 7, Step 5).
- [ ] Commit: `discord-bot: the first editor page, a text box`.

### Task 10: Wiring, the privacy page, and a try in the test channel

**Files:** modify `bot.js`, `README.md`, `legal/puzzlescriptbot_privacy.html`.

**bot.js:**
- Build the level store, thread index, signer (`signingKey(cfg.discordToken)`), pending map and level poster; pass `levels` to the registry; give the http server `signer` and `api`.
- `frame(record, snapshot, gif, tweak)` looks up the record's level and passes it to `buildEmbed`; components for a finished custom level are `{ tweak, again: true }`; the level's text file is attached when `levelFile` gives one.
- Pencil press: record `pending.set(user.id, { gistId, sourceHash, levelIndex | levelId, gameId, channelId, authorName })` and answer with `launchActivity()`. For a game on a stored level, `levelId` is the record's; otherwise `levelIndex` is `record.cur.levelIndex`.
- `api.tweak(uid)`: the pending entry → `poster.textFor` → `{ title, levelText, ticket }`, the ticket signed for 24 hours with `{ uid, gistId, baseSourceHash, channelId, gameId, authorName }`.
- `api.submit(uid, body)`: verify the ticket and that its `uid` is the session's; then `poster.submit`.
- `ps:again`: `registry.again`, then edit the message.
- On a solved level of a game with `levelId`: `levels.addSolver` and no `scores.credit`.

**Privacy page:** add to "What the bot keeps": levels you send, with your Discord user id and display name, shown on the level; and the display names and ids of people who solve a sent level, shown on it. Update the date. The user uploads it again.

- [ ] Wire it; `node --check bot.js`; suite passes.
- [ ] Deploy; in `#mapeditor-test`: pencil → edit the text → Send → the level appears in a thread → solve it → Play again → pencil on it → Send a variant. Then on a phone.
- [ ] Commit: `discord-bot: tweak a level as text and send it to the game's thread`.
