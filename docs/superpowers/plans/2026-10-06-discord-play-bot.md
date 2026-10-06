# Discord Play Bot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Discord bot that plays a PuzzleScript game in a text channel: `/play <gist>` posts the level as a PNG with move/action/undo/restart buttons; any press applies the input (draining `again`) and edits the message with the new frame.

**Architecture:** The engine runs headlessly inside node `vm` contexts hosted in a small pool of worker threads with hard time budgets. Each game is a seed plus an input log, persisted as JSON and rebuilt by replay when not live. A dependency-free renderer draws frames from sprite matrices and the engine's bitmap font and encodes PNG with zlib. A thin discord.js layer maps slash commands and button presses onto the registry.

**Tech Stack:** Node 18 (the Pi's version), `node:test`, `node:vm`, `node:worker_threads`, `node:zlib`, discord.js v14. No native modules.

**Spec:** `docs/superpowers/specs/2026-10-06-discord-play-bot-design.md`

## Global Constraints

- Node 18 compatible: no `fetch` typings tricks beyond what node 18 ships (global `fetch` exists in node 18), no `Array.prototype.toSorted`, no `structuredClone` of functions.
- Only runtime dependency: `discord.js` `^14`. Dev dependencies: none (use `node --test`).
- Engine files are loaded from `../src/js` relative to `discord-bot/`, using the same file list and shims as `src/tests/run_tests_node.js`.
- Limits (from spec): source 1 MB, compile budget 10 s, input budget 3 s, 30 live games, records pruned after 14 days idle, images at most 800 px on the longer side.
- Input vocabulary everywhere: `'up'|'left'|'down'|'right'|'action'|'undo'|'restart'|'continue'`. Direction codes for the engine: up 0, left 1, down 2, right 3, action 4.
- Secrets only in `discord-bot/.env` (never committed). Keys: `DISCORD_TOKEN`, `DISCORD_APP_ID`, `DISCORD_GUILD_ID`, `GITHUB_TOKEN`.
- Commit messages end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- All commands run from the worktree root `/Users/stephenlavelle/Documents/GitHub/PuzzleScript/.claude/worktrees/discord-bot` unless stated.
- After every task also run the engine suite to prove the engine is untouched: `cd src && node tests/run_tests_node.js` must report 0 failed.

## File Structure

```
discord-bot/
  package.json            name, scripts {test, start, register}, dependency discord.js
  .gitignore              node_modules/ data/ .env
  .env.example            documented keys, no values
  README.md               setup, deploy, usage
  engine-host.js          headless engine in a vm context (sync API)
  png.js                  PNG encoder (RGBA buffer → PNG bytes)
  renderer.js             snapshot → RGBA buffer → PNG
  gists.js                source resolution + GitHub fetch + disk cache
  worker.js               worker thread entry; hosts many engine-hosts
  pool.js                 main-thread worker pool with deadlines (async API)
  games.js                registry: records, persistence, LRU, replay, queues
  presentation.js         pure functions: embed + button rows from a snapshot
  bot.js                  discord.js client wiring
  register-commands.js    registers /play for the guild
  deploy.sh               rsync to the Pi + restart service
  puzzlescript-bot.service   systemd --user unit
  test/
    engine-host.test.js
    png.test.js
    renderer.test.js
    gists.test.js
    pool.test.js
    games.test.js
    presentation.test.js
    fixtures/
      two-level-random.txt   tiny game: level 1 trivially won, level 2 uses random
      message-game.txt       tiny game with a message level and an in-rule message
```

Responsibilities: `engine-host` knows the engine and nothing else. `renderer` knows snapshots and pixels. `pool`/`worker` know threads and deadlines. `games` knows records and replay. `presentation` knows Discord's embed/button shapes but not the client. `bot` glues.

---

### Task 1: Package scaffold and test harness

**Files:**
- Create: `discord-bot/package.json`, `discord-bot/.gitignore`, `discord-bot/.env.example`, `discord-bot/test/smoke.test.js`

**Interfaces:**
- Produces: `npm test` inside `discord-bot/` runs `node --test test/`.

- [ ] **Step 1: Write the smoke test**

```js
// discord-bot/test/smoke.test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

test('engine sources are reachable from discord-bot', () => {
  const enginePath = path.join(__dirname, '..', '..', 'src', 'js', 'engine.js');
  assert.ok(fs.existsSync(enginePath), 'expected ../src/js/engine.js to exist');
});
```

- [ ] **Step 2: Run it to verify it fails (no package yet)**

Run: `cd discord-bot && node --test test/`
Expected: error that `discord-bot` directory or test cannot be found (the directory does not exist yet, so the `cd` fails). That failure is the point: nothing is scaffolded.

- [ ] **Step 3: Create the package files**

```json
// discord-bot/package.json
{
  "name": "puzzlescript-discord-bot",
  "version": "0.1.0",
  "private": true,
  "description": "Play PuzzleScript games inside Discord",
  "main": "bot.js",
  "engines": { "node": ">=18" },
  "scripts": {
    "test": "node --test test/",
    "start": "node bot.js",
    "register": "node register-commands.js"
  },
  "dependencies": {
    "discord.js": "^14.16.3"
  }
}
```

```
# discord-bot/.gitignore
node_modules/
data/
.env
```

```
# discord-bot/.env.example
# Discord bot token from the developer portal (Bot → Reset Token)
DISCORD_TOKEN=
# Application ID from the developer portal (General Information)
DISCORD_APP_ID=
# The server the /play command is registered in (right-click server → Copy Server ID)
DISCORD_GUILD_ID=
# GitHub personal access token, no scopes needed, for the gists API
GITHUB_TOKEN=
```

- [ ] **Step 4: Install and run the test**

Run: `cd discord-bot && npm install && npm test`
Expected: `# pass 1`, `# fail 0`. `package-lock.json` is created; keep it (it is committed so the Pi gets identical versions via `npm ci`).

- [ ] **Step 5: Commit**

```bash
git add discord-bot/package.json discord-bot/package-lock.json discord-bot/.gitignore discord-bot/.env.example discord-bot/test/smoke.test.js
git commit -m "discord-bot: scaffold package and test harness

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Headless engine host — load and snapshot

**Files:**
- Create: `discord-bot/engine-host.js`, `discord-bot/test/engine-host.test.js`

**Interfaces:**
- Produces:
  - `createHost() → Host`
  - `Host.load(source: string, seed: string, levelIndex: number) → Meta` where `Meta = {title: string, author: string, levelCount: number, flags: {noaction: boolean, noundo: boolean, norestart: boolean, realtime: boolean}}`. Throws `CompileError` (has `.message` = first engine error text).
  - `Host.snapshot() → Snapshot` where `Snapshot = {kind: 'level'|'message'|'finished', levelIndex, levelCount, width, height, cells: number[][] (per cell index = x*height + y, object ids ascending), sprites: {[id]: {colors: string[], dat: number[][]}}, background: '#rrggbb', textColor: '#rrggbb', message: string|null, viewport: {x, y, w, h}}`.
  - `Host.levelString() → string` (test aid; the engine's `convertLevelToString()`).
  - `Host.dispose()`.
- Consumes: engine files from `../src/js`.

Background on the engine (read this before coding): The engine is a pile of globals. `compile(["loadLevel", n], source, seed)` compiles and loads level `n`. `state.levels[i]` is either a level or `{message: "..."}`. Loading a message level sets `textMode = true`; loading a real level clones it into `level`. `level.objects` is an `Int32Array` of `STRIDE_OBJ` 32-bit words per cell; bit `k` of the cell means object id `k` is present; `state.idDict[k]` is its name; `state.objects[name]` has `colors`, `spritematrix` (5 rows × 5 ints, −1 = transparent), `layer`, `id`. Ids are assigned in collision-layer order, so drawing ids ascending draws layers bottom-up. `state.bgcolor` / `state.fgcolor` are hex strings. `state.playerMask` is a `BitVec`; `cell.anyBitsInCommon(playerMask)` finds the player. `titleScreen === true` means the game has returned to the title (after the last level). `unitTesting = true` makes `checkWin()` call `nextLevel()` synchronously. The viewport logic to copy is `redraw()` in `src/js/graphics.js` lines ~340–380 (flickscreen pages, zoomscreen centres on the player, both fall back to `oldflickscreendat`).

- [ ] **Step 1: Write failing tests for load and snapshot**

```js
// discord-bot/test/engine-host.test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { createHost, CompileError } = require('../engine-host');

const DEMO = (name) => fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'demo', name), 'utf8');
const SOKOBAN = DEMO('sokoban_basic.txt');

test('load returns metadata and flags', () => {
  const host = createHost();
  const meta = host.load(SOKOBAN, 'seed', 0);
  assert.equal(meta.title, 'Simple Block Pushing Game');
  assert.equal(meta.author, 'David Skinner');
  assert.ok(meta.levelCount >= 1);
  assert.deepEqual(meta.flags, { noaction: false, noundo: false, norestart: false, realtime: false });
  host.dispose();
});

test('snapshot of a level exposes cells, sprites and colours', () => {
  const host = createHost();
  host.load(SOKOBAN, 'seed', 0);
  const s = host.snapshot();
  assert.equal(s.kind, 'level');
  assert.equal(s.levelIndex, 0);
  assert.ok(s.width > 0 && s.height > 0);
  assert.equal(s.cells.length, s.width * s.height);
  assert.equal(s.background, '#000000');
  assert.equal(s.textColor, '#ffffff');
  assert.deepEqual(s.viewport, { x: 0, y: 0, w: s.width, h: s.height });
  // every cell has at least the background object
  for (const ids of s.cells) assert.ok(ids.length >= 1);
  // a sprite looks like a 5x5 matrix with colours
  const anyId = s.cells[0][0];
  assert.equal(s.sprites[anyId].dat.length, 5);
  assert.equal(s.sprites[anyId].dat[0].length, 5);
  assert.ok(Array.isArray(s.sprites[anyId].colors));
  host.dispose();
});

test('compile errors throw CompileError with the engine message', () => {
  const host = createHost();
  assert.throws(
    () => host.load('title broken\n\n=======\nOBJECTS\n=======\n\nPlayer\nred\n\n=======\nLEGEND\n=======\n\nP = Player\n\n=======\nRULES\n=======\n\n[ > Player | Wall ] -> [ > Player | > Wall ]\n', 'seed', 0),
    (err) => err instanceof CompileError && /Wall|unknown|not defined|undefined/i.test(err.message)
  );
  host.dispose();
});

