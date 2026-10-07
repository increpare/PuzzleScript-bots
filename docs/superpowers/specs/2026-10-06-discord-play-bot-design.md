# PuzzleScript Discord play bot — design

Date: 2026-10-06
Status: approved in conversation, pending written review

## Goal

A Discord bot that lets people play a PuzzleScript game inside a text channel.
`/play <gist id or play URL> [level]` posts the current level as an image with
a row of buttons (move, action, undo, restart). Anyone in the channel can press
a button; the bot applies that input to completion (including every `again`
tick) and edits the message with the new frame. Realtime games are refused.

The bot runs on the user's Raspberry Pi (`box@192.168.178.69`, Ubuntu,
node 18, systemd) as a `systemd --user` service.

## Non-goals

- Realtime games (`realtime_interval`). Refused with a message.
- Sound. Ignored.
- Title screen. `/play` goes straight to a level.
- Level editor, checkpoints beyond what the engine does on its own.
- A public or multi-server bot. One Discord server, personal use. Slash
  commands are registered per guild.
- Level skipping buttons. `[level]` on `/play` covers starting elsewhere.

## Components

All code lives in `discord-bot/` in this repository, with its own
`package.json`. The only runtime dependency is `discord.js` v14. There are no
native modules, so it runs on the Pi unchanged. Engine source is loaded from
`../src/js` at startup, so the bot always runs the engine checked out beside it.

### `engine-host.js` — headless engine

Builds an engine inside a node `vm` context using the same file list and
browser shims as `src/tests/run_tests_node.js`, with `unitTesting = true` so
winning a level calls `nextLevel()` synchronously rather than via a timer.

API, all synchronous:

- `create()` → host. Loads and evaluates the engine files once per context.
- `host.load(source, seed, levelIndex)` → compiles, loads the level, drains
  `again`. Throws on compile error with the engine's error text. Returns
  metadata: `{title, author, levels, flags: {noaction, noundo, norestart,
  realtime}}`.
- `host.input(dir)` with `dir` in `0..4` (up, left, down, right, action).
  Calls `processInput(dir)` then drains `again` as the test harness does
  (`while (againing) { againing = false; processInput(-1); }`), with three
  additions described under "Again chains" below: the drain stops when a
  state repeats, pauses at a step cap, and is refused when it runs out of
  time.
- `host.undo()` → `DoUndo(false, true)`, `host.restart()` → `DoRestart()`.
- `host.continue()` → on a message screen, advances past it (same as pressing
  action in the engine: `processInput(4)` or `nextLevel()` as appropriate).
- `host.snapshot()` → plain data for the renderer and the embed:
  `{kind: 'level'|'message'|'finished', levelIndex, levelCount, width, height,
  cells: Uint8Array-ish per cell object ids, sprites: {id: {colors, dat}},
  background, textColor, message, viewport: {x, y, w, h}}`.
  Viewport applies `flickscreen` / `zoomscreen` using the same arithmetic as
  `redraw()` in `graphics.js`, centred on the player as the engine does.
  `finished` is reported when the engine has returned to the title screen
  after the last level.

The host never touches Discord. It is unit-tested on its own.

### `renderer.js` — PNG from a snapshot