test('realtime games are flagged', () => {
  const host = createHost();
  const src = 'title rt\nrealtime_interval 0.1\n\n=======\nOBJECTS\n=======\n\nBackground\nblack\n\nPlayer\nred\n\n=======\nLEGEND\n=======\n\n. = Background\nP = Player\n\n================\nCOLLISIONLAYERS\n================\n\nBackground\nPlayer\n\n=======\nLEVELS\n=======\n\nP..\n';
  const meta = host.load(src, 'seed', 0);
  assert.equal(meta.flags.realtime, true);
  host.dispose();
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd discord-bot && npm test`
Expected: FAIL, `Cannot find module '../engine-host'`.

- [ ] **Step 3: Implement engine-host.js (load, snapshot, dispose)**

```js
// discord-bot/engine-host.js
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC_DIR = path.join(__dirname, '..', 'src');
const ENGINE_FILES = [
  'js/storagewrapper.js', 'js/bitvec.js', 'js/level.js', 'js/languageConstants.js',
  'js/globalVariables.js', 'js/debug.js', 'js/font.js', 'js/rng.js', 'js/riffwave.js',
  'js/sfxr.js', 'js/codemirror/stringstream.js', 'js/colorhelpers.js', 'js/colors.js',
  'js/engine.js', 'js/parser.js', 'js/compiler.js', 'js/soundbar.js',
];
const AGAIN_LIMIT = 10000;

class CompileError extends Error {}
class EngineError extends Error {}

let engineScript = null;
function getEngineScript() {
  if (engineScript === null) {
    let code = '';
    for (const file of ENGINE_FILES) {
      code += `\n// ---- ${file} ----\n` + fs.readFileSync(path.join(SRC_DIR, file), 'utf8') + '\n';
    }
    engineScript = new vm.Script(code, { filename: 'puzzlescript-engine.js' });
  }
  return engineScript;
}

function makeSandbox() {
  const storage = {};
  const noop = () => {};
  const sandbox = {
    console: { log: noop, warn: noop, error: noop },
    localStorage: {
      getItem(k) { return Object.prototype.hasOwnProperty.call(storage, k) ? storage[k] : null; },
      setItem(k, v) { storage[k] = String(v); },
      removeItem(k) { delete storage[k]; },
    },
    document: {
      URL: 'discord://',
      body: { classList: { contains() { return false; } }, addEventListener: noop, removeEventListener: noop },
      createElement() { return { style: {}, innerHTML: '', textContent: '', getContext() { return null; } }; },
      getElementById() { return null; },
    },
    lastDownTarget: null,
    canvas: null,
    canvasResize: noop, redraw: noop, forceRegenImages: noop, consolePrintFromRule: noop,
    consolePrint: noop, console_print_raw: noop, consoleError: noop, consoleCacheDump: noop,
    addToDebugTimeline: noop, killAudioButton: noop, showAudioButton: noop, regenSpriteImages: noop,
    jumpToLine: noop, printLevel: noop, playSound: noop,
    levelString: '', inputString: '', outputString: '',
    PuzzleScriptTestAssertions: { push: noop, equal: noop },
    UnitTestingThrow(error) { throw error; },
    setTimeout: noop, clearTimeout: noop, performance: { now: () => Date.now() },
  };
  sandbox.window = sandbox;
  sandbox.input = sandbox.document.createElement('TEXTAREA');
  sandbox.editor = { getValue() { return sandbox.levelString; } };
  return sandbox;
}

function hexColor(c) {
  return String(c).toLowerCase();
}

function createHost() {
  const ctx = vm.createContext(makeSandbox());
  getEngineScript().runInContext(ctx);
  ctx.stripHTMLTags = (s) => s.replace(/<\/?[a-zA-Z][^>]*>/g, '').trim();
  ctx.unitTesting = true;
  ctx.lazyFunctionGeneration = false;

  // Make every level load deterministic from the game seed. The engine
  // generates a Math.random()-based seed when none is passed (nextLevel,
  // checkpoint restores); we route all of those through the game seed.
  let gameSeed = 'seed';
  const origLoadLevelFromLevelDat = ctx.loadLevelFromLevelDat;
  ctx.loadLevelFromLevelDat = function (state, leveldat, randomseed, clearinputhistory) {
    if (!randomseed) randomseed = gameSeed + ':' + ctx.curlevel;
    return origLoadLevelFromLevelDat(state, leveldat, randomseed, clearinputhistory);
  };

  function resetErrors() {
    if (typeof ctx.resetParserErrorState === 'function') ctx.resetParserErrorState();
    else { ctx.errorStrings = []; ctx.errorCount = 0; }
  }

  function firstError() {
    const s = (ctx.errorStrings && ctx.errorStrings[0]) || 'unknown compile error';
    return ctx.stripHTMLTags(String(s));
  }

  function load(source, seed, levelIndex) {
    gameSeed = String(seed);
    resetErrors();
    try {
      ctx.compile(['loadLevel', levelIndex | 0], source, gameSeed + ':' + (levelIndex | 0));
    } catch (e) {
      throw new CompileError(ctx.errorCount > 0 ? firstError() : String(e && e.message || e));
    }
    if (ctx.errorCount > 0) throw new CompileError(firstError());
    if (!ctx.state || !ctx.state.levels || ctx.state.levels.length === 0) throw new CompileError('game has no levels');
    drainAgain();
    const md = ctx.state.metadata || {};
    return {
      title: md.title || 'untitled',
      author: md.author || '',
      levelCount: ctx.state.levels.length,
      flags: {
        noaction: 'noaction' in md,
        noundo: 'noundo' in md,
        norestart: 'norestart' in md,
        realtime: md.realtime_interval !== undefined,
      },
    };
  }

  function drainAgain() {
    let n = 0;
    while (ctx.againing) {
      ctx.againing = false;
      ctx.processInput(-1);
      if (++n > AGAIN_LIMIT) throw new EngineError('again loop did not terminate');
    }
  }

  function findPlayer() {
    const level = ctx.level;
    const mask = ctx.state.playerMask;
    const probe = new ctx.BitVec(ctx.STRIDE_OBJ);
    for (let i = 0; i < level.n_tiles; i++) {
      level.getCellInto(i, probe);
      if (probe.anyBitsInCommon(mask)) return { x: (i / level.height) | 0, y: i % level.height };
    }
    return null;
  }

  function viewport() {
    const level = ctx.level;
    const md = ctx.state.metadata;
    const full = { x: 0, y: 0, w: level.width, h: level.height };
    const ofd = ctx.oldflickscreendat || [];
    const fallback = ofd.length === 4 ? { x: ofd[0], y: ofd[1], w: ofd[2] - ofd[0], h: ofd[3] - ofd[1] } : full;
    if (md.flickscreen !== undefined) {
      const sw = Math.min(md.flickscreen[0], level.width), sh = Math.min(md.flickscreen[1], level.height);
      const p = findPlayer();
      if (p === null) return fallback;
      const sx = (p.x / sw) | 0, sy = (p.y / sh) | 0;
      const x = sx * sw, y = sy * sh;
      return { x, y, w: Math.min(sw, level.width - x), h: Math.min(sh, level.height - y) };
    }
    if (md.zoomscreen !== undefined) {
      const sw = Math.min(md.zoomscreen[0], level.width), sh = Math.min(md.zoomscreen[1], level.height);
      const p = findPlayer();
      if (p === null) return fallback;
      const x = Math.max(Math.min(p.x - ((sw / 2) | 0), level.width - sw), 0);
      const y = Math.max(Math.min(p.y - ((sh / 2) | 0), level.height - sh), 0);
      return { x, y, w: Math.min(sw, level.width - x), h: Math.min(sh, level.height - y) };
    }
    return full;
  }

  function snapshot() {
    const state = ctx.state;
    const base = {
      levelIndex: ctx.curlevel | 0,
      levelCount: state.levels.length,
      background: hexColor(state.bgcolor),
      textColor: hexColor(state.fgcolor),
      message: null,
      width: 0, height: 0, cells: [], sprites: {}, viewport: { x: 0, y: 0, w: 0, h: 0 },
    };
    if (ctx.titleScreen) return Object.assign(base, { kind: 'finished' });
    const leveldat = state.levels[ctx.curlevel];
    if (leveldat && leveldat.message !== undefined) {
      return Object.assign(base, { kind: 'message', message: String(leveldat.message).trim() });
    }
    if (ctx.messagetext && ctx.messagetext.length > 0) {
      // in-rule message: the level state is already updated; show the text as an overlay frame
      return Object.assign(base, { kind: 'message', message: String(ctx.messagetext).trim() });
    }
    const level = ctx.level;
    const cells = new Array(level.n_tiles);
    const probe = new ctx.BitVec(ctx.STRIDE_OBJ);
    const objectCount = state.objectCount;
    for (let i = 0; i < level.n_tiles; i++) {
      level.getCellInto(i, probe);
      const ids = [];
      for (let k = 0; k < objectCount; k++) if (probe.get(k)) ids.push(k);
      cells[i] = ids;
    }
    const sprites = {};
    for (let k = 0; k < objectCount; k++) {
      const o = state.objects[state.idDict[k]];
      sprites[k] = { colors: o.colors.map(hexColor), dat: o.spritematrix };
    }
    return Object.assign(base, { kind: 'level', width: level.width, height: level.height, cells, sprites, viewport: viewport() });
  }

  return {
    load,
    snapshot,
    levelString: () => ctx.convertLevelToString(),
    dispose() { /* nothing to free; the context is garbage collected */ },
    _ctx: ctx, // test aid only
    _drainAgain: drainAgain,
  };
}

module.exports = { createHost, CompileError, EngineError };
```

- [ ] **Step 4: Run the tests**

Run: `cd discord-bot && npm test`
Expected: 5 tests pass. If `o.colors` contains names rather than hex, check: the compiler converts colours to hex in `generateExtraMembers`; if the assertion on `#000000` fails, print `s.background` and adjust `hexColor` to lower-case only (the compiler already outputs `#rrggbb`).

- [ ] **Step 5: Run the engine suite and commit**

Run: `cd src && node tests/run_tests_node.js | tail -4` → `Failed: 0`.

```bash
git add discord-bot/engine-host.js discord-bot/test/engine-host.test.js
git commit -m "discord-bot: headless engine host with load and snapshot

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Engine host — inputs, undo, restart, continue, and harness equivalence

**Files:**
- Modify: `discord-bot/engine-host.js`
- Modify: `discord-bot/test/engine-host.test.js`
- Create: `discord-bot/test/fixtures/two-level-random.txt`, `discord-bot/test/fixtures/message-game.txt`

**Interfaces:**
- Produces on `Host`:
  - `input(action: string) → boolean` for `'up'|'left'|'down'|'right'|'action'|'undo'|'restart'|'continue'`. Returns `false` and does nothing when the action is not applicable (direction on a message or finished frame, `continue` on a level, action when `noaction`). Throws `EngineError` if `again` never terminates.
  - `tick()` test aid: `processInput(-1)` + drain (used to replay harness sessions' `"tick"` entries).
  - `replay(actions: string[])` applies each in order.
- Consumes: Task 2's host.

Semantics (mirror the test harness in `src/tests/resources/testingFrameWork.js` lines 29–51): a direction calls `processInput(code)`; `undo` calls `DoUndo(false, true)`; `restart` calls `DoRestart()`; after each of these, drain `again`. `continue` on a message *level* calls `nextLevel()`; `continue` on an in-rule message clears `messagetext` (the level already advanced; `checkWin` already ran because `textMode` is false under `unitTesting`). Known limitation, from the spec: an in-rule message that fires on the same turn a level is won is lost, because `nextLevel()` clears it.

- [ ] **Step 1: Add fixtures**

```
# discord-bot/test/fixtures/two-level-random.txt
title two level random
author test

========
OBJECTS
========

Background
black

Player
red

Goal
green

Coin
yellow

=======
LEGEND
=======

. = Background
P = Player
G = Goal
C = Coin

=======
SOUNDS
=======

================
COLLISIONLAYERS
================

Background
Goal
Player, Coin

======
RULES
======

random [ Coin ] -> [ ]

==============
WINCONDITIONS
==============

some Player on Goal

=======
LEVELS
=======

PG

CCCCCCCCCC
CCCCPGCCCC
CCCCCCCCCC

```

```
# discord-bot/test/fixtures/message-game.txt
title message game
author test

========
OBJECTS
========

Background
black

Player
red

Goal
green

Switch
blue

=======
LEGEND
=======

. = Background
P = Player
G = Goal
S = Switch

=======
SOUNDS
=======

================
COLLISIONLAYERS
================

Background
Goal, Switch
Player

======
RULES
======

[ > Player | Switch ] -> [ > Player | ] message you pressed it

==============
WINCONDITIONS
==============

some Player on Goal

=======
LEVELS
=======

message welcome to the message game

PS.G

message that is all

```

- [ ] **Step 2: Write failing tests**

Append to `discord-bot/test/engine-host.test.js`:

```js
const FIXTURE = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');

test('moving the player changes the level string', () => {
  const host = createHost();
  host.load(SOKOBAN, 'seed', 0);
  const before = host.levelString();
  assert.equal(host.input('right'), true);
  assert.notEqual(host.levelString(), before);
  assert.equal(host.input('undo'), true);
  assert.equal(host.levelString(), before);
  host.dispose();
});

test('restart returns to the level start', () => {
  const host = createHost();
  host.load(SOKOBAN, 'seed', 0);
  const before = host.levelString();
  host.input('right'); host.input('right'); host.input('up');
  host.input('restart');
  assert.equal(host.levelString(), before);
  host.dispose();
});

test('message levels require continue, then play resumes', () => {
  const host = createHost();
  const meta = host.load(FIXTURE('message-game.txt'), 'seed', 0);
  assert.equal(meta.levelCount, 3);
  assert.equal(host.snapshot().kind, 'message');
  assert.equal(host.snapshot().message, 'welcome to the message game');
  assert.equal(host.input('right'), false, 'directions are ignored on a message');
  assert.equal(host.input('continue'), true);
  assert.equal(host.snapshot().kind, 'level');
  assert.equal(host.snapshot().levelIndex, 1);
  host.dispose();
});

test('in-rule messages show as an overlay and continue clears them', () => {
  const host = createHost();
  host.load(FIXTURE('message-game.txt'), 'seed', 1);
  host.input('right'); // pushes onto the switch, fires message
  const s = host.snapshot();
  assert.equal(s.kind, 'message');
  assert.equal(s.message, 'you pressed it');
  assert.equal(host.input('continue'), true);
  assert.equal(host.snapshot().kind, 'level');
  assert.equal(host.snapshot().levelIndex, 1);
  host.dispose();
});

test('winning the last level reports finished', () => {
  const host = createHost();
  host.load(FIXTURE('message-game.txt'), 'seed', 1);
  host.input('right'); host.input('continue'); host.input('right'); host.input('right');
  // level 1 won -> level 2 is a message -> continue -> past the end
  assert.equal(host.snapshot().kind, 'message');
  host.input('continue');
  assert.equal(host.snapshot().kind, 'finished');
  assert.equal(host.input('right'), false);
  host.dispose();
});

test('noaction games ignore the action input', () => {
  const host = createHost();
  const src = SOKOBAN.replace('homepage www.puzzlescript.net', 'homepage www.puzzlescript.net\nnoaction');
  const meta = host.load(src, 'seed', 0);
  assert.equal(meta.flags.noaction, true);
  assert.equal(host.input('action'), false);
  host.dispose();
});

test('replay is deterministic across level transitions for random games', () => {
  const run = () => {
    const host = createHost();
    host.load(FIXTURE('two-level-random.txt'), 'fixed-seed', 0);
    host.input('right'); // wins level 1, loads level 2 (random coin removal happens per move)
    host.input('left'); host.input('right'); host.input('left');
    const out = host.levelString();
    host.dispose();
    return out;
  };
  assert.equal(run(), run());
});

test('host matches the engine test harness on recorded sessions', () => {
  // Load testdata.js the same way the harness does: it declares a top-level array.
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'tests', 'resources', 'testdata.js'), 'utf8');
  const sandbox = {};
  require('node:vm').runInNewContext(src + '\n;this.__testdata = testdata;', sandbox);
  const testdata = sandbox.__testdata;
  assert.ok(testdata.length > 100);
  let checked = 0;
  for (const [name, dat] of testdata) {
    const [source, inputs, expected, targetLevel, seed] = dat;
    if (/realtime_interval/.test(source)) continue;
    const host = createHost();
    try {
      host.load(source, seed === undefined || seed === null ? 'seed' : seed, targetLevel === undefined ? 0 : targetLevel);
      for (const v of inputs) {
        if (v === 'undo') host.input('undo');
        else if (v === 'restart') host.input('restart');
        else if (v === 'tick') host.tick();
        else host._rawInput(v);
      }
      assert.equal(host.levelString(), expected, 'mismatch in test "' + name + '"');
      checked++;
    } catch (e) {
      if (e instanceof CompileError) continue; // harness compile-error cases are not play sessions
      throw e;
    } finally { host.dispose(); }
  }
  assert.ok(checked > 300, 'expected most sessions to be checked, got ' + checked);
});
```

Note on `_rawInput`: harness inputs are raw direction codes 0–4 and the harness never gates on `noaction` or message screens. Expose `_rawInput(code)` as a test aid that calls `processInput(code)` + drain with no gating, so the equivalence test proves the drain logic matches.

Note on seeds: the harness passes `randomseed` only to the first `compile`; when a recorded session has no seed, the harness passes `null` and the engine picks a random one, so such tests cannot use `random` and comparing them is still valid.

- [ ] **Step 3: Run to verify failure**

Run: `cd discord-bot && npm test`
Expected: the new tests fail with `host.input is not a function`.

- [ ] **Step 4: Implement inputs**

Add inside `createHost()` before the `return`, and extend the returned object:

```js
  const DIRS = { up: 0, left: 1, down: 2, right: 3, action: 4 };

  function kindNow() {
    if (ctx.titleScreen) return 'finished';
    const leveldat = ctx.state.levels[ctx.curlevel];
    if (leveldat && leveldat.message !== undefined) return 'messageLevel';
    if (ctx.messagetext && ctx.messagetext.length > 0) return 'messageRule';
    return 'level';
  }

  function rawInput(code) {
    ctx.processInput(code);
    drainAgain();
  }

  function tick() { rawInput(-1); }

  function input(action) {
    const kind = kindNow();
    if (action === 'continue') {
      if (kind === 'messageLevel') { ctx.nextLevel(); drainAgain(); return true; }
      if (kind === 'messageRule') { ctx.messagetext = ''; return true; }
      return false;
    }
    if (kind !== 'level') return false;
    if (action === 'undo') {
      if ('noundo' in ctx.state.metadata) return false;
      ctx.DoUndo(false, true); drainAgain(); return true;
    }
    if (action === 'restart') {
      if ('norestart' in ctx.state.metadata) return false;
      ctx.DoRestart(); drainAgain(); return true;
    }
    if (!(action in DIRS)) return false;
    if (action === 'action' && 'noaction' in ctx.state.metadata) return false;
    rawInput(DIRS[action]);
    return true;
  }

  function replay(actions) { for (const a of actions) input(a); }
```

and in the returned object add `input, tick, replay, _rawInput: rawInput`.

One subtlety to verify while running: after `nextLevel()` lands on a *message level*, `ctx.messagetext` is `''` and `state.levels[curlevel].message` is set, so `kindNow()` reports `messageLevel` first. After `continue` on the final message level, `nextLevel()` calls `goToTitleScreen()`, which sets `titleScreen = true` → `finished`.

- [ ] **Step 5: Run the tests**

Run: `cd discord-bot && npm test`
Expected: all pass. The harness-equivalence test takes 10–20 s. If a specific recorded session mismatches, compare the harness loop in `testingFrameWork.js` with `rawInput`/`drainAgain` line by line; the harness drains with `while (againing) { againing = false; processInput(-1); }` after every input including undo and restart.

- [ ] **Step 6: Engine suite and commit**

Run: `cd src && node tests/run_tests_node.js | tail -4` → `Failed: 0`.

```bash
git add discord-bot/engine-host.js discord-bot/test/engine-host.test.js discord-bot/test/fixtures/
git commit -m "discord-bot: engine host inputs, messages, finished state, harness equivalence

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: PNG encoder

**Files:**
- Create: `discord-bot/png.js`, `discord-bot/test/png.test.js`

**Interfaces:**
- Produces: `encodePNG(width: number, height: number, rgba: Uint8Array) → Buffer` (rgba length = width·height·4, row-major, top-left origin).
- Produces (test aid, also exported): `decodePNG(buffer) → {width, height, rgba: Uint8Array}` supporting only what we emit: 8-bit RGBA, filter type 0, no interlace.

- [ ] **Step 1: Write failing tests**

```js
// discord-bot/test/png.test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const zlib = require('node:zlib');
const { encodePNG, decodePNG } = require('../png');

test('encodes a valid PNG that round-trips', () => {
  const w = 3, h = 2;
  const rgba = new Uint8Array([
    255, 0, 0, 255,   0, 255, 0, 255,   0, 0, 255, 255,
    0, 0, 0, 0,       128, 128, 128, 255, 255, 255, 255, 255,
  ]);
  const png = encodePNG(w, h, rgba);
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(png.toString('latin1', 12, 16), 'IHDR');
  assert.equal(png.readUInt32BE(16), w);
  assert.equal(png.readUInt32BE(20), h);
  assert.equal(png.toString('latin1', png.length - 8, png.length - 4), 'IEND');
  const back = decodePNG(png);
  assert.equal(back.width, w);
  assert.equal(back.height, h);
  assert.deepEqual([...back.rgba], [...rgba]);
});

test('chunk CRCs are correct', () => {
  const png = encodePNG(1, 1, new Uint8Array([9, 8, 7, 255]));
  // walk chunks and verify each CRC against zlib.crc32 (node 18 lacks it: use our own)
  const { crc32 } = require('../png');
  let pos = 8;
  while (pos < png.length) {
    const len = png.readUInt32BE(pos);
    const typeAndData = png.subarray(pos + 4, pos + 8 + len);
    const crc = png.readUInt32BE(pos + 8 + len);
    assert.equal(crc, crc32(typeAndData) >>> 0);
    pos += 12 + len;
  }
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd discord-bot && node --test test/png.test.js`
Expected: FAIL, `Cannot find module '../png'`.

- [ ] **Step 3: Implement png.js**

```js
// discord-bot/png.js
'use strict';
const zlib = require('node:zlib');

const CRC_TABLE = new Int32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
  CRC_TABLE[n] = c;
}
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'latin1');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

function encodePNG(width, height, rgba) {
  if (rgba.length !== width * height * 4) throw new Error('rgba length mismatch');
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    Buffer.from(rgba.buffer, rgba.byteOffset + y * width * 4, width * 4).copy(raw, y * (width * 4 + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // colour type RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function decodePNG(png) {
  let pos = 8, width = 0, height = 0;
  const idat = [];
  while (pos < png.length) {
    const len = png.readUInt32BE(pos);
    const type = png.toString('latin1', pos + 4, pos + 8);
    const data = png.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') { width = data.readUInt32BE(0); height = data.readUInt32BE(4); }
    if (type === 'IDAT') idat.push(data);
    pos += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    if (raw[y * (width * 4 + 1)] !== 0) throw new Error('decodePNG only supports filter 0');
    rgba.set(raw.subarray(y * (width * 4 + 1) + 1, y * (width * 4 + 1) + 1 + width * 4), y * width * 4);
  }
  return { width, height, rgba };
}

module.exports = { encodePNG, decodePNG, crc32 };
```

- [ ] **Step 4: Run the tests**

Run: `cd discord-bot && node --test test/png.test.js`
Expected: 2 pass.

- [ ] **Step 5: Commit**

```bash
git add discord-bot/png.js discord-bot/test/png.test.js
git commit -m "discord-bot: dependency-free PNG encoder

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Renderer — level frames

**Files:**
- Create: `discord-bot/renderer.js`, `discord-bot/test/renderer.test.js`

**Interfaces:**
- Produces: `renderSnapshot(snapshot) → {png: Buffer, width: number, height: number}`; `renderLevelRGBA(snapshot) → {width, height, rgba}` (exported for tests).
- Consumes: `Snapshot` from Task 2, `encodePNG` from Task 4.

Rules: a cell is 5×5 engine pixels. Integer scale `s = max(1, floor(800 / (5 · max(vw, vh))))`. Output size `vw·5·s × vh·5·s`. Fill with `background`. For each cell in the viewport, for each object id ascending, draw its sprite: `dat[row][col] >= 0` → colour `colors[dat[row][col]]`. Cell index in `cells` is `x · height + y`.

- [ ] **Step 1: Write failing tests**

```js
// discord-bot/test/renderer.test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { createHost } = require('../engine-host');
const { renderSnapshot, renderLevelRGBA } = require('../renderer');
const { decodePNG } = require('../png');

const SOKOBAN = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'demo', 'sokoban_basic.txt'), 'utf8');

function px(img, x, y) {
  const i = (y * img.width + x) * 4;
  return [img.rgba[i], img.rgba[i + 1], img.rgba[i + 2], img.rgba[i + 3]];
}

test('renders sokoban level 1 with the engine palette', () => {
  const host = createHost();
  host.load(SOKOBAN, 'seed', 0);
  const s = host.snapshot();
  const img = renderLevelRGBA(s);
  const scale = img.width / (s.viewport.w * 5);
  assert.ok(Number.isInteger(scale) && scale >= 1);
  assert.ok(img.width <= 800 && img.height <= 800);
  // Find the wall object and a cell containing it; wall sprite row 0 is "00010" (brown, brown, brown, darkbrown, brown)
  const wallId = Object.keys(s.sprites).map(Number).find((id) => s.sprites[id].colors.includes('#a46422') && s.sprites[id].colors.includes('#493c2b'));
  assert.notEqual(wallId, undefined);
  const cellIndex = s.cells.findIndex((ids) => ids.includes(wallId));
  const cx = (cellIndex / s.height) | 0, cy = cellIndex % s.height;
  const ox = (cx - s.viewport.x) * 5 * scale, oy = (cy - s.viewport.y) * 5 * scale;
  assert.deepEqual(px(img, ox + 0 * scale, oy), [0xa4, 0x64, 0x22, 255]); // brown
  assert.deepEqual(px(img, ox + 3 * scale, oy), [0x49, 0x3c, 0x2b, 255]); // darkbrown
  host.dispose();
});