- Level frames: each visible cell drawn from the 5×5 sprite matrices and
  palette colours, layers composited bottom-up, on `background_color`
  (default black). Integer upscale, centred on a fixed 400×300 canvas (matches Discord's embed placeholder size).
- Message frames: the message text wrapped and rendered with the engine's
  bitmap font (`src/js/font.js`) in `text_color` on `background_color`, with
  the same proportions as the in-game message screen.
- Finished frame: "finished" rendered the same way.
- PNG encoding via a minimal chunk writer over node's `zlib.deflateSync`.
  No image libraries.

### `games.js` — registry and persistence

- One record per Discord message: `{messageId, channelId, gistId, seed,
  startLevel, inputs: [...], status: 'playing'|'finished'|'dead', createdAt,
  updatedAt, metadata}`. Inputs are the same vocabulary as the test harness
  (`0..4`, `"undo"`, `"restart"`, `"continue"`).
- Live hosts kept in an LRU of 30. On a miss the record is rebuilt by
  `load` + replaying `inputs`.
- Each record is written to `data/games/<messageId>.json` after every
  accepted press. Records idle for 14 days are deleted on startup and daily.
- Per-game async queue so simultaneous presses apply in order.

### `gists.js` — source fetching

- Accepts a bare gist id, `play.html?p=<id>`, `editor.html?hack=<id>`, or a
  `gist.github.com/.../<id>` URL. Extracts a hex id; anything else is an
  error.
- Fetches `files["script.txt"].content` from `api.github.com/gists/<id>` with
  the token from `GITHUB_TOKEN`. Caches body and ETag in `data/gists/`.
  Serves from cache if younger than 10 minutes, otherwise revalidates with
  `If-None-Match`. Refuses bodies over 1 MB.

### `worker.js` — isolation and time limits

- A pool of 2 `worker_threads`, each owning engine hosts for many games.
- Compile has a 10 s deadline. Every other call may go at most 3 s without
  finishing a turn of the engine: the worker reports progress after each
  turn, and the main thread restarts its timer on each report. A worker that
  stays silent is terminated, the call in flight is rejected with
  `TimeoutError`, the other games it held are rebuilt by replay on their next
  press, and a fresh worker is started.
- A move's whole chain of `again` turns has a 20 s budget, checked by the
  host between turns (`MoveTooLongError`). The worker survives; only that
  game's half-played copy is discarded.
- Neither error ends the game: the move was never added to the input log, so
  the next press rebuilds the game from the log and carries on.
- Hosts live in `vm` contexts inside the worker, one per game, so engine
  globals never collide.

### `bot.js` — Discord

- discord.js client with no privileged intents (slash commands and buttons
  need none).
- `/play source:<string> level:<int, optional>`:
  1. `deferReply()`.
  2. Resolve source → gist id, fetch, `load` in a worker.
  3. On `realtime` flag: reply "realtime games can't be played here".
     On compile error: reply with the first error line.
  4. Render, post an embed (title, author, "Level n of m") with the PNG
     attached and the button rows. The message id becomes the game id.
- Buttons, custom ids `ps:<action>`:
  - Row 1: ⬅️ `left`, ⬆️ `up`, ⬇️ `down`, ➡️ `right`, ✖️ `action`
    (omitted when `noaction`).
  - Row 2: ↩️ `undo` (omitted when `noundo`), 🔄 `restart` (omitted when
    `norestart`).
  - Message screens show a single ▶️ `continue` button.
  - Finished or dead games have no buttons.
- Any member can press. On press: `deferUpdate()`, enqueue, apply, render,
  `editReply` with the new attachment and embed. Errors edit the embed with
  a short reason and remove the buttons.
- Startup: load all records from disk (no hosts yet); they rebuild lazily.

## Limits

| Limit | Value |
|---|---|
| Source size | 1 MB |
| Compile budget | 10 s |
| One turn of the engine | 3 s |
| One move's whole `again` chain | 20 s (60 s when replaying the input log) |
| `again` turns before a chain is paused | 1000 |
| Frames in one animation | 300 distinct, 16 MB captured, 4 MB encoded |
| Live games | 30 |
| Record retention | 14 days idle |
| Image size | 400×300 px |

## Again chains (added 2026-10-07)

A move can set off a chain of `again` turns. Three things can end the drain
besides the chain finishing, and only the third depends on timing:

1. **A state repeats.** The level, pending movements, level index and random
   generator state are hashed after each turn. A repeat means the chain would
   never end (an intentional looping animation, such as an explosion shown
   after losing). The drain stops there with the engine still wanting another
   turn; the snapshot reports `animating: 'loop'`.
2. **The step cap** (1000 turns). The drain pauses; the snapshot reports
   `animating: 'more'` and `continue` carries it on.
3. **The time budget.** The move is refused (see `worker.js`).

While a chain is still wanted (`animating` set), moves and action are ignored,
as the engine itself ignores them while `againing`; undo and restart work, and
the buttons offered are reduced to match. Because the first two stops depend
only on the game and its inputs, a game rebuilt from its log stops in the same
place.

**Animation.** For a live press the host keeps one frame per turn (a copy of
the level's object array; consecutive identical frames are merged). The worker
turns them into a GIF with one shared palette, each frame covering only the
pixels that changed, at the game's `again_interval` (150 ms by default, never
under 20 ms). A chain that ended plays once: the first frame is the final
state for one blink, so that a client showing a GIF as a still shows the right
board, then the turns, resting on the final state. That last frame is given
the longest delay a GIF allows (about eleven minutes), so a viewer that loops
regardless of the missing loop block still rests on it. A loop plays for ever. If
there are too many frames or colours, or encoding runs long, the still PNG is
sent instead.

## Configuration

`.env` on the Pi, never committed:

```
DISCORD_TOKEN=...
DISCORD_APP_ID=...
DISCORD_GUILD_ID=...
GITHUB_TOKEN=...
```

## Deployment

- `discord-bot/deploy.sh`: rsync `src/js/` and `discord-bot/` (excluding
  `node_modules`, `data`, `.env`) to `~/puzzlescript-bot/` on the Pi, run
  `npm ci --omit=dev`, `systemctl --user restart puzzlescript-bot`.
- `discord-bot/puzzlescript-bot.service`: a `systemd --user` unit, `Restart=on-failure`,
  `WorkingDirectory=%h/puzzlescript-bot/discord-bot`.
- Lingering (`loginctl enable-linger box`) so the service survives logout
  and reboot. If this needs sudo the user runs it.
- `register-commands.js`: registers `/play` for the guild in `.env`.
- Discord application created in the developer portal; the user pastes the
  bot token into `.env`. Invite URL scopes: `bot`, `applications.commands`.
  Permissions: Send Messages, Attach Files, Embed Links.

## Testing

- `engine-host` tests: replay a selection of sessions from
  `src/tests/resources/testdata.js` through the host and compare the final
  level string to the harness's expectation, proving the wrapper matches the
  harness. Also: realtime refusal, compile-error propagation, `noaction`
  flag detection, message-screen and finished-state detection.
- `renderer` tests: render demo games (Sokoban Basic, a flickscreen game,
  a zoomscreen game, a message level) and assert specific pixel colours at
  known coordinates, plus PNG validity by decoding the header and checking
  the CRCs.
- `gists` tests: id extraction from each accepted form; cache hit, stale
  revalidate, oversize refusal, using a stubbed fetch.
- `games` tests: persistence round trip, replay after eviction, queue
  ordering.
- Manual end-to-end: `/play` Microban in the server's play channel.

Tests run with `node --test discord-bot/test`.

## Open points, decided

- Anyone can press: yes.
- Start level option: yes. Skip buttons: no.
- Service: `systemd --user`.
- Gist source: GitHub API with a token.
- Channel restriction: none in code. Discord channel permissions decide
  where the bot can post.