test('renderSnapshot produces a PNG of the right size', () => {
  const host = createHost();
  host.load(SOKOBAN, 'seed', 0);
  const s = host.snapshot();
  const out = renderSnapshot(s);
  const back = decodePNG(out.png);
  assert.equal(back.width, out.width);
  assert.equal(back.height, out.height);
  assert.equal(back.width % (s.viewport.w * 5), 0);
  host.dispose();
});

test('zoomscreen viewport crops to the window around the player', () => {
  const src = SOKOBAN.replace('homepage www.puzzlescript.net', 'homepage www.puzzlescript.net\nzoomscreen 3x3');
  const host = createHost();
  host.load(src, 'seed', 0);
  const s = host.snapshot();
  assert.deepEqual([s.viewport.w, s.viewport.h], [3, 3]);
  const img = renderLevelRGBA(s);
  assert.equal(img.width / img.height, 1);
  host.dispose();
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd discord-bot && node --test test/renderer.test.js`
Expected: FAIL, `Cannot find module '../renderer'`.

- [ ] **Step 3: Implement renderer.js (level frames)**

```js
// discord-bot/renderer.js
'use strict';
const { encodePNG } = require('./png');

const MAX_SIDE = 800;
const CELL = 5;

function parseHex(c) {
  const m = /^#?([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(String(c).trim());
  if (!m) return [255, 0, 255, 255];
  const n = parseInt(m[1], 16);
  const a = m[2] !== undefined ? parseInt(m[2], 16) : 255;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255, a];
}

function makeImage(width, height, bg) {
  const rgba = new Uint8Array(width * height * 4);
  const [r, g, b, a] = parseHex(bg);
  for (let i = 0; i < rgba.length; i += 4) { rgba[i] = r; rgba[i + 1] = g; rgba[i + 2] = b; rgba[i + 3] = a; }
  return { width, height, rgba };
}

function fillRect(img, x, y, w, h, rgb) {
  for (let yy = y; yy < y + h; yy++) {
    if (yy < 0 || yy >= img.height) continue;
    for (let xx = x; xx < x + w; xx++) {
      if (xx < 0 || xx >= img.width) continue;
      const i = (yy * img.width + xx) * 4;
      img.rgba[i] = rgb[0]; img.rgba[i + 1] = rgb[1]; img.rgba[i + 2] = rgb[2]; img.rgba[i + 3] = 255;
    }
  }
}

function scaleFor(cellsW, cellsH, cellPx) {
  return Math.max(1, Math.floor(MAX_SIDE / (cellPx * Math.max(cellsW, cellsH))));
}

function renderLevelRGBA(s) {
  const { x: vx, y: vy, w: vw, h: vh } = s.viewport;
  const scale = scaleFor(vw, vh, CELL);
  const img = makeImage(vw * CELL * scale, vh * CELL * scale, s.background);
  const colourCache = {};
  const rgbOf = (hex) => (colourCache[hex] || (colourCache[hex] = parseHex(hex)));
  for (let cx = 0; cx < vw; cx++) {
    for (let cy = 0; cy < vh; cy++) {
      const ids = s.cells[(vx + cx) * s.height + (vy + cy)];
      if (!ids) continue;
      for (const id of ids) {
        const sprite = s.sprites[id];
        if (!sprite) continue;
        for (let row = 0; row < CELL; row++) {
          const line = sprite.dat[row];
          if (!line) continue;
          for (let col = 0; col < CELL; col++) {
            const v = line[col];
            if (v === undefined || v < 0) continue;
            const colour = sprite.colors[v];
            if (colour === undefined) continue;
            fillRect(img, (cx * CELL + col) * scale, (cy * CELL + row) * scale, scale, scale, rgbOf(colour));
          }
        }
      }
    }
  }
  return img;
}

function renderSnapshot(s) {
  let img;
  if (s.kind === 'level') img = renderLevelRGBA(s);
  else throw new Error('unsupported snapshot kind ' + s.kind); // text frames arrive in the next task
  return { png: encodePNG(img.width, img.height, img.rgba), width: img.width, height: img.height };
}

module.exports = { renderSnapshot, renderLevelRGBA, parseHex, makeImage, fillRect, scaleFor };
```

- [ ] **Step 4: Run the tests**

Run: `cd discord-bot && node --test test/renderer.test.js`
Expected: 3 pass.

- [ ] **Step 5: Commit**

```bash
git add discord-bot/renderer.js discord-bot/test/renderer.test.js
git commit -m "discord-bot: render level snapshots to PNG

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Renderer — message and finished frames with the bitmap font

**Files:**
- Modify: `discord-bot/renderer.js`
- Modify: `discord-bot/test/renderer.test.js`

**Interfaces:**
- Produces: `renderTextRGBA(snapshot) → {width, height, rgba}` and `renderSnapshot` handling `kind === 'message'` and `kind === 'finished'`.
- Consumes: `src/js/font.js` (a global `let font = {...}`; each glyph is a string starting with a newline, then 12 rows of 5 characters, `1` = ink).

Layout mirrors the engine's message screen: a 34-column × 13-row character grid (`messagecontainer_template` in `src/js/engine.js`). Text wrapped at 34 with the engine's `wordwrap` regex, at most 12 lines, vertically offset by `5 - floor(lines/2)` (not below 0), each line centred. No "X to continue" line (the Discord button is the continue). Character cell = 6×13 engine pixels (5×12 glyph + 1 px gap). Scale `s = max(1, floor(800 / (6·34)))` = 3 → 612×507.

- [ ] **Step 1: Write failing tests**

Append to `discord-bot/test/renderer.test.js`:

```js
const { renderTextRGBA } = require('../renderer');

test('message frames render text in the text colour on the background', () => {
  const s = { kind: 'message', message: 'hello', background: '#000000', textColor: '#ffffff', levelIndex: 0, levelCount: 1 };
  const img = renderTextRGBA(s);
  assert.equal(img.width, 34 * 6 * 3);
  assert.equal(img.height, 13 * 13 * 3); // 13 rows * 13 px per row * scale 3
  let white = 0, black = 0;
  for (let i = 0; i < img.rgba.length; i += 4) {
    if (img.rgba[i] === 255 && img.rgba[i + 1] === 255 && img.rgba[i + 2] === 255) white++;
    else if (img.rgba[i] === 0 && img.rgba[i + 1] === 0 && img.rgba[i + 2] === 0) black++;
  }
  assert.ok(white > 50, 'expected some ink');
  assert.ok(black > white, 'mostly background');
});

test('the glyph for "h" lands on row 5 (centre) for a one-line message', () => {
  const s = { kind: 'message', message: 'h', background: '#000000', textColor: '#ffffff' };
  const img = renderTextRGBA(s);
  const scale = 3;
  const col = Math.floor((34 - 1) / 2);
  const row = 5;
  // check that at least one ink pixel exists inside that character cell and none in row 0
  let inkInCell = 0, inkRow0 = 0;
  for (let y = 0; y < 13 * scale; y++) for (let x = 0; x < 6 * scale; x++) {
    const i = (((row * 13 * scale) + y) * img.width + (col * 6 * scale + x)) * 4;
    if (img.rgba[i] === 255) inkInCell++;
    const j = ((y) * img.width + (col * 6 * scale + x)) * 4;
    if (img.rgba[j] === 255) inkRow0++;
  }
  assert.ok(inkInCell > 0);
  assert.equal(inkRow0, 0);
});

test('finished frames render', () => {
  const out = renderSnapshot({ kind: 'finished', background: '#101010', textColor: '#ffffff' });
  assert.ok(out.png.length > 100);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd discord-bot && node --test test/renderer.test.js`
Expected: new tests FAIL (`renderTextRGBA is not a function`).

- [ ] **Step 3: Implement text rendering**

Add to `discord-bot/renderer.js`:

```js
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const TERMINAL_W = 34, TERMINAL_H = 13, GLYPH_W = 5, GLYPH_H = 12, CHAR_W = 6, CHAR_H = 13;

let glyphs = null;
function getGlyphs() {
  if (glyphs === null) {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'js', 'font.js'), 'utf8');
    const sandbox = {};
    vm.runInNewContext(src + '\n;this.__font = font;', sandbox);
    glyphs = {};
    for (const [ch, str] of Object.entries(sandbox.__font)) {
      const rows = str.split('\n').map((r) => r.trim()).filter((r, i) => !(i === 0 && r === ''));
      glyphs[ch] = rows.slice(0, GLYPH_H).map((r) => r.split('').map((c) => c === '1'));
    }
  }
  return glyphs;
}

function wordwrap(str, width) {
  if (!str) return [];
  const regex = '.{1,' + width + '}(\\s|$)|.{' + width + '}|.+$';
  return (str.match(new RegExp(regex, 'g')) || []).map((l) => l.replace(/\s+$/, ''));
}

function layoutText(message) {
  const lines = wordwrap(String(message).trim(), TERMINAL_W).slice(0, TERMINAL_H - 1);
  let offset = 5 - ((lines.length / 2) | 0);
  if (offset < 0) offset = 0;
  const grid = [];
  for (let r = 0; r < TERMINAL_H; r++) grid.push(' '.repeat(TERMINAL_W));
  lines.forEach((line, i) => {
    const row = offset + i;
    if (row >= TERMINAL_H) return;
    const lmargin = ((TERMINAL_W - line.length) / 2) | 0;
    grid[row] = (' '.repeat(lmargin) + line).padEnd(TERMINAL_W).slice(0, TERMINAL_W);
  });
  return grid;
}

function renderTextRGBA(s) {
  const text = s.kind === 'finished' ? 'finished' : s.message || '';
  const grid = layoutText(text);
  const scale = scaleFor(TERMINAL_W, TERMINAL_H, CHAR_W);
  const img = makeImage(TERMINAL_W * CHAR_W * scale, TERMINAL_H * CHAR_H * scale, s.background || '#000000');
  const ink = parseHex(s.textColor || '#ffffff');
  const font = getGlyphs();
  for (let r = 0; r < TERMINAL_H; r++) {
    for (let c = 0; c < TERMINAL_W; c++) {
      const ch = grid[r][c];
      if (ch === ' ' || !font[ch]) continue; // unknown glyphs (CJK) are skipped
      const g = font[ch];
      for (let gy = 0; gy < GLYPH_H; gy++) for (let gx = 0; gx < GLYPH_W; gx++) {
        if (g[gy] && g[gy][gx]) fillRect(img, (c * CHAR_W + gx) * scale, (r * CHAR_H + gy) * scale, scale, scale, ink);
      }
    }
  }
  return img;
}
```

Update `renderSnapshot`:

```js
function renderSnapshot(s) {
  const img = s.kind === 'level' ? renderLevelRGBA(s) : renderTextRGBA(s);
  return { png: encodePNG(img.width, img.height, img.rgba), width: img.width, height: img.height };
}
```

and export `renderTextRGBA, layoutText`.

- [ ] **Step 4: Run the tests**

Run: `cd discord-bot && node --test test/renderer.test.js`
Expected: all pass. If `scaleFor(34, 13, 6)` is not 3, check the arithmetic: `floor(800 / (6·34)) = floor(3.92) = 3`.

- [ ] **Step 5: Commit**

```bash
git add discord-bot/renderer.js discord-bot/test/renderer.test.js
git commit -m "discord-bot: render message and finished frames with the engine font

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: Gist source resolution and cached fetching

**Files:**
- Create: `discord-bot/gists.js`, `discord-bot/test/gists.test.js`

**Interfaces:**
- Produces:
  - `parseGistId(input: string) → string|null` accepting a bare hex id, `play.html?p=<id>`, `editor.html?hack=<id>`, `https://gist.github.com/<user>/<id>`, with optional surrounding whitespace.
  - `createGistStore({dataDir, token, fetchImpl = globalThis.fetch, now = Date.now, maxBytes = 1_000_000, freshMs = 10·60·1000}) → {getSource(id) → Promise<string>}`. Errors: `GistError` with `.message` suitable for showing to users ("gist not found", "game source is too large", "GitHub error 503").
- Cache file: `<dataDir>/gists/<id>.json` = `{etag, fetchedAt, content}`.

- [ ] **Step 1: Write failing tests**

```js
// discord-bot/test/gists.test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseGistId, createGistStore, GistError } = require('../gists');

test('parseGistId accepts the supported forms', () => {
  const id = '2fe3172d2b9fe684977d184f1b6226d5';
  assert.equal(parseGistId(id), id);
  assert.equal(parseGistId('  ' + id + '\n'), id);
  assert.equal(parseGistId('https://www.puzzlescript.net/play.html?p=' + id), id);
  assert.equal(parseGistId('http://puzzlescript.net/editor.html?hack=' + id), id);
  assert.equal(parseGistId('https://gist.github.com/increpare/' + id), id);
  assert.equal(parseGistId('6841165'), '6841165');
  assert.equal(parseGistId('not a gist'), null);
  assert.equal(parseGistId('https://example.com/?p=' + id), null);
});

function fakeFetch(responses) {
  const calls = [];
  const impl = async (url, opts) => {
    calls.push({ url, opts });
    const r = responses.shift();
    if (!r) throw new Error('unexpected fetch');
    return {
      status: r.status,
      ok: r.status >= 200 && r.status < 300,
      headers: { get: (k) => (r.headers || {})[k.toLowerCase()] },
      json: async () => r.body,
    };
  };
  return { impl, calls };
}

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'psbot-')); }

test('fetches, caches, and serves fresh from cache without a request', async () => {
  const dir = tmpDir();
  let t = 1000;
  const { impl, calls } = fakeFetch([
    { status: 200, headers: { etag: '"abc"' }, body: { files: { 'script.txt': { content: 'title x' } } } },
  ]);
  const store = createGistStore({ dataDir: dir, token: 'tok', fetchImpl: impl, now: () => t });
  assert.equal(await store.getSource('abc123'), 'title x');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].opts.headers.authorization, 'Bearer tok');
  t += 60 * 1000;
  assert.equal(await store.getSource('abc123'), 'title x');
  assert.equal(calls.length, 1, 'served from cache');
});

test('revalidates stale cache with the etag and keeps content on 304', async () => {
  const dir = tmpDir();
  let t = 1000;
  const { impl, calls } = fakeFetch([
    { status: 200, headers: { etag: '"abc"' }, body: { files: { 'script.txt': { content: 'v1' } } } },
    { status: 304 },
    { status: 200, headers: { etag: '"def"' }, body: { files: { 'script.txt': { content: 'v2' } } } },
  ]);
  const store = createGistStore({ dataDir: dir, token: 'tok', fetchImpl: impl, now: () => t });
  await store.getSource('id1');
  t += 11 * 60 * 1000;
  assert.equal(await store.getSource('id1'), 'v1');
  assert.equal(calls[1].opts.headers['if-none-match'], '"abc"');
  t += 11 * 60 * 1000;
  assert.equal(await store.getSource('id1'), 'v2');
});

test('errors are user-facing', async () => {
  const dir = tmpDir();
  const { impl } = fakeFetch([
    { status: 404, body: {} },
    { status: 200, headers: {}, body: { files: {} } },
    { status: 200, headers: {}, body: { files: { 'script.txt': { content: 'x'.repeat(1_000_001) } } } },
  ]);
  const store = createGistStore({ dataDir: dir, token: 'tok', fetchImpl: impl });
  await assert.rejects(store.getSource('a'), (e) => e instanceof GistError && /not found/.test(e.message));
  await assert.rejects(store.getSource('b'), (e) => e instanceof GistError && /script\.txt/.test(e.message));
  await assert.rejects(store.getSource('c'), (e) => e instanceof GistError && /too large/.test(e.message));
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd discord-bot && node --test test/gists.test.js`
Expected: FAIL, `Cannot find module '../gists'`.

- [ ] **Step 3: Implement gists.js**

```js
// discord-bot/gists.js
'use strict';
const fs = require('node:fs');
const path = require('node:path');

class GistError extends Error {}

function parseGistId(input) {
  const s = String(input || '').trim();
  let m = /^[0-9a-f]{4,40}$/i.exec(s);
  if (m) return s.toLowerCase();
  m = /^https?:\/\/(?:www\.)?puzzlescript\.net\/(?:play|editor)\.html\?(?:p|hack)=([0-9a-f]{4,40})/i.exec(s);
  if (m) return m[1].toLowerCase();
  m = /^https?:\/\/gist\.github\.com\/[^/]+\/([0-9a-f]{4,40})/i.exec(s);
  if (m) return m[1].toLowerCase();
  return null;
}

function createGistStore({ dataDir, token, fetchImpl = globalThis.fetch, now = Date.now, maxBytes = 1_000_000, freshMs = 10 * 60 * 1000 }) {
  const cacheDir = path.join(dataDir, 'gists');
  fs.mkdirSync(cacheDir, { recursive: true });
  const fileFor = (id) => path.join(cacheDir, id + '.json');

  function readCache(id) {
    try { return JSON.parse(fs.readFileSync(fileFor(id), 'utf8')); } catch (e) { return null; }
  }
  function writeCache(id, entry) {
    const tmp = fileFor(id) + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(entry));
    fs.renameSync(tmp, fileFor(id));
  }

  async function fetchGist(id, etag) {
    const headers = {
      'user-agent': 'puzzlescript-discord-bot',
      accept: 'application/vnd.github+json',
      authorization: 'Bearer ' + token,
      'x-github-api-version': '2022-11-28',
    };
    if (etag) headers['if-none-match'] = etag;
    let res;
    try { res = await fetchImpl('https://api.github.com/gists/' + id, { headers }); }
    catch (e) { throw new GistError('could not reach GitHub'); }
    if (res.status === 304) return null;
    if (res.status === 404) throw new GistError('gist not found');
    if (!res.ok) throw new GistError('GitHub error ' + res.status);
    const body = await res.json();
    const file = body && body.files && body.files['script.txt'];
    if (!file || typeof file.content !== 'string') throw new GistError('gist has no script.txt');
    if (Buffer.byteLength(file.content, 'utf8') > maxBytes) throw new GistError('game source is too large');
    return { etag: res.headers.get('etag') || null, fetchedAt: now(), content: file.content };
  }

  async function getSource(id) {
    const cached = readCache(id);
    if (cached && now() - cached.fetchedAt < freshMs) return cached.content;
    const fresh = await fetchGist(id, cached ? cached.etag : null);
    if (fresh === null) {
      const entry = Object.assign({}, cached, { fetchedAt: now() });
      writeCache(id, entry);
      return cached.content;
    }
    writeCache(id, fresh);
    return fresh.content;
  }

  return { getSource };
}

module.exports = { parseGistId, createGistStore, GistError };
```

- [ ] **Step 4: Run the tests**

Run: `cd discord-bot && node --test test/gists.test.js`
Expected: 4 pass.

- [ ] **Step 5: Commit**

```bash
git add discord-bot/gists.js discord-bot/test/gists.test.js
git commit -m "discord-bot: gist id parsing and cached GitHub fetching

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: Worker pool with deadlines

**Files:**
- Create: `discord-bot/worker.js`, `discord-bot/pool.js`, `discord-bot/test/pool.test.js`

**Interfaces:**
- Produces: `createPool({size = 2, compileMs = 10000, inputMs = 3000, onEvicted = (gameIds) => {}}) → Pool`
  - `Pool.load(gameId, source, seed, levelIndex) → Promise<Meta>` (assigns the game to a worker; rejects `CompileError`-shaped `{name:'CompileError', message}` as `Error` with `.name = 'CompileError'`).
  - `Pool.apply(gameId, actions: string[]) → Promise<void>` (replays; each action within `inputMs` overall budget `inputMs · max(1, actions.length)`).
  - `Pool.input(gameId, action) → Promise<boolean>`.
  - `Pool.snapshot(gameId) → Promise<Snapshot>`.
  - `Pool.has(gameId) → boolean`; `Pool.drop(gameId) → Promise<void>`; `Pool.close() → Promise<void>`.
  - On deadline overrun: the worker is terminated, the offending call rejects with `Error('timeout')` and `.name = 'TimeoutError'`, every other game that lived in that worker is forgotten and reported through `onEvicted(gameIds)`, and a fresh worker replaces it.
- Consumes: `engine-host` (inside the worker).

Message protocol (main → worker): `{id, op, gameId, args}`; worker → main: `{id, ok: true, result}` or `{id, ok: false, error: {name, message}}`. Test-only op `__spin` busy-waits `args.ms` milliseconds so the timeout path can be exercised deterministically.

- [ ] **Step 1: Write failing tests**

```js
// discord-bot/test/pool.test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { createPool } = require('../pool');

const SOKOBAN = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'demo', 'sokoban_basic.txt'), 'utf8');

test('load, input and snapshot through a worker', async () => {
  const pool = createPool({ size: 1 });
  try {
    const meta = await pool.load('g1', SOKOBAN, 'seed', 0);
    assert.equal(meta.title, 'Simple Block Pushing Game');
    const before = await pool.snapshot('g1');
    assert.equal(before.kind, 'level');
    assert.equal(await pool.input('g1', 'right'), true);
    const after = await pool.snapshot('g1');
    assert.notDeepEqual(after.cells, before.cells);
    assert.equal(pool.has('g1'), true);
    await pool.drop('g1');
    assert.equal(pool.has('g1'), false);
  } finally { await pool.close(); }
});

test('compile errors reject with CompileError name', async () => {
  const pool = createPool({ size: 1 });
  try {
    await assert.rejects(pool.load('bad', 'title nope\n\n=======\nRULES\n=======\n[ Foo ] -> [ ]\n', 'seed', 0), (e) => e.name === 'CompileError');
    assert.equal(pool.has('bad'), false);
  } finally { await pool.close(); }
});

test('a call over its deadline kills the worker and evicts its games', async () => {
  const evicted = [];
  const pool = createPool({ size: 1, inputMs: 200, onEvicted: (ids) => evicted.push(...ids) });
  try {
    await pool.load('a', SOKOBAN, 'seed', 0);
    await pool.load('b', SOKOBAN, 'seed', 0);
    await assert.rejects(pool._call('a', '__spin', { ms: 2000 }, 200), (e) => e.name === 'TimeoutError');
    assert.equal(pool.has('a'), false);
    assert.equal(pool.has('b'), false);
    assert.deepEqual(evicted.sort(), ['b']);
    // pool still works after replacement
    const meta = await pool.load('c', SOKOBAN, 'seed', 0);
    assert.equal(meta.levelCount >= 1, true);
  } finally { await pool.close(); }
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd discord-bot && node --test test/pool.test.js`
Expected: FAIL, `Cannot find module '../pool'`.

- [ ] **Step 3: Implement worker.js**

```js
// discord-bot/worker.js
'use strict';
const { parentPort } = require('node:worker_threads');
const { createHost } = require('./engine-host');

const hosts = new Map();

function handle(msg) {
  const { op, gameId, args } = msg;
  switch (op) {
    case 'load': {
      const host = hosts.get(gameId) || createHost();
      const meta = host.load(args.source, args.seed, args.levelIndex);
      hosts.set(gameId, host);
      return meta;
    }
    case 'apply': {
      const host = hosts.get(gameId);
      if (!host) throw Object.assign(new Error('no such game'), { name: 'NoGameError' });
      host.replay(args.actions);
      return null;
    }
    case 'input': {
      const host = hosts.get(gameId);
      if (!host) throw Object.assign(new Error('no such game'), { name: 'NoGameError' });
      return host.input(args.action);
    }
    case 'snapshot': {
      const host = hosts.get(gameId);
      if (!host) throw Object.assign(new Error('no such game'), { name: 'NoGameError' });
      return host.snapshot();
    }
    case 'drop': {
      const host = hosts.get(gameId);
      if (host) host.dispose();
      hosts.delete(gameId);
      return null;
    }
    case '__spin': {
      const end = Date.now() + args.ms;
      while (Date.now() < end) { /* busy wait, test only */ }
      return null;
    }
    default:
      throw new Error('unknown op ' + op);
  }
}

parentPort.on('message', (msg) => {
  try {
    const result = handle(msg);
    parentPort.postMessage({ id: msg.id, ok: true, result });
  } catch (e) {
    parentPort.postMessage({ id: msg.id, ok: false, error: { name: e && e.name || 'Error', message: String(e && e.message || e) } });
  }
});
```

- [ ] **Step 4: Implement pool.js**

```js
// discord-bot/pool.js
'use strict';
const path = require('node:path');
const { Worker } = require('node:worker_threads');

function createPool({ size = 2, compileMs = 10000, inputMs = 3000, onEvicted = () => {} } = {}) {
  const workers = [];           // {worker, pending: Map<id, {resolve, reject, timer}>, games: Set}
  const gameToWorker = new Map();
  let nextId = 1;
  let rr = 0;
  let closed = false;

  function spawn() {
    const entry = { worker: new Worker(path.join(__dirname, 'worker.js')), pending: new Map(), games: new Set() };
    entry.worker.on('message', (msg) => {
      const p = entry.pending.get(msg.id);
      if (!p) return;
      entry.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.ok) p.resolve(msg.result);
      else p.reject(Object.assign(new Error(msg.error.message), { name: msg.error.name }));
    });
    entry.worker.on('error', (err) => kill(entry, err));
    entry.worker.on('exit', () => { if (!closed && workers.includes(entry)) kill(entry, new Error('worker exited')); });
    return entry;
  }

  function kill(entry, reason) {
    const idx = workers.indexOf(entry);
    if (idx === -1) return;
    workers.splice(idx, 1);
    for (const p of entry.pending.values()) { clearTimeout(p.timer); p.reject(reason); }
    entry.pending.clear();
    const evicted = [];
    for (const g of entry.games) { gameToWorker.delete(g); evicted.push(g); }
    entry.games.clear();
    entry.worker.terminate().catch(() => {});
    if (!closed) {
      workers.push(spawn());
      if (evicted.length) onEvicted(evicted);
    }
  }

  for (let i = 0; i < size; i++) workers.push(spawn());

  function call(entry, gameId, op, args, deadlineMs) {
    return new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        entry.pending.delete(id);
        entry.games.delete(gameId); // the culprit is dead, not merely evicted
        gameToWorker.delete(gameId);
        kill(entry, Object.assign(new Error('timeout'), { name: 'TimeoutError' }));
        reject(Object.assign(new Error('timeout'), { name: 'TimeoutError' }));
      }, deadlineMs);
      entry.pending.set(id, { resolve, reject, timer });
      entry.worker.postMessage({ id, op, gameId, args });
    });
  }

  function entryFor(gameId) {
    const e = gameToWorker.get(gameId);
    if (!e) throw Object.assign(new Error('no such game'), { name: 'NoGameError' });
    return e;
  }

  return {
    async load(gameId, source, seed, levelIndex) {
      if (closed) throw new Error('pool closed');
      let entry = gameToWorker.get(gameId);
      if (!entry) { entry = workers[rr++ % workers.length]; }
      try {
        const meta = await call(entry, gameId, 'load', { source, seed, levelIndex }, compileMs);
        entry.games.add(gameId);
        gameToWorker.set(gameId, entry);
        return meta;
      } catch (e) {
        if (e.name !== 'TimeoutError') { entry.games.delete(gameId); gameToWorker.delete(gameId); }
        throw e;
      }
    },
    apply(gameId, actions) {
      return call(entryFor(gameId), gameId, 'apply', { actions }, inputMs * Math.max(1, actions.length));
    },
    input(gameId, action) { return call(entryFor(gameId), gameId, 'input', { action }, inputMs); },
    snapshot(gameId) { return call(entryFor(gameId), gameId, 'snapshot', {}, inputMs); },
    has(gameId) { return gameToWorker.has(gameId); },
    async drop(gameId) {
      const entry = gameToWorker.get(gameId);
      if (!entry) return;
      entry.games.delete(gameId);
      gameToWorker.delete(gameId);
      await call(entry, gameId, 'drop', {}, inputMs).catch(() => {});
    },
    async close() {
      closed = true;
      await Promise.all(workers.splice(0).map((e) => e.worker.terminate()));
    },
    _call(gameId, op, args, deadlineMs) { return call(entryFor(gameId), gameId, op, args, deadlineMs); },
  };
}

module.exports = { createPool };
```

- [ ] **Step 5: Run the tests**

Run: `cd discord-bot && node --test test/pool.test.js`
Expected: 3 pass. If the third test's `evicted` includes `'a'`, the timeout handler must delete `a` from `entry.games` before `kill` runs (it does above; check ordering).

- [ ] **Step 6: Commit**

```bash
git add discord-bot/worker.js discord-bot/pool.js discord-bot/test/pool.test.js
git commit -m "discord-bot: worker pool with per-call deadlines

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: Game registry — records, persistence, replay, queues

**Files:**
- Create: `discord-bot/games.js`, `discord-bot/test/games.test.js`

**Interfaces:**
- Produces: `createRegistry({dataDir, pool, getSource: (gistId) => Promise<string>, maxLive = 30, now = Date.now}) → Registry`
  - `Registry.start({gameId, channelId, gistId, startLevel = 0}) → Promise<{record, snapshot}>`. Creates record with `seed = gameId`, loads in the pool, persists.
  - `Registry.press(gameId, action) → Promise<{record, snapshot, applied: boolean}>`. Queued per game. Rebuilds via replay if not live. Appends to `inputs` only if `applied`. Marks `status = 'finished'` when the snapshot is `finished`. On `TimeoutError`/`EngineError` marks `status = 'dead'` with `deadReason`, persists, rethrows.
  - `Registry.get(gameId) → record|undefined`, `Registry.loadAll() → number` (reads `data/games/*.json` at startup), `Registry.prune(maxAgeMs) → number`, `Registry.close()`.
  - `Record = {gameId, channelId, gistId, seed, startLevel, inputs: string[], status: 'playing'|'finished'|'dead', deadReason?: string, meta: Meta, createdAt, updatedAt}`.
- Consumes: `Pool` (Task 8), `getSource` (Task 7's `store.getSource`).

Live-set bookkeeping: an array of live gameIds in recency order; when exceeding `maxLive`, `pool.drop` the oldest. `pool.onEvicted` → remove from live set (they rebuild lazily). On rebuild the registry calls `pool.load(gameId, source, seed, startLevel)` then `pool.apply(gameId, inputs)`.

- [ ] **Step 1: Write failing tests**

```js
// discord-bot/test/games.test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createPool } = require('../pool');
const { createRegistry } = require('../games');

const SOKOBAN = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'demo', 'sokoban_basic.txt'), 'utf8');
const getSource = async (id) => { if (id === 'sok') return SOKOBAN; throw new Error('unknown gist'); };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'psbot-games-'));

test('start creates and persists a record with a snapshot', async () => {
  const dir = tmp();
  const pool = createPool({ size: 1 });
  const reg = createRegistry({ dataDir: dir, pool, getSource });
  try {
    const { record, snapshot } = await reg.start({ gameId: 'm1', channelId: 'c', gistId: 'sok' });
    assert.equal(record.status, 'playing');
    assert.equal(record.meta.title, 'Simple Block Pushing Game');
    assert.equal(snapshot.kind, 'level');
    assert.ok(fs.existsSync(path.join(dir, 'games', 'm1.json')));
  } finally { await reg.close(); await pool.close(); }
});

test('press appends applied inputs and persists; inapplicable inputs are not recorded', async () => {
  const dir = tmp();
  const pool = createPool({ size: 1 });
  const reg = createRegistry({ dataDir: dir, pool, getSource });
  try {
    await reg.start({ gameId: 'm2', channelId: 'c', gistId: 'sok' });
    const r1 = await reg.press('m2', 'right');
    assert.equal(r1.applied, true);
    assert.deepEqual(r1.record.inputs, ['right']);
    const r2 = await reg.press('m2', 'continue');
    assert.equal(r2.applied, false);
    assert.deepEqual(r2.record.inputs, ['right']);
    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'games', 'm2.json'), 'utf8'));
    assert.deepEqual(onDisk.inputs, ['right']);
  } finally { await reg.close(); await pool.close(); }
});

test('a game evicted from the pool is rebuilt by replay on the next press', async () => {
  const dir = tmp();
  const pool = createPool({ size: 1 });
  const reg = createRegistry({ dataDir: dir, pool, getSource, maxLive: 1 });
  try {
    await reg.start({ gameId: 'a', channelId: 'c', gistId: 'sok' });
    await reg.press('a', 'right');
    const snapA = (await reg.press('a', 'right')).snapshot;
    await reg.start({ gameId: 'b', channelId: 'c', gistId: 'sok' }); // evicts a (maxLive 1)
    assert.equal(pool.has('a'), false);
    const again = await reg.press('a', 'undo');
    assert.equal(pool.has('a'), true);
    // after two rights and an undo we should be one right from the start: compare with a fresh run
    const reg2 = createRegistry({ dataDir: tmp(), pool, getSource });
    await reg2.start({ gameId: 'z', channelId: 'c', gistId: 'sok' });
    const one = (await reg2.press('z', 'right')).snapshot;
    assert.deepEqual(again.snapshot.cells, one.cells);
    assert.notDeepEqual(snapA.cells, one.cells);
    await reg2.close();
  } finally { await reg.close(); await pool.close(); }
});

test('loadAll restores records from disk and presses keep working', async () => {
  const dir = tmp();
  const pool = createPool({ size: 1 });
  let reg = createRegistry({ dataDir: dir, pool, getSource });
  await reg.start({ gameId: 'p', channelId: 'c', gistId: 'sok' });
  await reg.press('p', 'right');
  await reg.close();
  reg = createRegistry({ dataDir: dir, pool, getSource });
  try {
    assert.equal(reg.loadAll(), 1);
    assert.deepEqual(reg.get('p').inputs, ['right']);
    const r = await reg.press('p', 'undo');
    assert.equal(r.applied, true);
  } finally { await reg.close(); await pool.close(); }
});

test('concurrent presses on one game apply in order', async () => {
  const dir = tmp();
  const pool = createPool({ size: 1 });
  const reg = createRegistry({ dataDir: dir, pool, getSource });
  try {
    await reg.start({ gameId: 'q', channelId: 'c', gistId: 'sok' });
    const results = await Promise.all([reg.press('q', 'right'), reg.press('q', 'right'), reg.press('q', 'undo')]);
    assert.deepEqual(results[2].record.inputs, ['right', 'right', 'undo']);
  } finally { await reg.close(); await pool.close(); }
});

test('prune deletes idle records', async () => {
  const dir = tmp();
  const pool = createPool({ size: 1 });
  let t = 1_000_000;
  const reg = createRegistry({ dataDir: dir, pool, getSource, now: () => t });
  try {
    await reg.start({ gameId: 'old', channelId: 'c', gistId: 'sok' });
    t += 15 * 24 * 3600 * 1000;
    await reg.start({ gameId: 'new', channelId: 'c', gistId: 'sok' });
    assert.equal(reg.prune(14 * 24 * 3600 * 1000), 1);
    assert.equal(reg.get('old'), undefined);
    assert.equal(fs.existsSync(path.join(dir, 'games', 'old.json')), false);
    assert.ok(reg.get('new'));
  } finally { await reg.close(); await pool.close(); }
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd discord-bot && node --test test/games.test.js`
Expected: FAIL, `Cannot find module '../games'`.

- [ ] **Step 3: Implement games.js**

```js
// discord-bot/games.js
'use strict';
const fs = require('node:fs');
const path = require('node:path');

function createRegistry({ dataDir, pool, getSource, maxLive = 30, now = Date.now }) {
  const gamesDir = path.join(dataDir, 'games');
  fs.mkdirSync(gamesDir, { recursive: true });
  const records = new Map();
  const live = [];            // gameIds, most recent last
  const queues = new Map();   // gameId -> Promise chain

  const fileFor = (id) => path.join(gamesDir, id + '.json');
  function persist(rec) {
    rec.updatedAt = now();
    const tmp = fileFor(rec.gameId) + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(rec));
    fs.renameSync(tmp, fileFor(rec.gameId));
  }

  function touchLive(gameId) {
    const i = live.indexOf(gameId);
    if (i !== -1) live.splice(i, 1);
    live.push(gameId);
  }
  function forgetLive(gameId) {
    const i = live.indexOf(gameId);
    if (i !== -1) live.splice(i, 1);
  }
  async function enforceLiveLimit() {
    while (live.length > maxLive) {
      const victim = live.shift();
      await pool.drop(victim);
    }
  }
  if (typeof pool.onEvicted === 'function') pool.onEvicted((ids) => ids.forEach(forgetLive));

  async function ensureLive(rec) {
    if (pool.has(rec.gameId)) { touchLive(rec.gameId); return; }
    const source = await getSource(rec.gistId);
    await pool.load(rec.gameId, source, rec.seed, rec.startLevel);
    if (rec.inputs.length) await pool.apply(rec.gameId, rec.inputs);
    touchLive(rec.gameId);
    await enforceLiveLimit();
  }

  function enqueue(gameId, fn) {
    const prev = queues.get(gameId) || Promise.resolve();
    const next = prev.then(fn, fn);
    queues.set(gameId, next.catch(() => {}));
    return next;
  }

  function markDead(rec, err) {
    rec.status = 'dead';
    rec.deadReason = String(err && err.message || err);
    forgetLive(rec.gameId);
    persist(rec);
  }

  return {
    async start({ gameId, channelId, gistId, startLevel = 0 }) {
      const source = await getSource(gistId);
      const rec = { gameId, channelId, gistId, seed: gameId, startLevel, inputs: [], status: 'playing', meta: null, createdAt: now(), updatedAt: now() };
      rec.meta = await pool.load(gameId, source, rec.seed, startLevel);
      records.set(gameId, rec);
      touchLive(gameId);
      await enforceLiveLimit();
      const snapshot = await pool.snapshot(gameId);
      if (snapshot.kind === 'finished') rec.status = 'finished';
      persist(rec);
      return { record: rec, snapshot };
    },

    press(gameId, action) {
      return enqueue(gameId, async () => {
        const rec = records.get(gameId);
        if (!rec) throw Object.assign(new Error('unknown game'), { name: 'NoGameError' });
        if (rec.status !== 'playing') return { record: rec, snapshot: await pool.snapshot(gameId).catch(() => ({ kind: rec.status === 'finished' ? 'finished' : 'dead' })), applied: false };
        try {
          await ensureLive(rec);
          const applied = await pool.input(gameId, action);
          if (applied) rec.inputs.push(action);
          const snapshot = await pool.snapshot(gameId);
          if (snapshot.kind === 'finished') rec.status = 'finished';
          if (applied || snapshot.kind === 'finished') persist(rec);
          return { record: rec, snapshot, applied };
        } catch (e) {
          if (e.name === 'TimeoutError' || e.name === 'EngineError' || e.name === 'CompileError') markDead(rec, e);
          throw e;
        }
      });
    },

    get: (gameId) => records.get(gameId),

    loadAll() {
      let n = 0;
      for (const f of fs.readdirSync(gamesDir)) {
        if (!f.endsWith('.json')) continue;
        try {
          const rec = JSON.parse(fs.readFileSync(path.join(gamesDir, f), 'utf8'));
          records.set(rec.gameId, rec);
          n++;
        } catch (e) { /* skip corrupt file */ }
      }
      return n;
    },

    prune(maxAgeMs) {
      let n = 0;
      for (const rec of [...records.values()]) {
        if (now() - rec.updatedAt > maxAgeMs) {
          records.delete(rec.gameId);
          forgetLive(rec.gameId);
          try { fs.unlinkSync(fileFor(rec.gameId)); } catch (e) { /* already gone */ }
          pool.drop(rec.gameId).catch(() => {});
          n++;
        }
      }
      return n;
    },

    async close() {
      await Promise.all([...queues.values()]);
    },
  };
}

module.exports = { createRegistry };
```

Also add to `pool.js` an `onEvicted(fn)` registration so the registry can subscribe after construction: keep the constructor option and add a method:

```js
    onEvicted(fn) { evictionListeners.push(fn); },
```

with `const evictionListeners = [onEvicted];` at the top of `createPool` and `kill` calling every listener: `if (evicted.length) for (const fn of evictionListeners) fn(evicted);`.

- [ ] **Step 4: Run the tests**

Run: `cd discord-bot && npm test`
Expected: all pass. The eviction test relies on `maxLive: 1` dropping `a` when `b` starts.

- [ ] **Step 5: Commit**

```bash
git add discord-bot/games.js discord-bot/pool.js discord-bot/test/games.test.js
git commit -m "discord-bot: game registry with persistence, replay and per-game queues

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 10: Presentation — embeds and button rows

**Files:**
- Create: `discord-bot/presentation.js`, `discord-bot/test/presentation.test.js`

**Interfaces:**
- Produces:
  - `buildComponents(snapshot, meta) → ActionRowBuilder[]` (discord.js builders). Level: row 1 `ps:left ps:up ps:down ps:right [ps:action]`, row 2 `[ps:undo] [ps:restart]`; message: one row with `ps:continue`; finished/dead: `[]`.
  - `buildEmbed({record, snapshot, attachmentName}) → EmbedBuilder` with title `meta.title`, description `by <author>` (omitted if empty), footer `Level n of m` (or `finished` / `dead: reason`), image `attachment://<attachmentName>`.
  - `parseCustomId(id) → action|null` for `ps:<action>`.
  - `ACTION_EMOJI = { left: '⬅️', up: '⬆️', down: '⬇️', right: '➡️', action: '✖️', undo: '↩️', restart: '🔄', continue: '▶️' }`.

- [ ] **Step 1: Write failing tests**

```js
// discord-bot/test/presentation.test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { buildComponents, buildEmbed, parseCustomId } = require('../presentation');

const meta = (flags) => ({ title: 'T', author: 'A', levelCount: 3, flags: Object.assign({ noaction: false, noundo: false, norestart: false, realtime: false }, flags) });
const ids = (rows) => rows.map((r) => r.toJSON().components.map((c) => c.custom_id));

test('level frames get movement and control rows', () => {
  const rows = buildComponents({ kind: 'level' }, meta({}));
  assert.deepEqual(ids(rows), [['ps:left', 'ps:up', 'ps:down', 'ps:right', 'ps:action'], ['ps:undo', 'ps:restart']]);
});

test('flags remove buttons', () => {
  assert.deepEqual(ids(buildComponents({ kind: 'level' }, meta({ noaction: true }))), [['ps:left', 'ps:up', 'ps:down', 'ps:right'], ['ps:undo', 'ps:restart']]);
  assert.deepEqual(ids(buildComponents({ kind: 'level' }, meta({ noundo: true, norestart: true }))), [['ps:left', 'ps:up', 'ps:down', 'ps:right', 'ps:action']]);
});

test('message frames get a continue button; finished gets none', () => {
  assert.deepEqual(ids(buildComponents({ kind: 'message' }, meta({}))), [['ps:continue']]);
  assert.deepEqual(ids(buildComponents({ kind: 'finished' }, meta({}))), []);
});

test('embed carries title, author, level footer and attachment image', () => {
  const record = { meta: meta({}), status: 'playing' };
  const e = buildEmbed({ record, snapshot: { kind: 'level', levelIndex: 1, levelCount: 3 }, attachmentName: 'frame.png' }).toJSON();
  assert.equal(e.title, 'T');
  assert.equal(e.description, 'by A');
  assert.equal(e.footer.text, 'Level 2 of 3');
  assert.equal(e.image.url, 'attachment://frame.png');
  const dead = buildEmbed({ record: { meta: meta({}), status: 'dead', deadReason: 'timeout' }, snapshot: { kind: 'level', levelIndex: 0, levelCount: 3 }, attachmentName: 'f.png' }).toJSON();
  assert.equal(dead.footer.text, 'stopped: timeout');
});

test('custom ids parse', () => {
  assert.equal(parseCustomId('ps:up'), 'up');
  assert.equal(parseCustomId('ps:nope'), null);
  assert.equal(parseCustomId('other'), null);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd discord-bot && node --test test/presentation.test.js`
Expected: FAIL, `Cannot find module '../presentation'`.

- [ ] **Step 3: Implement presentation.js**

```js
// discord-bot/presentation.js
'use strict';
const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } = require('discord.js');

const ACTIONS = ['up', 'left', 'down', 'right', 'action', 'undo', 'restart', 'continue'];
const ACTION_EMOJI = { left: '⬅️', up: '⬆️', down: '⬇️', right: '➡️', action: '✖️', undo: '↩️', restart: '🔄', continue: '▶️' };

function button(action, style = ButtonStyle.Secondary) {
  return new ButtonBuilder().setCustomId('ps:' + action).setEmoji(ACTION_EMOJI[action]).setStyle(style);
}

function buildComponents(snapshot, meta) {
  if (snapshot.kind === 'message') return [new ActionRowBuilder().addComponents(button('continue', ButtonStyle.Primary))];
  if (snapshot.kind !== 'level') return [];
  const flags = (meta && meta.flags) || {};
  const row1 = [button('left'), button('up'), button('down'), button('right')];
  if (!flags.noaction) row1.push(button('action', ButtonStyle.Primary));
  const row2 = [];
  if (!flags.noundo) row2.push(button('undo'));
  if (!flags.norestart) row2.push(button('restart', ButtonStyle.Danger));
  const rows = [new ActionRowBuilder().addComponents(...row1)];
  if (row2.length) rows.push(new ActionRowBuilder().addComponents(...row2));
  return rows;
}

function footerText(record, snapshot) {
  if (record.status === 'dead') return 'stopped: ' + (record.deadReason || 'error');
  if (snapshot.kind === 'finished' || record.status === 'finished') return 'finished';
  return 'Level ' + ((snapshot.levelIndex | 0) + 1) + ' of ' + snapshot.levelCount;
}

function buildEmbed({ record, snapshot, attachmentName }) {
  const meta = record.meta || {};
  const e = new EmbedBuilder().setTitle(meta.title || 'PuzzleScript game').setFooter({ text: footerText(record, snapshot) });
  if (meta.author) e.setDescription('by ' + meta.author);
  if (attachmentName) e.setImage('attachment://' + attachmentName);
  return e;
}

function parseCustomId(id) {
  const m = /^ps:([a-z]+)$/.exec(String(id || ''));
  return m && ACTIONS.includes(m[1]) ? m[1] : null;
}

module.exports = { buildComponents, buildEmbed, parseCustomId, ACTION_EMOJI };
```

- [ ] **Step 4: Run the tests**

Run: `cd discord-bot && node --test test/presentation.test.js`
Expected: 5 pass.

- [ ] **Step 5: Commit**

```bash
git add discord-bot/presentation.js discord-bot/test/presentation.test.js
git commit -m "discord-bot: embed and button construction

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 11: Bot wiring and command registration

**Files:**
- Create: `discord-bot/bot.js`, `discord-bot/register-commands.js`, `discord-bot/config.js`, `discord-bot/test/config.test.js`

**Interfaces:**
- Produces: `loadConfig(envPath) → {discordToken, appId, guildId, githubToken, dataDir}`; throws listing missing keys. `bot.js` starts the client. `register-commands.js` registers `/play`.
- Consumes: everything above.

The `.env` loader is ten lines; do not add `dotenv`.

- [ ] **Step 1: Write the config test**

```js
// discord-bot/test/config.test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadConfig } = require('../config');

test('loads keys from an env file and reports missing ones', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'psbot-cfg-'));
  const file = path.join(dir, '.env');
  fs.writeFileSync(file, '# comment\nDISCORD_TOKEN=abc\nDISCORD_APP_ID=1\nDISCORD_GUILD_ID=2\nGITHUB_TOKEN=\"ghp\"\n');
  const cfg = loadConfig(file);
  assert.equal(cfg.discordToken, 'abc');
  assert.equal(cfg.githubToken, 'ghp');
  assert.equal(cfg.dataDir, path.join(dir, 'data'));
  fs.writeFileSync(file, 'DISCORD_TOKEN=abc\n');
  assert.throws(() => loadConfig(file), /DISCORD_APP_ID.*DISCORD_GUILD_ID.*GITHUB_TOKEN/s);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd discord-bot && node --test test/config.test.js`
Expected: FAIL, `Cannot find module '../config'`.

- [ ] **Step 3: Implement config.js**

```js
// discord-bot/config.js
'use strict';
const fs = require('node:fs');
const path = require('node:path');

function parseEnv(text) {
  const out = {};
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    let v = line.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[line.slice(0, eq).trim()] = v;
  }
  return out;
}

function loadConfig(envPath = path.join(__dirname, '.env')) {
  const env = Object.assign({}, fs.existsSync(envPath) ? parseEnv(fs.readFileSync(envPath, 'utf8')) : {}, process.env);
  const required = ['DISCORD_TOKEN', 'DISCORD_APP_ID', 'DISCORD_GUILD_ID', 'GITHUB_TOKEN'];
  const missing = required.filter((k) => !env[k]);
  if (missing.length) throw new Error('missing config: ' + missing.join(', ') + ' (see .env.example)');
  return {
    discordToken: env.DISCORD_TOKEN,
    appId: env.DISCORD_APP_ID,
    guildId: env.DISCORD_GUILD_ID,
    githubToken: env.GITHUB_TOKEN,
    dataDir: env.DATA_DIR || path.join(path.dirname(envPath), 'data'),
  };
}

module.exports = { loadConfig, parseEnv };
```

- [ ] **Step 4: Run the config test**

Run: `cd discord-bot && node --test test/config.test.js` → pass.

- [ ] **Step 5: Implement register-commands.js**

```js
// discord-bot/register-commands.js
'use strict';
const { REST, Routes, SlashCommandBuilder } = require('discord.js');
const { loadConfig } = require('./config');

async function main() {
  const cfg = loadConfig();
  const play = new SlashCommandBuilder()
    .setName('play')
    .setDescription('Play a PuzzleScript game in this channel')
    .addStringOption((o) => o.setName('game').setDescription('Gist id, play.html link, or gist link').setRequired(true))
    .addIntegerOption((o) => o.setName('level').setDescription('Level to start at (1 = first)').setMinValue(1));
  const rest = new REST({ version: '10' }).setToken(cfg.discordToken);
  await rest.put(Routes.applicationGuildCommands(cfg.appId, cfg.guildId), { body: [play.toJSON()] });
  console.log('registered /play for guild', cfg.guildId);
}

main().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 6: Implement bot.js**

```js
// discord-bot/bot.js
'use strict';
const { Client, GatewayIntentBits, AttachmentBuilder, MessageFlags } = require('discord.js');
const { loadConfig } = require('./config');
const { createPool } = require('./pool');
const { createGistStore, parseGistId, GistError } = require('./gists');
const { createRegistry } = require('./games');
const { renderSnapshot } = require('./renderer');
const { buildComponents, buildEmbed, parseCustomId } = require('./presentation');

const PRUNE_MS = 14 * 24 * 3600 * 1000;

function frame(record, snapshot) {
  const { png } = renderSnapshot(snapshot);
  const name = 'frame.png';
  return {
    embeds: [buildEmbed({ record, snapshot, attachmentName: name })],
    files: [new AttachmentBuilder(png, { name })],
    components: record.status === 'playing' ? buildComponents(snapshot, record.meta) : [],
  };
}

function userMessage(err) {
  if (err instanceof GistError) return err.message;
  if (err && err.name === 'CompileError') return 'that game does not compile: ' + err.message;
  if (err && err.name === 'TimeoutError') return 'that game took too long and was stopped';
  if (err && err.name === 'EngineError') return 'the game stopped: ' + err.message;
  console.error(err);
  return 'something went wrong';
}

async function main() {
  const cfg = loadConfig();
  const pool = createPool({ size: 2 });
  const gists = createGistStore({ dataDir: cfg.dataDir, token: cfg.githubToken });
  const registry = createRegistry({ dataDir: cfg.dataDir, pool, getSource: gists.getSource });
  console.log('loaded', registry.loadAll(), 'games;', 'pruned', registry.prune(PRUNE_MS));
  setInterval(() => console.log('pruned', registry.prune(PRUNE_MS)), 24 * 3600 * 1000).unref();

  const client = new Client({ intents: [GatewayIntentBits.Guilds] });

  client.on('interactionCreate', async (interaction) => {
    try {
      if (interaction.isChatInputCommand() && interaction.commandName === 'play') {
        const gistId = parseGistId(interaction.options.getString('game', true));
        const level = (interaction.options.getInteger('level') || 1) - 1;
        if (!gistId) return interaction.reply({ content: 'that does not look like a gist id or a play link', flags: MessageFlags.Ephemeral });
        await interaction.deferReply();
        const reply = await interaction.fetchReply();
        try {
          const { record, snapshot } = await registry.start({ gameId: reply.id, channelId: interaction.channelId, gistId, startLevel: level });
          if (record.meta.flags.realtime) {
            await interaction.editReply({ content: 'realtime games cannot be played here (this one sets realtime_interval)' });
            return;
          }
          await interaction.editReply(frame(record, snapshot));
        } catch (err) {
          await interaction.editReply({ content: userMessage(err) });
        }
        return;
      }
      if (interaction.isButton()) {
        const action = parseCustomId(interaction.customId);
        if (!action) return;
        const gameId = interaction.message.id;
        if (!registry.get(gameId)) {
          return interaction.reply({ content: 'this game is no longer available', flags: MessageFlags.Ephemeral });
        }
        await interaction.deferUpdate();
        try {
          const { record, snapshot } = await registry.press(gameId, action);
          await interaction.editReply(frame(record, snapshot));
        } catch (err) {
          const record = registry.get(gameId);
          const text = userMessage(err);
          await interaction.editReply({ content: text, components: [], embeds: record ? [buildEmbed({ record, snapshot: { kind: 'level', levelIndex: 0, levelCount: record.meta ? record.meta.levelCount : 0 }, attachmentName: null })] : [] });
        }
      }
    } catch (err) {
      console.error('interaction failed', err);
    }
  });

  client.once('ready', () => console.log('logged in as', client.user.tag));
  process.on('SIGTERM', async () => { await registry.close(); await pool.close(); client.destroy(); process.exit(0); });
  await client.login(cfg.discordToken);
}

main().catch((e) => { console.error(e); process.exit(1); });
```

Note: the realtime check happens after `start` because the flag is only known after compiling. When realtime, the record is left as-is (no buttons are ever shown because `editReply` replaces the content); acceptable. A `level` beyond the last level is clamped by the engine (`nextLevel` guards `curlevel > levels.length`); if the engine instead errors, `CompileError` surfaces as "does not compile", which is wrong wording. Verify during the end-to-end check and, if needed, clamp `level` to `0..levelCount-1` in `games.start` after `pool.load` by reloading.

- [ ] **Step 7: Syntax-check and run the full suite**

Run: `cd discord-bot && node --check bot.js && node --check register-commands.js && npm test`
Expected: all tests pass; `node --check` prints nothing.

- [ ] **Step 8: Commit**

```bash
git add discord-bot/bot.js discord-bot/register-commands.js discord-bot/config.js discord-bot/test/config.test.js
git commit -m "discord-bot: client wiring, /play command, button handling

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 12: Deployment files and README

**Files:**
- Create: `discord-bot/deploy.sh`, `discord-bot/puzzlescript-bot.service`, `discord-bot/README.md`

**Interfaces:**
- Produces: `./deploy.sh` (run from `discord-bot/` on the Mac) syncs to `box@192.168.178.69:~/puzzlescript-bot/` and restarts the user service.

- [ ] **Step 1: Write the service unit**

```ini
# discord-bot/puzzlescript-bot.service
[Unit]
Description=PuzzleScript Discord play bot
After=network-online.target

[Service]
WorkingDirectory=%h/puzzlescript-bot/discord-bot
ExecStart=/usr/bin/node bot.js
Restart=on-failure
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=default.target
```

- [ ] **Step 2: Write deploy.sh**

```bash
#!/usr/bin/env bash
# discord-bot/deploy.sh — sync the engine and bot to the Pi and restart the user service.
set -euo pipefail
HOST="${PSBOT_HOST:-box@192.168.178.69}"
DEST="${PSBOT_DEST:-puzzlescript-bot}"
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"

ssh "$HOST" "mkdir -p ~/$DEST/src ~/$DEST/discord-bot ~/.config/systemd/user"
rsync -az --delete "$ROOT/src/js/" "$HOST:~/$DEST/src/js/"
rsync -az --delete --exclude node_modules --exclude data --exclude .env "$HERE/" "$HOST:~/$DEST/discord-bot/"
ssh "$HOST" "cd ~/$DEST/discord-bot && npm ci --omit=dev --no-audit --no-fund \
  && cp puzzlescript-bot.service ~/.config/systemd/user/ \
  && systemctl --user daemon-reload \
  && systemctl --user enable puzzlescript-bot >/dev/null \
  && systemctl --user restart puzzlescript-bot \
  && sleep 2 && systemctl --user --no-pager status puzzlescript-bot | head -5"
```

Run: `chmod +x discord-bot/deploy.sh`.

- [ ] **Step 3: Write the README**

```markdown
# PuzzleScript Discord play bot

Play a PuzzleScript game inside a Discord channel. `/play <gist>` posts the
level as an image with move, action, undo and restart buttons. Anyone in the
channel can press them. Realtime games are not supported.

## Layout

The bot loads the engine from `../src/js`, so it must sit beside a copy of
`src/`. `deploy.sh` syncs both to `~/puzzlescript-bot/` on the Pi.

## Setup (once)

1. Create a Discord application at https://discord.com/developers/applications,
   add a Bot, copy the token. Invite it with scopes `bot` and
   `applications.commands` and permissions Send Messages, Attach Files,
   Embed Links.
2. On the Pi: `cp .env.example .env` in `~/puzzlescript-bot/discord-bot/` and
   fill in the four keys. `DISCORD_GUILD_ID` is the server id.
3. `node register-commands.js` once (on the Pi or locally with the same `.env`).
4. If the service should survive logout/reboot: `sudo loginctl enable-linger box`.

## Deploy

    ./deploy.sh

## Run locally

    npm install && npm test
    node bot.js        # needs .env

## Operations

- Logs: `journalctl --user -u puzzlescript-bot -f`
- Games persist under `discord-bot/data/games/`, gist cache under `data/gists/`.
  Idle games are pruned after 14 days.
- Limits: 1 MB source, 10 s compile, 3 s per input, 30 live games.
```

- [ ] **Step 4: Commit**

```bash
git add discord-bot/deploy.sh discord-bot/puzzlescript-bot.service discord-bot/README.md
git commit -m "discord-bot: deployment script, user service unit, README

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 13: Discord application, first deploy, end-to-end check

This task is interactive with the user. It needs their logged-in Chrome for the developer portal and their hands for the token.

**Files:** none in the repo.

- [ ] **Step 1: Create the application** (via Claude in Chrome, user watching)

At https://discord.com/developers/applications: New Application → name "PuzzleScript Play". Under Bot: leave all privileged intents off. Note the Application ID from General Information. Under OAuth2 → URL Generator: scopes `bot` + `applications.commands`; bot permissions Send Messages, Attach Files, Embed Links; open the generated URL and add the bot to the PuzzleScript server. Do not copy the token; ask the user to click Reset Token and paste it into `.env` on the Pi.

- [ ] **Step 2: First deploy**

Run from `discord-bot/`: `./deploy.sh`. Expected: `npm ci` output then `Active: active (running)`.
If `systemctl --user` fails with "Failed to connect to bus", the user needs `sudo loginctl enable-linger box` (and a fresh SSH login); give them that one command.

- [ ] **Step 3: User fills `.env` on the Pi**

Tell the user exactly: `ssh box@192.168.178.69`, then `nano ~/puzzlescript-bot/discord-bot/.env`, with the four keys. Then `cd ~/puzzlescript-bot/discord-bot && node register-commands.js && systemctl --user restart puzzlescript-bot`.

- [ ] **Step 4: End-to-end in Discord**

In the play channel: `/play 6841219` (Microban, from the gallery). Expected: an embed "Microban by David Skinner", footer "Level 1 of N", the level image, two button rows. Press ➡️: the image changes. Press ↩️: it reverts. Solve level 1 (or `/play 6841219 level:2`): footer advances. Try `/play` with a gist that sets `realtime_interval`: rejected with the realtime message. Check `journalctl --user -u puzzlescript-bot -n 50` for errors.

- [ ] **Step 5: Record findings**

If anything in the end-to-end check needed a code fix, make it with a test where feasible, run `npm test`, and commit:

```bash
git add -A discord-bot
git commit -m "discord-bot: fixes from first end-to-end run

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Self-review notes

- Spec coverage: engine host (T2–T3), renderer level/message/finished + PNG (T4–T6), gists (T7), workers with deadlines and eviction (T8), registry with persistence/LRU/replay/queues/prune (T9), presentation rules incl. flags (T10), bot flow, realtime refusal, compile-error reply, dead/finished handling, startup load (T11), deployment and lingering (T12–T13), tests per module (each task), manual E2E (T13). The spec's "mark every game in a killed worker dead" is implemented as "offending game dead, others evicted and rebuilt by replay", which is strictly better for players and noted in T8.
- Type consistency: `Snapshot`, `Meta`, `Record`, action strings and `ps:<action>` ids are the same across T2, T3, T8, T9, T10, T11. `pool.onEvicted(fn)` is added in T9 and used there.
- Known limitation carried from the spec: an in-rule `message` on a winning turn is lost (T3 note).
