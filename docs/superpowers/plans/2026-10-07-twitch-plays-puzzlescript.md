# Twitch Plays PuzzleScript Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A service on the Pi that streams the PuzzleScript gallery to Twitch, applies chat commands as moves in arrival order, frames the game in its own wall tiles with a move log, and plays the user's music on shuffle.

**Architecture:** One Node process. The engine runs in the Discord bot's worker pool; a session object owns the current game and everything chat does to it; a pure function composes a 640×360 RGBA frame; an encoder object owns one long-lived ffmpeg, writing a frame only when the picture changes (plus a heartbeat) and writing audio in step with the wall clock. Music is decoded one track at a time by short-lived ffmpeg processes.

**Tech Stack:** Node 18 (the Pi's version), `node:test`, `node:tls`, `node:child_process`, `node:worker_threads`, ffmpeg/ffprobe 6.1. No npm dependencies.

**Spec:** `docs/superpowers/specs/2026-10-07-twitch-plays-puzzlescript-design.md`

## Global Constraints

- All commands run from the worktree root `/Users/stephenlavelle/Documents/GitHub/PuzzleScript/.worktrees/twitch-plays` unless stated. Never `cd` to the main checkout; another session is working there.
- Node 18 compatible: no `node:test` mock timers, no global `WebSocket`, no `Array.prototype.toSorted`. Time and timers are injected (`now`, `setTimer`, `clearTimer`) so tests never wait on real clocks, except the end-to-end test.
- `twitch-bot/` has no runtime or dev dependencies. It may `require` only node built-ins, its own files, and these files in `../discord-bot/`: `engine-host.js`, `worker.js`, `pool.js`, `renderer.js`, `gallery.js`, `gists.js`, `sources.js`, `config.js`.
- Do not edit anything under `src/`. In `discord-bot/`, edit only what Task 1 lists.
- Action vocabulary everywhere: `'up'|'left'|'down'|'right'|'action'|'undo'|'restart'|'continue'`.
- Frame geometry (from the spec): canvas 640×360, tile 10 px (5×5 sprite at ×2), game window 400×300 at (10, 10), side panel x 420–630, title strip y 320–350.
- Limits (from the spec): queue 30, move log 12, message hold 4 s, finished hold 10 s, idle 15 min, active window 10 min, 10 consecutive skips then wait 60 s.
- Audio is 44100 Hz stereo signed 16-bit little-endian PCM everywhere between processes: 4 bytes per sample frame, 176400 bytes per second.
- Secrets live only in `twitch-bot/.env` (never committed). The stream key must never be logged.
- Do not deploy and do not touch the Pi. Going live is the user's step.
- Commit messages start with `twitch-bot: ` (or `discord-bot: ` for Task 1) and end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Tests: run `cd twitch-bot && npm test` after every task from Task 2 on. Run `cd discord-bot && npm test` (about 3 minutes; baseline 68 passing) in Task 1 and Task 10. `discord-bot/node_modules` is already installed in this worktree.

## File Structure

```
discord-bot/                 (shared code; Task 1 only)
  engine-host.js             + host.frameTiles()
  worker.js                  + 'tiles' op
  pool.js                    + pool.tiles(gameId)
  renderer.js                + exports getGlyphs and glyph sizes
twitch-bot/
  package.json               scripts: test, start, index-music
  .gitignore                 node_modules/ data/ .env
  .env.example               documented keys, no values
  README.md                  setup, go-live checklist, operations
  config.js                  .env → config
  commands.js                chat text → command
  chat.js                    Twitch IRC over TLS, read-only
  rotation.js                game order and per-game level progress, persisted
  session.js                 the game being played: queue, log, votes, timers
  frame.js                   view → 640×360 RGBA
  index-music.js             one-off: scan albums → data/music-index.json
  music.js                   shuffled playback as a PCM source
  encoder.js                 the ffmpeg process, frame pacing, audio clock
  main.js                    wiring; exports createApp for the end-to-end test
  deploy.sh                  rsync to ~/puzzlescript-twitch on the Pi
  puzzlescript-twitch.service
  test/*.test.js
```

---

### Task 1: Shared code — frame tiles and font export

**Files:**
- Modify: `discord-bot/engine-host.js` (add two functions after `snapshot()`, one entry in the returned object)
- Modify: `discord-bot/worker.js` (one new `case`)
- Modify: `discord-bot/pool.js` (one new method)
- Modify: `discord-bot/renderer.js` (exports line)
- Test: `discord-bot/test/engine-host.test.js`, `discord-bot/test/pool.test.js`, `discord-bot/test/renderer.test.js` (append)

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `host.frameTiles()` → `{ wall, background, player }`, each `{ colors: string[], dat: number[][] }` or `null`. `dat[row][col]` is a colour index, `-1` for transparent.
  - `pool.tiles(gameId)` → `Promise` of the same object.
  - `require('../discord-bot/renderer')` additionally exports `getGlyphs()` → `{ [char]: boolean[12][5] }`, and numbers `GLYPH_W` (5), `GLYPH_H` (12), `CHAR_W` (6), `CHAR_H` (13).

- [ ] **Step 1: Write the failing tests**

Append to `discord-bot/test/engine-host.test.js`:

```js
const tinyGame = (objects, legend, layers) => `title t\n\n========\nOBJECTS\n========\n\n${objects}\n\n=======\nLEGEND\n=======\n\n${legend}\n\n=======\nSOUNDS\n=======\n\n================\nCOLLISIONLAYERS\n================\n\n${layers}\n\n======\nRULES\n======\n\n==============\nWINCONDITIONS\n==============\n\n=======\nLEVELS\n=======\n\nP.\n`;

test('frameTiles returns the wall, background and player sprites', () => {
  const host = createHost();
  host.load(SOKOBAN, 'seed', 0);
  const t = host.frameTiles();
  assert.deepEqual(t.wall.colors, ['#a46422', '#493c2b']);
  assert.deepEqual(t.wall.dat, [[0, 0, 0, 1, 0], [1, 1, 1, 1, 1], [0, 1, 0, 0, 0], [1, 1, 1, 1, 1], [0, 0, 0, 1, 0]]);
  assert.deepEqual(t.background.colors, ['#a3ce27', '#44891a']);
  assert.deepEqual(t.player.dat[0], [-1, 0, 0, 0, -1]);
  host.dispose();
});

test('frameTiles has no wall when the game defines none', () => {
  const host = createHost();
  host.load(tinyGame('Background\nblack\n\nPlayer\nred', '. = Background\nP = Player', 'Background\nPlayer'), 'seed', 0);
  const t = host.frameTiles();
  assert.equal(t.wall, null);
  assert.deepEqual(t.player.colors, ['#be2633']);
  host.dispose();
});

test('frameTiles resolves wall through the legend to its first member', () => {
  const host = createHost();
  host.load(tinyGame('Background\nblack\n\nPlayer\nred\n\nBrickA\nblue\n\nBrickB\ngreen', '. = Background\nP = Player\nWall = BrickA or BrickB', 'Background\nPlayer, BrickA, BrickB'), 'seed', 0);
  assert.deepEqual(host.frameTiles().wall.colors, ['#1d57f7']);
  host.dispose();
});

test('frameTiles falls back to an object whose name contains wall', () => {
  const host = createHost();
  host.load(tinyGame('Background\nblack\n\nPlayer\nred\n\nStoneWall\ngrey darkgrey\n01010\n10101\n01010\n10101\n01010', '. = Background\nP = Player', 'Background\nPlayer, StoneWall'), 'seed', 0);
  assert.deepEqual(host.frameTiles().wall.colors, ['#9d9d9d', '#697175']);
  host.dispose();
});

test('frameTiles treats a fully transparent wall as no wall', () => {
  const host = createHost();
  host.load(tinyGame('Background\nblack\n\nPlayer\nred\n\nWall\ntransparent', '. = Background\nP = Player', 'Background\nPlayer, Wall'), 'seed', 0);
  assert.equal(host.frameTiles().wall, null);
  host.dispose();
});
```

Append to `discord-bot/test/pool.test.js`:

```js
test('tiles returns the frame sprites through a worker', async () => {
  const pool = createPool({ size: 1 });
  try {
    await pool.load('g1', SOKOBAN, 'seed', 0);
    const t = await pool.tiles('g1');
    assert.deepEqual(t.wall.colors, ['#a46422', '#493c2b']);
    assert.equal(t.player.dat.length, 5);
    assert.throws(() => pool.tiles('nope'), (e) => e.name === 'NoGameError');
  } finally { await pool.close(); }
});
```

Append to `discord-bot/test/renderer.test.js`:

```js
test('getGlyphs exposes the engine font as 12 rows of 5 booleans', () => {
  const { getGlyphs, GLYPH_W, GLYPH_H, CHAR_W, CHAR_H } = require('../renderer');
  const g = getGlyphs();
  assert.equal(g.A.length, 12);
  assert.equal(g.A[0].length, 5);
  assert.deepEqual(g.A[3], [false, true, true, true, false]);
  assert.deepEqual([GLYPH_W, GLYPH_H, CHAR_W, CHAR_H], [5, 12, 6, 13]);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd discord-bot && node --test test/engine-host.test.js test/pool.test.js test/renderer.test.js 2>&1 | tail -15`
Expected: the seven new tests FAIL (`host.frameTiles is not a function`, `pool.tiles is not a function`, `getGlyphs is not a function`); the existing ones pass.

- [ ] **Step 3: Implement**

In `discord-bot/engine-host.js`, insert directly after the closing brace of `function snapshot() { ... }` and before `const DIRS = ...`:

```js
  // The Twitch stream frames the game with its own tiles. A sprite with no visible pixel is no use.
  function spriteOf(o) {
    if (!o || !Array.isArray(o.spritematrix) || !Array.isArray(o.colors)) return null;
    const visible = o.spritematrix.some((row) => Array.from(row).some((v) => v >= 0 && o.colors[v] !== undefined && hexColor(o.colors[v]) !== 'transparent'));
    return visible ? { colors: o.colors.map(hexColor), dat: o.spritematrix.map((row) => Array.from(row)) } : null;
  }

  // A name is looked up among the objects, then through the legend (first member of a
  // synonym, property or aggregate). The wall also accepts any object named like one.
  function frameTiles() {
    const state = ps.state;
    const byName = new Map(Object.keys(state.objects).map((k) => [k.toLowerCase(), state.objects[k]]));
    const resolve = (name, depth) => {
      if (depth > 8) return null;
      if (byName.has(name)) return byName.get(name);
      for (const key of ['legend_synonyms', 'legend_properties', 'legend_aggregates']) {
        for (const e of state[key] || []) {
          if (String(e[0]).toLowerCase() === name) return resolve(String(e[1]).toLowerCase(), depth + 1);
        }
      }
      return null;
    };
    let wall = spriteOf(resolve('wall', 0));
    if (wall === null) {
      for (const [name, o] of byName) {
        if (name.includes('wall') && spriteOf(o) !== null) { wall = spriteOf(o); break; }
      }
    }
    return { wall, background: spriteOf(resolve('background', 0)), player: spriteOf(resolve('player', 0)) };
  }
```

In the object returned at the end of `createHost()`, add `frameTiles,` on the line after `snapshot,`.

In `discord-bot/worker.js`, insert before `case 'drop': {`:

```js
    case 'tiles': {
      const host = hosts.get(gameId);
      if (!host) throw Object.assign(new Error('no such game'), { name: 'NoGameError' });
      return host.frameTiles();
    }
```

In `discord-bot/pool.js`, add after the `snapshot(gameId) { ... },` line:

```js
    tiles(gameId) { return call(entryFor(gameId), gameId, 'tiles', {}, inputMs); },
```

In `discord-bot/renderer.js`, replace the `module.exports = { ... };` line with:

```js
module.exports = { renderSnapshot, renderLevelRGBA, renderTextRGBA, layoutText, levelLayout, parseHex, makeImage, fillRect, getGlyphs, FRAME_W, FRAME_H, GLYPH_W, GLYPH_H, CHAR_W, CHAR_H };
```

- [ ] **Step 4: Run the whole Discord bot suite**

Run: `cd discord-bot && npm test 2>&1 | tail -9`
Expected: `pass 75`, `fail 0` (68 existing + 7 new). Takes about 3 minutes.

- [ ] **Step 5: Commit**

```bash
git add discord-bot/engine-host.js discord-bot/worker.js discord-bot/pool.js discord-bot/renderer.js discord-bot/test/engine-host.test.js discord-bot/test/pool.test.js discord-bot/test/renderer.test.js
git commit -m "discord-bot: expose a game's wall, background and player sprites, and the font

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Scaffold, config and chat commands

**Files:**
- Create: `twitch-bot/package.json`, `twitch-bot/.gitignore`, `twitch-bot/config.js`, `twitch-bot/commands.js`
- Test: `twitch-bot/test/config.test.js`, `twitch-bot/test/commands.test.js`

**Interfaces:**
- Consumes: `parseEnv(text)` from `../discord-bot/config`.
- Produces:
  - `loadPaths(envPath?, processEnv?)` → `{ musicDir, dataDir }`.
  - `loadConfig(envPath?, processEnv?)` → `{ channel, githubToken, output, minFps, musicDir, dataDir }`; throws `Error('missing config: ...')`.
  - `parseCommand(text)` → `{ type: 'input', action }` | `{ type: 'skip' }` | `null`.

- [ ] **Step 1: Scaffold**

`twitch-bot/package.json`:

```json
{
  "name": "puzzlescript-twitch-bot",
  "version": "0.1.0",
  "private": true,
  "description": "Twitch plays PuzzleScript",
  "main": "main.js",
  "engines": { "node": ">=18" },
  "scripts": {
    "test": "node --test",
    "start": "node main.js",
    "index-music": "node index-music.js"
  }
}
```

`twitch-bot/.gitignore`:

```
node_modules/
data/
.env
```

- [ ] **Step 2: Write the failing tests**

`twitch-bot/test/commands.test.js`:

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { parseCommand } = require('../commands');

const input = (action) => ({ type: 'input', action });

test('full words map to actions', () => {
  for (const w of ['up', 'down', 'left', 'right', 'action', 'undo', 'restart']) assert.deepEqual(parseCommand(w), input(w));
});

test('single letters map to actions', () => {
  assert.deepEqual(parseCommand('u'), input('up'));
  assert.deepEqual(parseCommand('d'), input('down'));
  assert.deepEqual(parseCommand('l'), input('left'));
  assert.deepEqual(parseCommand('r'), input('right'));
  assert.deepEqual(parseCommand('a'), input('action'));
  assert.deepEqual(parseCommand('x'), input('action'));
  assert.deepEqual(parseCommand('z'), input('undo'));
});

test('case and surrounding space are ignored', () => {
  assert.deepEqual(parseCommand('  UP '), input('up'));
  assert.deepEqual(parseCommand('R'), input('right'));
  assert.deepEqual(parseCommand('Restart'), input('restart'));
});

test('one leading ! is allowed on inputs', () => {
  assert.deepEqual(parseCommand('!up'), input('up'));
  assert.deepEqual(parseCommand('!z'), input('undo'));
  assert.equal(parseCommand('!!up'), null);
});

test('skip needs the !', () => {
  assert.deepEqual(parseCommand('!skip'), { type: 'skip' });
  assert.deepEqual(parseCommand('!SKIP'), { type: 'skip' });
  assert.equal(parseCommand('skip'), null);
});

test('ordinary chat is not a command', () => {
  for (const t of ['lol right?', 'go up', 'up up', '', '   ', 'uu', 'restart!', 'hasOwnProperty', 'toString']) assert.equal(parseCommand(t), null);
  assert.equal(parseCommand(undefined), null);
});
```

`twitch-bot/test/config.test.js`:

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadConfig, loadPaths } = require('../config');

function envFile(text) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'twitch-config-'));
  const file = path.join(dir, '.env');
  fs.writeFileSync(file, text);
  return file;
}

test('loads a full config with defaults', () => {
  const file = envFile('TWITCH_CHANNEL=#SomeChannel\nTWITCH_STREAM_KEY=live_123\nGITHUB_TOKEN=gh\n');
  const cfg = loadConfig(file, {});
  assert.equal(cfg.channel, 'somechannel');
  assert.equal(cfg.githubToken, 'gh');
  assert.equal(cfg.output, 'rtmp://live.twitch.tv/app/live_123');
  assert.equal(cfg.minFps, 1);
  assert.equal(cfg.musicDir, '/mnt/media/increpare');
  assert.equal(cfg.dataDir, path.join(path.dirname(file), 'data'));
});

test('OUTPUT replaces the Twitch address and makes the key optional', () => {
  const cfg = loadConfig(envFile('TWITCH_CHANNEL=c\nGITHUB_TOKEN=gh\nOUTPUT=/tmp/x.flv\n'), {});
  assert.equal(cfg.output, '/tmp/x.flv');
});

test('names the missing keys', () => {
  assert.throws(() => loadConfig(envFile('GITHUB_TOKEN=gh\n'), {}), /missing config: TWITCH_CHANNEL, TWITCH_STREAM_KEY/);
});

test('MIN_FPS is read, capped at 20, and falls back to 1 when invalid', () => {
  const base = 'TWITCH_CHANNEL=c\nGITHUB_TOKEN=gh\nOUTPUT=o\n';
  assert.equal(loadConfig(envFile(base + 'MIN_FPS=5\n'), {}).minFps, 5);
  assert.equal(loadConfig(envFile(base + 'MIN_FPS=99\n'), {}).minFps, 20);
  assert.equal(loadConfig(envFile(base + 'MIN_FPS=zero\n'), {}).minFps, 1);
  assert.equal(loadConfig(envFile(base + 'MIN_FPS=-2\n'), {}).minFps, 1);
});

test('the process environment overrides the file', () => {
  const cfg = loadConfig(envFile('TWITCH_CHANNEL=c\nGITHUB_TOKEN=gh\nOUTPUT=o\n'), { MUSIC_DIR: '/music', DATA_DIR: '/data' });
  assert.equal(cfg.musicDir, '/music');
  assert.equal(cfg.dataDir, '/data');
});

test('loadPaths needs no Twitch keys', () => {
  const file = envFile('MUSIC_DIR=/m\n');
  assert.deepEqual(loadPaths(file, {}), { musicDir: '/m', dataDir: path.join(path.dirname(file), 'data') });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd twitch-bot && npm test 2>&1 | tail -12`
Expected: FAIL with `Cannot find module '../commands'` and `Cannot find module '../config'`.

- [ ] **Step 4: Implement**

`twitch-bot/commands.js`:

```js
'use strict';

const INPUTS = new Map([
  ['up', 'up'], ['u', 'up'],
  ['down', 'down'], ['d', 'down'],
  ['left', 'left'], ['l', 'left'],
  ['right', 'right'], ['r', 'right'],
  ['action', 'action'], ['a', 'action'], ['x', 'action'],
  ['undo', 'undo'], ['z', 'undo'],
  ['restart', 'restart'], // no single letter: it wipes the level
]);

// The whole message must be a command, so ordinary chat never moves the player.
function parseCommand(text) {
  const t = String(text === undefined || text === null ? '' : text).trim().toLowerCase();
  if (t === '!skip') return { type: 'skip' };
  const word = t.startsWith('!') ? t.slice(1) : t;
  return INPUTS.has(word) ? { type: 'input', action: INPUTS.get(word) } : null;
}

module.exports = { parseCommand };
```

`twitch-bot/config.js`:

```js
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { parseEnv } = require('../discord-bot/config');

const DEFAULT_ENV = path.join(__dirname, '.env');

function readEnv(envPath, processEnv) {
  return Object.assign({}, fs.existsSync(envPath) ? parseEnv(fs.readFileSync(envPath, 'utf8')) : {}, processEnv);
}

// Where the music and the bot's own data live; all that index-music.js needs.
function loadPaths(envPath = DEFAULT_ENV, processEnv = process.env) {
  const env = readEnv(envPath, processEnv);
  return {
    musicDir: env.MUSIC_DIR || '/mnt/media/increpare',
    dataDir: env.DATA_DIR || path.join(path.dirname(envPath), 'data'),
  };
}

function loadConfig(envPath = DEFAULT_ENV, processEnv = process.env) {
  const env = readEnv(envPath, processEnv);
  const required = ['TWITCH_CHANNEL', 'GITHUB_TOKEN'];
  if (!env.OUTPUT) required.push('TWITCH_STREAM_KEY');
  const missing = required.filter((k) => !env[k]);
  if (missing.length) throw new Error('missing config: ' + missing.join(', ') + ' (see .env.example)');
  const minFps = Number(env.MIN_FPS);
  return Object.assign(loadPaths(envPath, processEnv), {
    channel: String(env.TWITCH_CHANNEL).trim().replace(/^#/, '').toLowerCase(),
    githubToken: env.GITHUB_TOKEN,
    output: env.OUTPUT || 'rtmp://live.twitch.tv/app/' + env.TWITCH_STREAM_KEY,
    minFps: Number.isFinite(minFps) && minFps > 0 ? Math.min(minFps, 20) : 1,
  });
}

module.exports = { loadConfig, loadPaths };
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd twitch-bot && npm test 2>&1 | tail -9`
Expected: `pass 12`, `fail 0`.

- [ ] **Step 6: Commit**

```bash
git add twitch-bot/package.json twitch-bot/.gitignore twitch-bot/config.js twitch-bot/commands.js twitch-bot/test/config.test.js twitch-bot/test/commands.test.js
git commit -m "twitch-bot: scaffold, config and chat command parsing

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Twitch chat client

**Files:**
- Create: `twitch-bot/chat.js`
- Test: `twitch-bot/test/chat.test.js`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `parseLine(line)` → `{ type: 'ping', payload }` | `{ type: 'message', user, text }` | `{ type: 'reconnect' }` | `{ type: 'other' }`.
  - `createChat({ channel, onMessage, connect?, setTimer?, clearTimer?, random?, log? })` → `{ start(), close() }`. `onMessage({ user, text })` is called for each chat message; `user` is the lowercase login. `connect(onReady)` must return a socket-like object (`write`, `setEncoding`, `setTimeout`, `destroy`, events `data`/`error`/`close`) and call `onReady` once connected.

Anonymous login (`PASS SCHMOOPIIE`, `NICK justinfan<digits>`) was checked against the real server on 2026-10-07 and is accepted.

- [ ] **Step 1: Write the failing tests**

`twitch-bot/test/chat.test.js`:

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const { parseLine, createChat } = require('../chat');

function harness() {
  const sockets = [], timers = [], messages = [];
  const connect = (onReady) => {
    const s = new EventEmitter();
    s.written = [];
    s.write = (d) => { s.written.push(d); };
    s.setEncoding = () => {};
    s.setTimeout = (ms, fn) => { s.silenceMs = ms; s.onSilence = fn; };
    s.destroy = () => { if (!s.destroyed) { s.destroyed = true; s.emit('close'); } };
    s.ready = onReady;
    sockets.push(s);
    return s;
  };
  const chat = createChat({
    channel: 'somechannel', onMessage: (m) => messages.push(m), connect,
    setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimer: (id) => { timers[id - 1].cleared = true; },
    random: () => 0.5, log: () => {},
  });
  return { chat, sockets, timers, messages };
}

test('parseLine recognises the lines we care about', () => {
  assert.deepEqual(parseLine('PING :tmi.twitch.tv'), { type: 'ping', payload: ':tmi.twitch.tv' });
  assert.deepEqual(parseLine(':Pip!pip@pip.tmi.twitch.tv PRIVMSG #somechannel :Up'), { type: 'message', user: 'pip', text: 'Up' });
  assert.deepEqual(parseLine('@badges=;color=#fff :pip!pip@pip.tmi.twitch.tv PRIVMSG #c :a: b :c'), { type: 'message', user: 'pip', text: 'a: b :c' });
  assert.deepEqual(parseLine(':tmi.twitch.tv RECONNECT'), { type: 'reconnect' });
  assert.deepEqual(parseLine(':tmi.twitch.tv 001 justinfan1 :Welcome, GLHF!'), { type: 'other' });
});

test('logs in anonymously and joins the channel once connected', () => {
  const h = harness();
  h.chat.start();
  assert.equal(h.sockets.length, 1);
  assert.deepEqual(h.sockets[0].written, []);
  h.sockets[0].ready();
  assert.equal(h.sockets[0].written.join(''), 'PASS SCHMOOPIIE\r\nNICK justinfan50000\r\nJOIN #somechannel\r\n');
});

test('answers PING and reports chat messages, even split across chunks', () => {
  const h = harness();
  h.chat.start();
  const s = h.sockets[0];
  s.ready();
  s.written.length = 0;
  s.emit('data', 'PING :tmi.twitch.tv\r\n:pip!pip@pip.tmi.twitch.tv PRIVMSG #somecha');
  assert.deepEqual(s.written, ['PONG :tmi.twitch.tv\r\n']);
  assert.deepEqual(h.messages, []);
  s.emit('data', 'nnel :left\r\n');
  assert.deepEqual(h.messages, [{ user: 'pip', text: 'left' }]);
});

test('a handler that throws does not break the connection', () => {
  const sockets = [];
  const chat = createChat({
    channel: 'c', onMessage: () => { throw new Error('boom'); }, log: () => {},
    connect: (onReady) => { const s = new EventEmitter(); s.write = () => {}; s.setEncoding = () => {}; s.setTimeout = () => {}; s.destroy = () => {}; s.ready = onReady; sockets.push(s); return s; },
  });
  chat.start();
  assert.doesNotThrow(() => sockets[0].emit('data', ':a!a@a PRIVMSG #c :up\r\n'));
});

test('reconnects with a doubling delay that resets once data arrives', () => {
  const h = harness();
  h.chat.start();
  h.sockets[0].destroy();
  assert.equal(h.timers[0].ms, 1000);
  h.timers[0].fn();
  h.sockets[1].destroy();
  assert.equal(h.timers[1].ms, 2000);
  h.timers[1].fn();
  h.sockets[2].emit('data', ':tmi.twitch.tv 001 x :Welcome\r\n');
  h.sockets[2].destroy();
  assert.equal(h.timers[2].ms, 1000);
});

test('the delay never exceeds 30 seconds', () => {
  const h = harness();
  h.chat.start();
  for (let i = 0; i < 8; i++) { h.sockets[i].destroy(); h.timers[i].fn(); }
  assert.equal(h.timers[7].ms, 30000);
});

test('a server RECONNECT and a long silence both drop the connection', () => {
  const h = harness();
  h.chat.start();
  h.sockets[0].emit('data', ':tmi.twitch.tv RECONNECT\r\n');
  assert.equal(h.sockets[0].destroyed, true);
  h.timers[0].fn();
  assert.equal(h.sockets[1].silenceMs, 600000);
  h.sockets[1].onSilence();
  assert.equal(h.sockets[1].destroyed, true);
});

test('close stops reconnecting', () => {
  const h = harness();
  h.chat.start();
  h.chat.close();
  assert.equal(h.sockets[0].destroyed, true);
  assert.equal(h.timers.length, 0);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd twitch-bot && node --test test/chat.test.js 2>&1 | tail -8`
Expected: FAIL with `Cannot find module '../chat'`.

- [ ] **Step 3: Implement**

`twitch-bot/chat.js`:

```js
'use strict';
const tls = require('node:tls');

const HOST = 'irc.chat.twitch.tv';
const FIRST_DELAY = 1000, MAX_DELAY = 30000, SILENCE_MS = 10 * 60 * 1000;

function parseLine(line) {
  let s = String(line);
  if (s.startsWith('PING')) return { type: 'ping', payload: s.slice(4).trim() };
  if (s.startsWith('@')) s = s.slice(s.indexOf(' ') + 1); // IRCv3 tags, should the server send them
  const m = /^:([^!\s]+)!\S+ PRIVMSG #\S+ :(.*)$/.exec(s);
  if (m) return { type: 'message', user: m[1].toLowerCase(), text: m[2] };
  if (/^:\S+ RECONNECT\b/.test(s)) return { type: 'reconnect' };
  return { type: 'other' };
}

function defaultConnect(onReady) {
  return tls.connect({ host: HOST, port: 6697, servername: HOST }, onReady);
}

// Read-only chat: an anonymous login needs no Twitch account or token.
function createChat({ channel, onMessage, connect = defaultConnect, setTimer = setTimeout, clearTimer = clearTimeout, random = Math.random, log = console.log }) {
  let socket = null, timer = null, delay = FIRST_DELAY, closed = false;

  function open() {
    timer = null;
    if (closed) return;
    let buffer = '';
    const sock = connect(() => {
      sock.write('PASS SCHMOOPIIE\r\nNICK justinfan' + (10000 + Math.floor(random() * 80000)) + '\r\nJOIN #' + channel + '\r\n');
    });
    socket = sock;
    sock.setEncoding('utf8');
    // Twitch pings every few minutes, so a long silence means the connection is dead.
    sock.setTimeout(SILENCE_MS, () => sock.destroy());
    sock.on('data', (chunk) => {
      delay = FIRST_DELAY;
      buffer += chunk;
      const lines = buffer.split('\r\n');
      buffer = lines.pop();
      for (const line of lines) {
        const msg = parseLine(line);
        if (msg.type === 'ping') sock.write('PONG ' + msg.payload + '\r\n');
        else if (msg.type === 'reconnect') sock.destroy();
        else if (msg.type === 'message') {
          try { onMessage({ user: msg.user, text: msg.text }); } catch (e) { log('chat handler failed', e); }
        }
      }
    });
    sock.on('error', (e) => log('chat error', e && e.message));
    sock.on('close', () => {
      if (socket !== sock) return;
      socket = null;
      if (closed) return;
      log('chat closed, reconnecting in ' + delay + ' ms');
      timer = setTimer(open, delay);
      delay = Math.min(delay * 2, MAX_DELAY);
    });
  }

  return {
    start() { if (!closed && socket === null && timer === null) open(); },
    close() {
      closed = true;
      if (timer !== null) { clearTimer(timer); timer = null; }
      if (socket) socket.destroy();
    },
  };
}

module.exports = { parseLine, createChat };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd twitch-bot && npm test 2>&1 | tail -9`
Expected: `pass 20`, `fail 0`.

- [ ] **Step 5: Commit**

```bash
git add twitch-bot/chat.js twitch-bot/test/chat.test.js
git commit -m "twitch-bot: read-only Twitch chat client with reconnect

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Game rotation and level progress

**Files:**
- Create: `twitch-bot/rotation.js`
- Test: `twitch-bot/test/rotation.test.js`

**Interfaces:**
- Consumes: gallery entries `{ gistId, title, author }` as returned by `loadGallery()` in `../discord-bot/gallery`.
- Produces: `createRotation({ gallery, dataDir, random? })` →
  - `current()` → the entry to play now.
  - `advance()` → moves to the next entry, reshuffling after the last, persists, returns the new current entry.
  - `savedLevel(gistId)` → level index to start at (0 if none).
  - `saveLevel(gistId, levelIndex)`, `clearLevel(gistId)`.
  - Files: `<dataDir>/state.json` `{ order: string[], pos: number }`, `<dataDir>/progress.json` `{ [gistId]: number }`.

- [ ] **Step 1: Write the failing tests**

`twitch-bot/test/rotation.test.js`:

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRotation } = require('../rotation');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'twitch-rotation-'));
const GALLERY = [
  { gistId: 'aaa1', title: 'One', author: 'a' },
  { gistId: 'bbb2', title: 'Two', author: 'b' },
  { gistId: 'ccc3', title: 'Three', author: 'c' },
];

test('plays every game once before any repeats', () => {
  const r = createRotation({ gallery: GALLERY, dataDir: tmp() });
  const seen = [r.current().gistId, r.advance().gistId, r.advance().gistId];
  assert.deepEqual(seen.slice().sort(), ['aaa1', 'bbb2', 'ccc3']);
  assert.ok(GALLERY.some((g) => g.gistId === r.advance().gistId));
});

test('current is stable until advance', () => {
  const r = createRotation({ gallery: GALLERY, dataDir: tmp() });
  assert.equal(r.current(), r.current());
  assert.equal(r.current().title.length > 0, true);
});

test('order and position survive a restart', () => {
  const dir = tmp();
  const a = createRotation({ gallery: GALLERY, dataDir: dir });
  a.advance();
  const expected = a.current().gistId;
  const b = createRotation({ gallery: GALLERY, dataDir: dir });
  assert.equal(b.current().gistId, expected);
  assert.equal(b.advance().gistId, a.advance().gistId);
});

test('a saved order that no longer matches the gallery is replaced', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ order: ['aaa1', 'gone', 'ccc3'], pos: 1 }));
  const r = createRotation({ gallery: GALLERY, dataDir: dir });
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
  assert.deepEqual(saved.order.slice().sort(), ['aaa1', 'bbb2', 'ccc3']);
  assert.equal(saved.pos, 0);
  assert.ok(r.current());
});

test('corrupt files are ignored', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'state.json'), '{not json');
  fs.writeFileSync(path.join(dir, 'progress.json'), '[1,2');
  const r = createRotation({ gallery: GALLERY, dataDir: dir });
  assert.ok(r.current());
  assert.equal(r.savedLevel('aaa1'), 0);
});

test('level progress is saved, read back after a restart, and cleared', () => {
  const dir = tmp();
  const a = createRotation({ gallery: GALLERY, dataDir: dir });
  assert.equal(a.savedLevel('aaa1'), 0);
  a.saveLevel('aaa1', 4);
  assert.equal(a.savedLevel('aaa1'), 4);
  const b = createRotation({ gallery: GALLERY, dataDir: dir });
  assert.equal(b.savedLevel('aaa1'), 4);
  b.clearLevel('aaa1');
  assert.equal(createRotation({ gallery: GALLERY, dataDir: dir }).savedLevel('aaa1'), 0);
});

test('an empty gallery is an error', () => {
  assert.throws(() => createRotation({ gallery: [], dataDir: tmp() }), /gallery is empty/);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd twitch-bot && node --test test/rotation.test.js 2>&1 | tail -8`
Expected: FAIL with `Cannot find module '../rotation'`.

- [ ] **Step 3: Implement**

`twitch-bot/rotation.js`:

```js
'use strict';
const fs = require('node:fs');
const path = require('node:path');

function shuffled(items, random) {
  const a = items.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    const t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a;
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return null; }
}

function writeJson(file, value) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value));
  fs.renameSync(tmp, file);
}

// Which gallery game is next, and how far chat got in each one.
function createRotation({ gallery, dataDir, random = Math.random }) {
  if (!gallery.length) throw new Error('the gallery is empty');
  fs.mkdirSync(dataDir, { recursive: true });
  const stateFile = path.join(dataDir, 'state.json');
  const progressFile = path.join(dataDir, 'progress.json');
  const byId = new Map(gallery.map((g) => [g.gistId, g]));
  const fresh = () => ({ order: shuffled([...byId.keys()], random), pos: 0 });

  let state = readJson(stateFile);
  const usable = state && Array.isArray(state.order) && state.order.length === byId.size
    && new Set(state.order).size === byId.size && state.order.every((id) => byId.has(id))
    && Number.isInteger(state.pos) && state.pos >= 0 && state.pos < state.order.length;
  if (!usable) { state = fresh(); writeJson(stateFile, state); }

  const loaded = readJson(progressFile);
  const progress = loaded && typeof loaded === 'object' && !Array.isArray(loaded) ? loaded : {};

  return {
    current: () => byId.get(state.order[state.pos]),
    advance() {
      state.pos++;
      if (state.pos >= state.order.length) state = fresh();
      writeJson(stateFile, state);
      return byId.get(state.order[state.pos]);
    },
    savedLevel: (gistId) => (Number.isInteger(progress[gistId]) && progress[gistId] > 0 ? progress[gistId] : 0),
    saveLevel(gistId, levelIndex) { progress[gistId] = levelIndex; writeJson(progressFile, progress); },
    clearLevel(gistId) {
      if (!(gistId in progress)) return;
      delete progress[gistId];
      writeJson(progressFile, progress);
    },
  };
}

module.exports = { createRotation, shuffled };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd twitch-bot && npm test 2>&1 | tail -9`
Expected: `pass 27`, `fail 0`.

- [ ] **Step 5: Commit**

```bash
git add twitch-bot/rotation.js twitch-bot/test/rotation.test.js
git commit -m "twitch-bot: shuffled gallery rotation with saved level progress

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: The session — one game and what chat does to it

**Files:**
- Create: `twitch-bot/session.js`
- Test: `twitch-bot/test/session.test.js`

**Interfaces:**
- Consumes:
  - `parseCommand(text)` (Task 2).
  - A pool with `load(gameId, source, seed, levelIndex)` → `Promise<{ title, author, levelCount, flags: { noaction, noundo, norestart, realtime } }>`, `input(gameId, action)` → `Promise<boolean>`, `snapshot(gameId)` → `Promise<snapshot>`, `tiles(gameId)` → `Promise<{ wall, background, player }>`, `drop(gameId)` → `Promise` (Task 1; `discord-bot/pool.js`). A snapshot has `kind` (`'level'|'message'|'finished'`), `levelIndex`, `levelCount`, `message`, `background`, `textColor`.
  - A rotation with `current()`, `advance()`, `savedLevel(id)`, `saveLevel(id, n)`, `clearLevel(id)` (Task 4).
  - `getSource(gistId)` → `Promise<string>`.
- Produces: `createSession({ pool, getSource, rotation, now?, onChange?, log? })` →
  - `start()` → `Promise`, loads the rotation's current game.
  - `handleChat({ user, text })`.
  - `tick()` — call a few times a second; drives the finished hold, idle rotation and retry.
  - `view()` → `{ phase, entry, meta, snapshot, tiles, moves, votes }` where `phase` is `'loading'|'playing'|'finished'|'waiting'`, `moves` is `[{ action, user }]` newest first (at most 12), `votes` is `{ count, needed }`. Before any game loads and while waiting, `snapshot` is a `'message'` snapshot reading `back soon` and `entry`, `meta`, `tiles` are `null`.
  - `idle()` → `Promise` resolving when all queued work is done (test aid).
  - `onChange()` is called whenever `view()` would return something different.

- [ ] **Step 1: Write the failing tests**

`twitch-bot/test/session.test.js`:

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createSession } = require('../session');

// A toy engine: a game is a list of screens. On a level, 'right' solves it; everything else is
// applied without effect (undo is refused when noundo). On a message only 'continue' works.
function fakePool() {
  const games = new Map(), calls = [];
  const snap = (g) => {
    const kind = g.index >= g.def.screens.length ? 'finished' : g.def.screens[g.index];
    return { kind, levelIndex: g.index, levelCount: g.def.screens.length, message: kind === 'message' ? 'm' + g.index : null, background: '#000000', textColor: '#ffffff' };
  };
  return {
    calls,
    async load(id, source, seed, level) {
      calls.push(['load', id, level]);
      const def = JSON.parse(source);
      if (def.compileError) throw Object.assign(new Error('bad'), { name: 'CompileError' });
      games.set(id, { def, index: level });
      return { title: def.title, author: 'someone', levelCount: def.screens.length, flags: { noaction: false, noundo: !!def.noundo, norestart: false, realtime: !!def.realtime } };
    },
    async snapshot(id) { return snap(games.get(id)); },
    async tiles() { return { wall: null, background: null, player: null }; },
    async input(id, action) {
      calls.push(['input', id, action]);
      const g = games.get(id);
      if (g.def.failOn === action) throw Object.assign(new Error('timeout'), { name: 'TimeoutError' });
      const kind = snap(g).kind;
      if (kind === 'message') { if (action !== 'continue') return false; g.index++; return true; }
      if (kind !== 'level') return false;
      if (action === 'undo' && g.def.noundo) return false;
      if (action === 'right') g.index++;
      return true;
    },
    async drop(id) { calls.push(['drop', id]); games.delete(id); },
  };
}

function fakeRotation(entries, saved = {}) {
  let pos = 0;
  const calls = [];
  return {
    calls, saved,
    current: () => entries[pos % entries.length],
    advance() { pos++; return entries[pos % entries.length]; },
    savedLevel: (id) => saved[id] || 0,
    saveLevel(id, level) { saved[id] = level; calls.push(['save', id, level]); },
    clearLevel(id) { delete saved[id]; calls.push(['clear', id]); },
  };
}

// defs: { gistId: game definition }. Entries are played in the order given.
function setup(defs, saved) {
  const clock = { t: 1000000 };
  const pool = fakePool();
  const entries = Object.keys(defs).map((gistId) => ({ gistId, title: defs[gistId].title, author: 'someone' }));
  const rotation = fakeRotation(entries, saved);
  let changes = 0;
  const session = createSession({
    pool, rotation, now: () => clock.t, onChange: () => { changes++; }, log: () => {},
    getSource: async (id) => JSON.stringify(defs[id]),
  });
  const say = (user, text) => session.handleChat({ user, text });
  return { clock, pool, rotation, session, say, changes: () => changes };
}

const LEVELS3 = { title: 'Three', screens: ['level', 'level', 'level'] };

test('start loads the current game and shows it', async () => {
  const h = setup({ g1: LEVELS3 });
  assert.equal(h.session.view().phase, 'loading');
  assert.equal(h.session.view().snapshot.message, 'back soon');
  await h.session.start();
  const v = h.session.view();
  assert.equal(v.phase, 'playing');
  assert.equal(v.entry.gistId, 'g1');
  assert.equal(v.meta.title, 'Three');
  assert.equal(v.snapshot.kind, 'level');
  assert.deepEqual(v.tiles, { wall: null, background: null, player: null });
  assert.deepEqual(v.moves, []);
  assert.ok(h.changes() >= 1);
});

test('commands apply in arrival order and are logged newest first', async () => {
  const h = setup({ g1: LEVELS3 });
  await h.session.start();
  h.say('pip', 'up');
  h.say('mo', 'L');
  h.say('pip', 'x');
  await h.session.idle();
  assert.deepEqual(h.pool.calls.filter((c) => c[0] === 'input').map((c) => c[2]), ['up', 'left', 'action']);
  assert.deepEqual(h.session.view().moves, [{ action: 'action', user: 'pip' }, { action: 'left', user: 'mo' }, { action: 'up', user: 'pip' }]);
});

test('ordinary chat does nothing', async () => {
  const h = setup({ g1: LEVELS3 });
  await h.session.start();
  h.say('pip', 'lol right?');
  await h.session.idle();
  assert.deepEqual(h.session.view().moves, []);
});

test('a command the game refuses is not logged', async () => {
  const h = setup({ g1: { title: 'NoUndo', screens: ['level'], noundo: true } });
  await h.session.start();
  h.say('pip', 'undo');
  await h.session.idle();
  assert.deepEqual(h.session.view().moves, []);
});

test('the log keeps only the last 12 moves', async () => {
  const h = setup({ g1: LEVELS3 });
  await h.session.start();
  for (let i = 0; i < 15; i++) h.say('u' + i, 'up');
  await h.session.idle();
  const moves = h.session.view().moves;
  assert.equal(moves.length, 12);
  assert.equal(moves[0].user, 'u14');
});

test('at most 30 commands wait', async () => {
  const h = setup({ g1: LEVELS3 });
  await h.session.start();
  for (let i = 0; i < 40; i++) h.say('pip', 'up');
  await h.session.idle();
  assert.equal(h.pool.calls.filter((c) => c[0] === 'input').length, 30);
});

test('a message stays up 4 seconds, then any move or action dismisses it', async () => {
  const h = setup({ g1: { title: 'Msg', screens: ['message', 'level'] } });
  await h.session.start();
  assert.equal(h.session.view().snapshot.kind, 'message');
  h.clock.t += 3999;
  h.say('pip', 'a');
  await h.session.idle();
  assert.equal(h.session.view().snapshot.kind, 'message');
  h.clock.t += 1;
  h.say('pip', 'undo');
  await h.session.idle();
  assert.equal(h.session.view().snapshot.kind, 'message');
  h.say('pip', 'u');
  await h.session.idle();
  assert.equal(h.session.view().snapshot.kind, 'level');
  assert.deepEqual(h.session.view().moves, [{ action: 'continue', user: 'pip' }]);
});

test('queued commands are dropped when the level changes', async () => {
  const h = setup({ g1: LEVELS3 });
  await h.session.start();
  h.say('pip', 'right');
  h.say('mo', 'up');
  h.say('mo', 'up');
  await h.session.idle();
  assert.equal(h.session.view().snapshot.levelIndex, 1);
  assert.deepEqual(h.session.view().moves, [{ action: 'right', user: 'pip' }]);
});

test('the level reached is saved as it advances', async () => {
  const h = setup({ g1: LEVELS3 });
  await h.session.start();
  h.say('pip', 'right');
  await h.session.idle();
  h.say('pip', 'right');
  await h.session.idle();
  assert.deepEqual(h.rotation.calls, [['save', 'g1', 1], ['save', 'g1', 2]]);
});

test('a game resumes at its saved level', async () => {
  const h = setup({ g1: LEVELS3 }, { g1: 2 });
  await h.session.start();
  assert.equal(h.session.view().snapshot.levelIndex, 2);
  assert.deepEqual(h.pool.calls[0].slice(0, 3), ['load', 'tw1', 2]);
});

test('a saved level past the end starts the game over', async () => {
  const h = setup({ g1: { title: 'Short', screens: ['level', 'level'] } }, { g1: 5 });
  await h.session.start();
  assert.equal(h.session.view().phase, 'playing');
  assert.equal(h.session.view().snapshot.levelIndex, 0);
  assert.deepEqual(h.rotation.calls, [['clear', 'g1']]);
});

test('winning shows the finished screen for 10 seconds, then the next game', async () => {
  const h = setup({ g1: { title: 'One', screens: ['level'] }, g2: LEVELS3 });
  await h.session.start();
  h.say('pip', 'right');
  await h.session.idle();
  assert.equal(h.session.view().phase, 'finished');
  assert.equal(h.session.view().snapshot.kind, 'finished');
  assert.deepEqual(h.rotation.calls, [['clear', 'g1']]);
  h.say('pip', 'up');
  h.clock.t += 9999;
  h.session.tick();
  await h.session.idle();
  assert.equal(h.session.view().entry.gistId, 'g1');
  h.clock.t += 1;
  h.session.tick();
  h.session.tick();
  await h.session.idle();
  assert.equal(h.session.view().entry.gistId, 'g2');
  assert.equal(h.session.view().phase, 'playing');
  assert.deepEqual(h.session.view().moves, []);
  assert.ok(h.pool.calls.some((c) => c[0] === 'drop' && c[1] === 'tw1'));
});

test('15 minutes without a move brings the next game', async () => {
  const h = setup({ g1: LEVELS3, g2: LEVELS3 });
  await h.session.start();
  h.clock.t += 14 * 60000;
  h.say('pip', 'up');
  await h.session.idle();
  h.clock.t += 14 * 60000;
  h.session.tick();
  await h.session.idle();
  assert.equal(h.session.view().entry.gistId, 'g1');
  h.clock.t += 60000;
  h.session.tick();
  await h.session.idle();
  assert.equal(h.session.view().entry.gistId, 'g2');
});

test('one skip vote is enough when nobody has been playing', async () => {
  const h = setup({ g1: LEVELS3, g2: LEVELS3 });
  await h.session.start();
  assert.deepEqual(h.session.view().votes, { count: 0, needed: 1 });
  h.say('pip', '!skip');
  await h.session.idle();
  assert.equal(h.session.view().entry.gistId, 'g2');
  assert.deepEqual(h.session.view().votes, { count: 0, needed: 1 });
});

test('skip needs half the recent players, at most 3, and counts each voter once', async () => {
  const h = setup({ g1: LEVELS3, g2: LEVELS3 });
  await h.session.start();
  for (const u of ['a', 'b', 'c', 'd']) h.say(u, 'up');
  await h.session.idle();
  assert.equal(h.session.view().votes.needed, 2);
  h.say('a', '!skip');
  h.say('a', '!skip');
  await h.session.idle();
  assert.equal(h.session.view().entry.gistId, 'g1');
  assert.deepEqual(h.session.view().votes, { count: 1, needed: 2 });
  for (const u of ['e', 'f', 'g']) h.say(u, 'up');
  await h.session.idle();
  assert.equal(h.session.view().votes.needed, 3);
  h.say('b', '!skip');
  await h.session.idle();
  assert.equal(h.session.view().entry.gistId, 'g1');
  h.say('zed', '!skip');
  await h.session.idle();
  assert.equal(h.session.view().entry.gistId, 'g2');
});

test('players stop counting as recent after 10 minutes', async () => {
  const h = setup({ g1: LEVELS3, g2: LEVELS3 });
  await h.session.start();
  for (const u of ['a', 'b', 'c', 'd', 'e', 'f']) h.say(u, 'up');
  await h.session.idle();
  assert.equal(h.session.view().votes.needed, 3);
  h.clock.t += 10 * 60000 + 1;
  h.say('a', 'up');
  await h.session.idle();
  assert.equal(h.session.view().votes.needed, 1);
});

test('realtime games and games that do not compile are skipped', async () => {
  const h = setup({ g1: { title: 'RT', screens: ['level'], realtime: true }, g2: { title: 'Bad', screens: [], compileError: true }, g3: LEVELS3 });
  await h.session.start();
  assert.equal(h.session.view().entry.gistId, 'g3');
  assert.ok(h.pool.calls.some((c) => c[0] === 'drop' && c[1] === 'tw1'));
});

test('a game with nothing to play is skipped', async () => {
  const h = setup({ g1: { title: 'Empty', screens: [] }, g2: LEVELS3 });
  await h.session.start();
  assert.equal(h.session.view().entry.gistId, 'g2');
});

test('after 10 skips in a row it waits a minute showing back soon, then carries on', async () => {
  const defs = {};
  for (let i = 0; i < 10; i++) defs['bad' + i] = { title: 'Bad', screens: [], compileError: true };
  defs.good = LEVELS3;
  const h = setup(defs);
  await h.session.start();
  let v = h.session.view();
  assert.equal(v.phase, 'waiting');
  assert.equal(v.snapshot.message, 'back soon');
  assert.equal(v.entry, null);
  assert.equal(h.pool.calls.filter((c) => c[0] === 'load').length, 10);
  h.say('pip', 'up');
  h.clock.t += 59999;
  h.session.tick();
  await h.session.idle();
  assert.equal(h.session.view().phase, 'waiting');
  h.clock.t += 1;
  h.session.tick();
  await h.session.idle();
  v = h.session.view();
  assert.equal(v.phase, 'playing');
  assert.equal(v.entry.gistId, 'good');
});

test('a game that fails mid-play is dropped for the next one', async () => {
  const h = setup({ g1: { title: 'Hangs', screens: ['level'], failOn: 'action' }, g2: LEVELS3 });
  await h.session.start();
  h.say('pip', 'a');
  await h.session.idle();
  assert.equal(h.session.view().entry.gistId, 'g2');
  assert.equal(h.session.view().phase, 'playing');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd twitch-bot && node --test test/session.test.js 2>&1 | tail -8`
Expected: FAIL with `Cannot find module '../session'`.

- [ ] **Step 3: Implement**

`twitch-bot/session.js`:

```js
'use strict';
const { parseCommand } = require('./commands');

const MAX_QUEUE = 30, LOG_SIZE = 12;
const MESSAGE_HOLD_MS = 4000, FINISHED_HOLD_MS = 10000, IDLE_MS = 15 * 60 * 1000;
const ACTIVE_MS = 10 * 60 * 1000, MAX_SKIPS = 10, RETRY_MS = 60000;
const DISMISSERS = ['up', 'down', 'left', 'right', 'action'];
const BACK_SOON = { kind: 'message', message: 'back soon', levelIndex: 0, levelCount: 0, background: '#000000', textColor: '#ffffff' };

const skip = (why) => Object.assign(new Error(why), { name: 'SkipError' });

// The game on screen and everything chat does to it. All engine work goes through one
// promise chain, so commands are applied strictly in the order they arrived.
function createSession({ pool, getSource, rotation, now = Date.now, onChange = () => {}, log = console.log }) {
  let phase = 'loading';
  let counter = 0, gameId = null, entry = null, meta = null, snapshot = BACK_SOON, tiles = null;
  let queue = [], moves = [], votes = new Set();
  const activity = new Map(); // login -> when their last command was applied
  let lastApplied = 0, messageSince = 0, finishedAt = 0, retryAt = 0;
  let chain = Promise.resolve(), pumping = false, switching = false;

  function run(fn) {
    chain = chain.then(fn).catch((e) => log('session error', e));
    return chain;
  }

  async function loadGame(e) {
    const source = await getSource(e.gistId);
    const id = 'tw' + (++counter);
    try {
      let level = rotation.savedLevel(e.gistId);
      let m = await pool.load(id, source, id, level);
      if (m.flags.realtime) throw skip('realtime game');
      let snap = await pool.snapshot(id);
      if (level > 0 && snap.kind === 'finished') {
        // the saved level is past the end (the game was edited): start over
        rotation.clearLevel(e.gistId);
        m = await pool.load(id, source, id, 0);
        snap = await pool.snapshot(id);
      }
      if (snap.kind === 'finished') throw skip('nothing to play');
      return { id, meta: m, snapshot: snap, tiles: await pool.tiles(id) };
    } catch (err) {
      await pool.drop(id).catch(() => {});
      throw err;
    }
  }

  async function switchGame(advance) {
    phase = 'loading';
    queue = [];
    votes = new Set();
    const old = gameId;
    gameId = null;
    if (old) await pool.drop(old).catch(() => {});
    let e = advance ? rotation.advance() : rotation.current();
    for (let skips = 0; skips < MAX_SKIPS; skips++) {
      try {
        const g = await loadGame(e);
        gameId = g.id; entry = e; meta = g.meta; snapshot = g.snapshot; tiles = g.tiles;
        moves = [];
        lastApplied = now();
        messageSince = now();
        phase = 'playing';
        onChange();
        return;
      } catch (err) {
        log('skipping ' + e.title + ': ' + (err && err.name) + ' ' + (err && err.message));
        e = rotation.advance();
      }
    }
    // nothing loads (GitHub is probably unreachable): show a holding screen and try again later
    entry = null; meta = null; snapshot = BACK_SOON; tiles = null; moves = [];
    retryAt = now() + RETRY_MS;
    phase = 'waiting';
    onChange();
  }

  function requestSwitch(advance) {
    if (switching) return;
    switching = true;
    run(async () => {
      try { await switchGame(advance); } finally { switching = false; }
    });
  }

  function needed() {
    const cutoff = now() - ACTIVE_MS;
    let active = 0;
    for (const at of activity.values()) if (at >= cutoff) active++;
    return Math.max(1, Math.min(3, Math.ceil(active / 2)));
  }

  async function applyOne(item) {
    let action = item.action;
    if (snapshot.kind === 'message') {
      if (now() - messageSince < MESSAGE_HOLD_MS || !DISMISSERS.includes(action)) return;
      action = 'continue';
    }
    if (!(await pool.input(gameId, action))) return;
    const prev = snapshot;
    snapshot = await pool.snapshot(gameId);
    lastApplied = now();
    activity.set(item.user, now());
    moves.unshift({ action, user: item.user });
    if (moves.length > LOG_SIZE) moves.length = LOG_SIZE;
    if (snapshot.kind === 'finished') {
      phase = 'finished';
      finishedAt = now();
      queue = [];
      rotation.clearLevel(entry.gistId);
    } else {
      const newMessage = snapshot.kind === 'message' && (prev.kind !== 'message' || snapshot.levelIndex !== prev.levelIndex);
      if (newMessage) messageSince = now();
      // moves typed at the old screen must not spill into the new one
      if (newMessage || snapshot.levelIndex !== prev.levelIndex) queue = [];
      if (snapshot.levelIndex > prev.levelIndex) rotation.saveLevel(entry.gistId, snapshot.levelIndex);
    }
    onChange();
  }

  function pump() {
    if (pumping) return;
    pumping = true;
    run(async () => {
      try {
        while (queue.length && phase === 'playing') {
          const item = queue.shift();
          try {
            await applyOne(item);
          } catch (err) {
            log('game failed: ' + (entry && entry.title) + ': ' + (err && err.name) + ' ' + (err && err.message));
            await switchGame(true);
          }
        }
      } finally { pumping = false; }
    });
  }

  return {
    start: () => run(() => switchGame(false)),
    handleChat({ user, text }) {
      const cmd = parseCommand(text);
      if (!cmd || phase !== 'playing') return;
      if (cmd.type === 'skip') {
        votes.add(user);
        if (votes.size >= needed()) requestSwitch(true); else onChange();
        return;
      }
      if (queue.length >= MAX_QUEUE) return;
      queue.push({ user, action: cmd.action });
      pump();
    },
    tick() {
      const t = now();
      for (const [user, at] of activity) if (t - at > ACTIVE_MS) activity.delete(user);
      if (phase === 'finished' && t - finishedAt >= FINISHED_HOLD_MS) requestSwitch(true);
      else if (phase === 'playing' && t - lastApplied >= IDLE_MS) requestSwitch(true);
      else if (phase === 'waiting' && t >= retryAt) requestSwitch(false);
    },
    view: () => ({ phase, entry, meta, snapshot, tiles, moves: moves.slice(), votes: { count: votes.size, needed: needed() } }),
    idle: () => chain,
  };
}

module.exports = { createSession };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd twitch-bot && npm test 2>&1 | tail -9`
Expected: `pass 47`, `fail 0`.

- [ ] **Step 5: Commit**

```bash
git add twitch-bot/session.js twitch-bot/test/session.test.js
git commit -m "twitch-bot: session with ordered inputs, move log, skip votes and rotation triggers

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: The frame

**Files:**
- Create: `twitch-bot/frame.js`
- Test: `twitch-bot/test/frame.test.js`

**Interfaces:**
- Consumes: from `../discord-bot/renderer` — `makeImage(w, h, bgHex)` → `{ width, height, rgba: Uint8Array }`, `fillRect(img, x, y, w, h, [r, g, b])`, `parseHex(hex)` → `[r, g, b, a]`, `renderLevelRGBA(snapshot)` and `renderTextRGBA(snapshot)` → 400×300 images, `getGlyphs()` (Task 1). The session view shape (Task 5). Tile sprites `{ colors, dat }` (Task 1).
- Produces: `composeFrame({ snapshot, tiles, meta, moves, votes, music })` → `{ width: 640, height: 360, rgba: Uint8Array }`. `tiles`, `meta` and `music` may be `null`; `music` is otherwise `{ title, album }`. Also exports `WIDTH` (640) and `HEIGHT` (360).

- [ ] **Step 1: Write the failing tests**

`twitch-bot/test/frame.test.js`:

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { createHost } = require('../../discord-bot/engine-host');
const { renderLevelRGBA } = require('../../discord-bot/renderer');
const { composeFrame, WIDTH, HEIGHT } = require('../frame');

const SOKOBAN = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'demo', 'sokoban_basic.txt'), 'utf8');
const host = createHost();
const META = host.load(SOKOBAN, 'seed', 0);
const SNAP = host.snapshot();
const TILES = host.frameTiles();

const px = (img, x, y) => { const i = (y * img.width + x) * 4; return [img.rgba[i], img.rgba[i + 1], img.rgba[i + 2]]; };
const view = (over) => Object.assign({ snapshot: SNAP, tiles: TILES, meta: META, moves: [], votes: { count: 0, needed: 1 }, music: null }, over);
const same = (a, b) => Buffer.compare(Buffer.from(a.rgba), Buffer.from(b.rgba)) === 0;
// true if a and b differ somewhere, and only inside the rectangle
function differsOnlyIn(a, b, x0, y0, x1, y1) {
  let inside = false;
  for (let y = 0; y < a.height; y++) for (let x = 0; x < a.width; x++) {
    const i = (y * a.width + x) * 4;
    if (a.rgba[i] === b.rgba[i] && a.rgba[i + 1] === b.rgba[i + 1] && a.rgba[i + 2] === b.rgba[i + 2]) continue;
    if (x < x0 || x >= x1 || y < y0 || y >= y1) return false;
    inside = true;
  }
  return inside;
}
const count = (img, rgb, x0, y0, x1, y1) => {
  let n = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const p = px(img, x, y); if (p[0] === rgb[0] && p[1] === rgb[1] && p[2] === rgb[2]) n++; }
  return n;
};

test('the frame is 640x360 and fully opaque', () => {
  const img = composeFrame(view());
  assert.equal(WIDTH, 640);
  assert.equal(HEIGHT, 360);
  assert.equal(img.width, 640);
  assert.equal(img.height, 360);
  assert.equal(img.rgba.length, 640 * 360 * 4);
  for (let i = 3; i < img.rgba.length; i += 4) assert.equal(img.rgba[i], 255);
});

test('without a wall the border is the classic brick', () => {
  const img = composeFrame(view({ tiles: null }));
  assert.deepEqual(px(img, 0, 0), [164, 100, 34]);
  assert.deepEqual(px(img, 6, 0), [73, 60, 43]);
  assert.deepEqual(px(img, 635, 355), px(img, 5, 5));
  assert.deepEqual(px(img, 415, 315), px(img, 5, 5));
});

test('the border uses the game wall over the game background', () => {
  const wall = { colors: ['#ff0000'], dat: [[-1, 0, 0, 0, 0], [0, 0, 0, 0, 0], [0, 0, 0, 0, 0], [0, 0, 0, 0, 0], [0, 0, 0, 0, 0]] };
  const background = { colors: ['#00ff00'], dat: [[0, 0, 0, 0, 0], [0, 0, 0, 0, 0], [0, 0, 0, 0, 0], [0, 0, 0, 0, 0], [0, 0, 0, 0, 0]] };
  const img = composeFrame(view({ tiles: { wall, background, player: null } }));
  assert.deepEqual(px(img, 0, 0), [0, 255, 0]);
  assert.deepEqual(px(img, 2, 0), [255, 0, 0]);
  assert.deepEqual(px(img, 630, 100), [0, 255, 0]);
  assert.deepEqual(px(img, 412, 200), [255, 0, 0]);
  assert.deepEqual(px(img, 200, 312), [255, 0, 0]);
  const noBackground = composeFrame(view({ tiles: { wall, background: null, player: null } }));
  assert.deepEqual(px(noBackground, 0, 0), [0, 0, 0]);
});

test('the game window is the rendered level at (10, 10)', () => {
  const img = composeFrame(view());
  const level = renderLevelRGBA(SNAP);
  for (const [x, y] of [[0, 0], [200, 150], [399, 299], [123, 77], [250, 160]]) assert.deepEqual(px(img, 10 + x, 10 + y), px(level, x, y));
});

test('the heading is drawn in pink and white', () => {
  const img = composeFrame(view());
  assert.ok(count(img, [222, 101, 226], 420, 16, 630, 40) > 100);
  assert.ok(count(img, [255, 255, 255], 420, 42, 630, 66) > 100);
});

test('the title strip shows title, author, level and music', () => {
  const base = composeFrame(view());
  assert.ok(count(base, [255, 255, 255], 10, 320, 410, 334) > 20, 'title');
  assert.ok(count(base, [247, 226, 107], 10, 320, 410, 334) > 20, 'level counter');
  const withMusic = composeFrame(view({ music: { title: 'Reaction', album: 'English Country Tune' } }));
  assert.ok(differsOnlyIn(base, withMusic, 10, 335, 410, 350));
});

test('moves appear in the side panel and nowhere else', () => {
  const base = composeFrame(view());
  const one = composeFrame(view({ moves: [{ action: 'up', user: 'pip' }] }));
  assert.ok(differsOnlyIn(base, one, 420, 122, 630, 135));
  const two = composeFrame(view({ moves: [{ action: 'left', user: 'mo' }, { action: 'up', user: 'pip' }] }));
  assert.ok(differsOnlyIn(one, two, 420, 122, 630, 148));
});

test('every action has an icon and long names are cut to fit', () => {
  const moves = ['up', 'down', 'left', 'right', 'action', 'undo', 'restart', 'continue'].map((action) => ({ action, user: 'x'.repeat(60) }));
  const img = composeFrame(view({ moves }));
  assert.ok(differsOnlyIn(composeFrame(view()), img, 420, 122, 630, 226));
});

test('the command list follows the game flags and the skip votes', () => {
  const base = composeFrame(view());
  const noUndo = composeFrame(view({ meta: Object.assign({}, META, { flags: Object.assign({}, META.flags, { noundo: true }) }) }));
  assert.ok(differsOnlyIn(base, noUndo, 420, 284, 630, 350));
  const voted = composeFrame(view({ votes: { count: 1, needed: 3 } }));
  assert.ok(differsOnlyIn(base, voted, 420, 284, 630, 350));
});

test('the player strip is drawn only when the game has a player sprite', () => {
  const withPlayer = composeFrame(view());
  const without = composeFrame(view({ tiles: Object.assign({}, TILES, { player: null }) }));
  assert.ok(differsOnlyIn(withPlayer, without, 455, 76, 595, 96));
});

test('message, finished and back-soon screens compose without a game', () => {
  const message = { kind: 'message', message: 'hello there', levelIndex: 0, levelCount: 3, background: '#000000', textColor: '#ffffff' };
  assert.ok(count(composeFrame(view({ snapshot: message })), [255, 255, 255], 10, 10, 410, 310) > 50);
  const finished = { kind: 'finished', message: null, levelIndex: 3, levelCount: 3, background: '#000000', textColor: '#ffffff' };
  assert.doesNotThrow(() => composeFrame(view({ snapshot: finished })));
  const backSoon = { kind: 'message', message: 'back soon', levelIndex: 0, levelCount: 0, background: '#000000', textColor: '#ffffff' };
  const img = composeFrame({ snapshot: backSoon, tiles: null, meta: null, moves: [], votes: { count: 0, needed: 1 }, music: null });
  assert.equal(count(img, [247, 226, 107], 10, 320, 410, 334), 0, 'no level counter without levels');
});

test('the same view always gives the same picture', () => {
  assert.ok(same(composeFrame(view()), composeFrame(view())));
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd twitch-bot && node --test test/frame.test.js 2>&1 | tail -8`
Expected: FAIL with `Cannot find module '../frame'`.

- [ ] **Step 3: Implement**

`twitch-bot/frame.js`:

```js
'use strict';
const { makeImage, fillRect, parseHex, renderLevelRGBA, renderTextRGBA, getGlyphs } = require('../discord-bot/renderer');

const WIDTH = 640, HEIGHT = 360, TILE = 10;
const GAME_X = 10, GAME_Y = 10, GAME_W = 400;
const PANEL_X = 420, PANEL_W = 210;
const LOG_ROWS = 12, NAME_CHARS = 30;

// The default PuzzleScript palette.
const C = { black: '#000000', white: '#ffffff', lightgrey: '#cccccc', grey: '#9d9d9d', darkgrey: '#697175', yellow: '#f7e26b', lightblue: '#b2dcef', pink: '#de65e2' };
const FADE = [C.white, C.lightgrey, C.lightgrey, C.grey, C.grey, C.grey, C.grey, C.darkgrey, C.darkgrey, C.darkgrey, C.darkgrey, C.darkgrey];

// The wall from the classic Sokoban example, for games that have none of their own.
const BRICK = { colors: ['#a46422', '#493c2b'], dat: [[0, 0, 0, 1, 0], [1, 1, 1, 1, 1], [0, 1, 0, 0, 0], [1, 1, 1, 1, 1], [0, 0, 0, 1, 0]] };

const icon = (rows) => rows.map((row) => row.split('').map((ch) => (ch === '0' ? 0 : -1)));
const ICONS = {
  up: icon(['..0..', '.000.', '0.0.0', '..0..', '..0..']),
  down: icon(['..0..', '..0..', '0.0.0', '.000.', '..0..']),
  left: icon(['..0..', '.0...', '00000', '.0...', '..0..']),
  right: icon(['..0..', '...0.', '00000', '...0.', '..0..']),
  action: icon(['0...0', '.0.0.', '..0..', '.0.0.', '0...0']),
  undo: icon(['.0...', '0000.', '.0..0', '....0', '.000.']),
  restart: icon(['0000.', '0..0.', '0000.', '0.0..', '0..0.']),
};
ICONS.continue = ICONS.action;

function drawSprite(img, x, y, sprite, scale) {
  for (let r = 0; r < 5; r++) {
    const row = sprite.dat[r];
    if (!row) continue;
    for (let c = 0; c < 5; c++) {
      const v = row[c];
      if (v === undefined || v < 0) continue;
      const colour = sprite.colors[v];
      if (colour === undefined || String(colour).toLowerCase() === 'transparent') continue;
      fillRect(img, x + c * scale, y + r * scale, scale, scale, parseHex(colour));
    }
  }
}

function drawText(img, x, y, str, colour, scale = 1) {
  const ink = parseHex(colour), font = getGlyphs();
  Array.from(String(str)).forEach((ch, i) => {
    const g = font[ch];
    if (!g) return; // characters the engine font lacks are left blank
    for (let gy = 0; gy < g.length; gy++) for (let gx = 0; gx < 5; gx++) {
      if (g[gy][gx]) fillRect(img, x + (i * 6 + gx) * scale, y + gy * scale, scale, scale, ink);
    }
  });
}

const chars = (str) => Array.from(String(str)).length;

function fit(str, max) {
  const a = Array.from(String(str));
  if (a.length <= max) return a.join('');
  return max <= 0 ? '' : a.slice(0, max - 1).join('') + '…';
}

function blit(img, src, dx, dy) {
  for (let y = 0; y < src.height; y++) {
    const from = y * src.width * 4;
    img.rgba.set(src.rgba.subarray(from, from + src.width * 4), ((dy + y) * img.width + dx) * 4);
  }
}

// One picture of the stream, 640x360; ffmpeg doubles it. The screen is laid out like a
// PuzzleScript level: walls divide it into the game, a title strip and a side panel.
function composeFrame({ snapshot, tiles, meta, moves = [], votes = { count: 0, needed: 1 }, music = null }) {
  const img = makeImage(WIDTH, HEIGHT, C.black);
  const t = tiles || {};

  const wall = (tx, ty) => {
    if (!t.wall) { drawSprite(img, tx * TILE, ty * TILE, BRICK, 2); return; }
    if (t.background) drawSprite(img, tx * TILE, ty * TILE, t.background, 2);
    drawSprite(img, tx * TILE, ty * TILE, t.wall, 2);
  };
  for (let tx = 0; tx < 64; tx++) { wall(tx, 0); wall(tx, 35); if (tx <= 41) wall(tx, 31); }
  for (let ty = 1; ty < 35; ty++) { wall(0, ty); wall(63, ty); if (ty !== 31) wall(41, ty); }

  blit(img, snapshot.kind === 'level' ? renderLevelRGBA(snapshot) : renderTextRGBA(snapshot), GAME_X, GAME_Y);

  // title strip
  const levelText = snapshot.kind !== 'finished' && snapshot.levelCount > 0
    ? 'level ' + (Math.min(snapshot.levelIndex, snapshot.levelCount - 1) + 1) + ' of ' + snapshot.levelCount : '';
  if (levelText) drawText(img, GAME_X + GAME_W - 6 - chars(levelText) * 6, 322, levelText, C.yellow);
  if (meta) {
    const room = Math.floor((GAME_W - 12 - (levelText ? chars(levelText) * 6 + 12 : 0)) / 6);
    const title = fit(meta.title || 'untitled', room);
    drawText(img, GAME_X + 6, 322, title, C.white);
    const rest = room - chars(title);
    if (meta.author && rest >= 8) drawText(img, GAME_X + 6 + chars(title) * 6, 322, fit(' by ' + meta.author, rest), C.grey);
  }
  if (music) drawText(img, GAME_X + 6, 335, fit('music: ' + music.title + ' - ' + music.album, 64), C.darkgrey);

  // side panel
  const centred = (str, scale) => PANEL_X + Math.floor((PANEL_W - chars(str) * 6 * scale) / 2);
  drawText(img, centred('TWITCH PLAYS', 2), 16, 'TWITCH PLAYS', C.pink, 2);
  drawText(img, centred('PUZZLESCRIPT', 2), 42, 'PUZZLESCRIPT', C.white, 2);
  if (t.player) {
    const sx = PANEL_X + (PANEL_W - 7 * 20) / 2;
    if (t.background) for (let i = 0; i < 7; i++) drawSprite(img, sx + i * 20, 76, t.background, 4);
    drawSprite(img, sx + 20, 76, t.player, 4);
  }
  drawText(img, PANEL_X + 8, 106, 'last moves', C.lightblue);
  moves.slice(0, LOG_ROWS).forEach((m, i) => {
    const y = 122 + i * 13;
    drawSprite(img, PANEL_X + 8, y + 2, { colors: [FADE[i]], dat: ICONS[m.action] || ICONS.action }, 2);
    drawText(img, PANEL_X + 24, y, fit(m.user, NAME_CHARS), FADE[i]);
  });

  const flags = (meta && meta.flags) || {};
  const words = ['action', 'undo', 'restart'].filter((w) => !flags['no' + w]);
  const help = ['up down left right'];
  if (words.length) help.push(words.join(' '));
  help.push('or just: u d l r' + (flags.noaction ? '' : ' a') + (flags.noundo ? '' : ' z'));
  help.push(votes.count > 0 ? '!skip next game (' + votes.count + '/' + votes.needed + ')' : '!skip votes next game');
  drawText(img, PANEL_X + 8, 284, 'type in chat:', C.lightblue);
  const top = 349 - help.length * 13;
  help.forEach((line, i) => drawText(img, PANEL_X + 8, top + i * 13, line, i === help.length - 1 ? C.grey : C.lightgrey));

  return img;
}

module.exports = { composeFrame, WIDTH, HEIGHT };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd twitch-bot && npm test 2>&1 | tail -9`
Expected: `pass 59`, `fail 0`.

- [ ] **Step 5: Look at one frame**

Run:

```bash
cd twitch-bot && node -e "
const fs=require('fs');const {createHost}=require('../discord-bot/engine-host');const {encodePNG}=require('../discord-bot/png');const {composeFrame}=require('./frame');
const h=createHost();const meta=h.load(fs.readFileSync('../src/demo/heroes_of_sokoban.txt','utf8'),'s',1);
const img=composeFrame({snapshot:h.snapshot(),tiles:h.frameTiles(),meta,moves:[{action:'up',user:'crate_pusher'},{action:'undo',user:'mossy_toad'},{action:'restart',user:'pip'}],votes:{count:1,needed:2},music:{title:'Reaction',album:'English Country Tune'}});
fs.writeFileSync('/tmp/twitch-frame.png',encodePNG(img.width,img.height,img.rgba));console.log('wrote /tmp/twitch-frame.png');"
```

Open `/tmp/twitch-frame.png` (use the Read tool) and check: grey brick border around three rooms; the level in the left room; title, "level 2 of 31" and the music line under it; heading, player strip, three log rows with icons, and four command lines in the right room, none overlapping the walls. Fix any overlap before committing.

- [ ] **Step 6: Commit**

```bash
git add twitch-bot/frame.js twitch-bot/test/frame.test.js
git commit -m "twitch-bot: compose the stream frame from the game's own tiles

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Music — index and shuffled playback

**Files:**
- Create: `twitch-bot/index-music.js`, `twitch-bot/music.js`
- Test: `twitch-bot/test/index-music.test.js`, `twitch-bot/test/music.test.js`

**Interfaces:**
- Consumes: `loadPaths()` (Task 2).
- Produces:
  - `buildIndex({ root, albums?, probe?, log? })` → `{ root, tracks: [{ path, album, title, seconds }] }`; `path` is relative to `root`. `ALBUMS` is the default folder list. Running `node index-music.js` writes `<dataDir>/music-index.json`.
  - `loadIndex(dataDir)` → the index object or `null`.
  - `createMusic({ index, spawnDecoder?, random?, onTrack?, log?, setTimer?, clearTimer? })` → `{ start(), stop(), read(nBytes), current() }`. `read(n)` returns a `Buffer` of at most `n` bytes, always a multiple of 4, possibly empty. `current()` → `{ title, album }` or `null`. `onTrack({ title, album })` fires when a track starts. `spawnDecoder(file)` must return a child-process-like object: `stdout` (events `data`, methods `pause`/`resume`), events `close`/`error`, method `kill()`.

- [ ] **Step 1: Write the failing tests**

`twitch-bot/test/index-music.test.js`:

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildIndex, ALBUMS } = require('../index-music');

function library() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'twitch-music-'));
  const put = (rel) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), 'x'); };
  put('increpare - Alpha/2 - Second.mp3');
  put('increpare - Alpha/1 - First.mp3');
  put('increpare - Alpha/cover.jpg');
  put('increpare - Alpha/disc two/2-01 Deep_Cut.mp3');
  put('increpare - Beta/broken.mp3');
  put('increpare - Beta/tagged.ogg');
  put('increpare - Other/ignored.mp3');
  return root;
}

test('the default albums are the six the user chose', () => {
  assert.deepEqual(ALBUMS, ['increpare - English Country Tune', 'increpare - Hypnocult', 'increpare - Mirror Stage', 'increpare - Moving Stories', 'increpare - Oiche Mhaith', 'increpare - Oeuvre (Oeuf OST)']);
});

test('indexes audio files in the chosen folders, in a stable order', () => {
  const root = library();
  const probe = (file) => {
    if (file.endsWith('broken.mp3')) throw new Error('bad file');
    return { seconds: 61.4, title: file.endsWith('tagged.ogg') ? 'A Proper Title' : undefined };
  };
  const logged = [];
  const index = buildIndex({ root, albums: ['increpare - Alpha', 'increpare - Beta', 'increpare - Missing'], probe, log: (m) => logged.push(m) });
  assert.equal(index.root, root);
  assert.deepEqual(index.tracks, [
    { path: path.join('increpare - Alpha', '1 - First.mp3'), album: 'Alpha', title: 'First', seconds: 61 },
    { path: path.join('increpare - Alpha', '2 - Second.mp3'), album: 'Alpha', title: 'Second', seconds: 61 },
    { path: path.join('increpare - Alpha', 'disc two', '2-01 Deep_Cut.mp3'), album: 'Alpha', title: 'Deep_Cut', seconds: 61 },
    { path: path.join('increpare - Beta', 'tagged.ogg'), album: 'Beta', title: 'A Proper Title', seconds: 61 },
  ]);
  assert.equal(logged.length, 2, 'the broken file and the missing folder are reported');
});

test('the music files are not modified', () => {
  const root = library();
  const before = fs.statSync(path.join(root, 'increpare - Alpha', '1 - First.mp3')).mtimeMs;
  buildIndex({ root, albums: ['increpare - Alpha'], probe: () => ({ seconds: 10 }) });
  assert.equal(fs.statSync(path.join(root, 'increpare - Alpha', '1 - First.mp3')).mtimeMs, before);
  assert.deepEqual(fs.readdirSync(path.join(root, 'increpare - Alpha')).sort(), ['1 - First.mp3', '2 - Second.mp3', 'cover.jpg', 'disc two']);
});
```

`twitch-bot/test/music.test.js`:

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createMusic, loadIndex } = require('../music');

const SECOND = 176400;
const INDEX = (n) => ({ root: '/music', tracks: Array.from({ length: n }, (_, i) => ({ path: 'album/t' + i + '.mp3', album: 'Album', title: 'Track ' + i, seconds: 60 })) });

function harness(index, random = Math.random) {
  const made = [], timers = [], started = [];
  const spawnDecoder = (file) => {
    const p = new EventEmitter();
    p.file = file;
    p.stdout = new EventEmitter();
    p.stdout.paused = false;
    p.stdout.pause = () => { p.stdout.paused = true; };
    p.stdout.resume = () => { p.stdout.paused = false; };
    p.kill = () => { p.killed = true; p.emit('close'); };
    made.push(p);
    return p;
  };
  const music = createMusic({
    index, spawnDecoder, random, onTrack: (t) => started.push(t), log: () => {},
    setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimer: () => {},
  });
  // play one decoder to the end, producing some audio
  const finish = (p, bytes = 8) => { p.stdout.emit('data', Buffer.alloc(bytes, 1)); p.emit('close'); };
  return { music, made, timers, started, finish };
}

test('loadIndex reads the index or returns null', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'twitch-music-'));
  assert.equal(loadIndex(dir), null);
  fs.writeFileSync(path.join(dir, 'music-index.json'), JSON.stringify(INDEX(2)));
  assert.equal(loadIndex(dir).tracks.length, 2);
  fs.writeFileSync(path.join(dir, 'music-index.json'), '{"tracks": 5}');
  assert.equal(loadIndex(dir), null);
});

test('with no index it stays silent', () => {
  const h = harness(null);
  h.music.start();
  assert.equal(h.made.length, 0);
  assert.equal(h.music.read(400).length, 0);
  assert.equal(h.music.current(), null);
});

test('start decodes a track and announces it', () => {
  const h = harness(INDEX(3));
  assert.equal(h.music.current(), null);
  h.music.start();
  assert.equal(h.made.length, 1);
  assert.match(h.made[0].file, /^\/music\/album\/t\d\.mp3$/);
  assert.deepEqual(h.started.length, 1);
  assert.deepEqual(h.music.current(), h.started[0]);
  assert.equal(h.started[0].album, 'Album');
});

test('every track plays once before any repeats', () => {
  const h = harness(INDEX(4));
  h.music.start();
  for (let i = 0; i < 3; i++) h.finish(h.made[i]);
  assert.deepEqual(h.made.map((p) => p.file).sort(), ['/music/album/t0.mp3', '/music/album/t1.mp3', '/music/album/t2.mp3', '/music/album/t3.mp3']);
});

test('a reshuffle never plays the same track twice in a row', () => {
  // with two tracks: 0.99 keeps the order [0, 1]; 0 would then give [1, 0], repeating track 1
  const seq = [0.99, 0, 0, 0];
  let i = 0;
  const h = harness(INDEX(2), () => seq[i++ % seq.length]);
  h.music.start();
  for (let k = 0; k < 5; k++) h.finish(h.made[k]);
  const files = h.made.map((p) => p.file);
  for (let k = 1; k < files.length; k++) assert.notEqual(files[k], files[k - 1]);
});

test('read returns whole sample frames in order, across chunks and tracks', () => {
  const h = harness(INDEX(2));
  h.music.start();
  h.made[0].stdout.emit('data', Buffer.from([1, 2, 3, 4, 5, 6]));
  h.made[0].stdout.emit('data', Buffer.from([7, 8, 9, 10, 11, 12]));
  assert.deepEqual([...h.music.read(8)], [1, 2, 3, 4, 5, 6, 7, 8]);
  h.made[0].emit('close');
  h.made[1].stdout.emit('data', Buffer.from([13, 14]));
  assert.deepEqual([...h.music.read(1000)], [9, 10, 11, 12]);
  assert.equal(h.music.read(1000).length, 0, 'two bytes are not a whole frame yet');
  h.made[1].stdout.emit('data', Buffer.from([15, 16]));
  assert.deepEqual([...h.music.read(1000)], [13, 14, 15, 16]);
  assert.equal(h.music.read(0).length, 0);
});

test('the decoder is paused at 2 seconds buffered and resumed under 1', () => {
  const h = harness(INDEX(2));
  h.music.start();
  const out = h.made[0].stdout;
  out.emit('data', Buffer.alloc(2 * SECOND - 4));
  assert.equal(out.paused, false);
  out.emit('data', Buffer.alloc(4));
  assert.equal(out.paused, true);
  h.music.read(SECOND);
  assert.equal(out.paused, true);
  h.music.read(4);
  assert.equal(out.paused, false);
});

test('a track that yields nothing is skipped, and 5 in a row wait 30 seconds', () => {
  const h = harness(INDEX(3));
  h.music.start();
  for (let i = 0; i < 4; i++) h.made[i].emit('close');
  assert.equal(h.made.length, 5);
  assert.equal(h.timers.length, 0);
  h.made[4].emit('close');
  assert.equal(h.made.length, 5);
  assert.equal(h.timers[0].ms, 30000);
  h.timers[0].fn();
  assert.equal(h.made.length, 6);
});

test('a decoder that cannot start counts as a failed track', () => {
  const h = harness(INDEX(3));
  h.music.start();
  h.made[0].emit('error', new Error('spawn ffmpeg ENOENT'));
  h.made[0].emit('close');
  assert.equal(h.made.length, 2);
});

test('stop kills the decoder and nothing else starts', () => {
  const h = harness(INDEX(3));
  h.music.start();
  h.music.stop();
  assert.equal(h.made[0].killed, true);
  assert.equal(h.made.length, 1);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd twitch-bot && node --test test/index-music.test.js test/music.test.js 2>&1 | tail -8`
Expected: FAIL with `Cannot find module '../index-music'` and `Cannot find module '../music'`.

- [ ] **Step 3: Implement**

`twitch-bot/index-music.js`:

```js
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { loadPaths } = require('./config');

const ALBUMS = [
  'increpare - English Country Tune',
  'increpare - Hypnocult',
  'increpare - Mirror Stage',
  'increpare - Moving Stories',
  'increpare - Oiche Mhaith',
  'increpare - Oeuvre (Oeuf OST)',
];
const AUDIO = /\.(mp3|ogg|flac|wav|m4a)$/i;

function probeFile(file) {
  const out = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:format_tags=title', '-of', 'json', file], { encoding: 'utf8' });
  const format = JSON.parse(out).format || {};
  const tags = format.tags || {};
  return { seconds: Number(format.duration), title: tags.title || tags.TITLE };
}

function audioFiles(dir) {
  const found = [];
  for (const name of fs.readdirSync(dir).sort()) {
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) found.push(...audioFiles(full));
    else if (AUDIO.test(name)) found.push(full);
  }
  return found;
}

// A list of the tracks to play. The music itself is only read, never copied or changed.
function buildIndex({ root, albums = ALBUMS, probe = probeFile, log = () => {} }) {
  const tracks = [];
  for (const folder of albums) {
    let files;
    try { files = audioFiles(path.join(root, folder)); } catch (e) { log('missing album folder: ' + folder); continue; }
    for (const file of files) {
      let info = null;
      try { info = probe(file); } catch (e) { /* reported below */ }
      if (!info || !(info.seconds > 0)) { log('unreadable track: ' + file); continue; }
      tracks.push({
        path: path.relative(root, file),
        album: folder.replace(/^increpare - /, ''),
        title: info.title || path.basename(file).replace(AUDIO, '').replace(/^[\d\s.-]+/, ''),
        seconds: Math.round(info.seconds),
      });
    }
  }
  return { root, tracks };
}

if (require.main === module) {
  const { musicDir, dataDir } = loadPaths();
  const index = buildIndex({ root: musicDir, log: console.log });
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, 'music-index.json');
  fs.writeFileSync(file, JSON.stringify(index));
  const hours = index.tracks.reduce((sum, t) => sum + t.seconds, 0) / 3600;
  console.log('indexed ' + index.tracks.length + ' tracks, ' + hours.toFixed(1) + ' hours -> ' + file);
}

module.exports = { buildIndex, ALBUMS };
```

`twitch-bot/music.js`:

```js
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { shuffled } = require('./rotation');

const BYTES_PER_SECOND = 44100 * 4; // 44.1 kHz, stereo, 16-bit
const HIGH = 2 * BYTES_PER_SECOND, LOW = BYTES_PER_SECOND;
const MAX_FAILURES = 5, RETRY_MS = 30000;

function loadIndex(dataDir) {
  try {
    const index = JSON.parse(fs.readFileSync(path.join(dataDir, 'music-index.json'), 'utf8'));
    return index && Array.isArray(index.tracks) && typeof index.root === 'string' ? index : null;
  } catch (e) { return null; }
}

function defaultDecoder(file) {
  return spawn('ffmpeg', ['-v', 'error', '-nostdin', '-i', file, '-vn', '-f', 's16le', '-ar', '44100', '-ac', '2', 'pipe:1'], { stdio: ['ignore', 'pipe', 'ignore'] });
}

// Shuffled playback as a source of PCM. One track is decoded at a time, a couple of seconds
// ahead of what has been read; the next decoder starts when the previous one has been drained.
function createMusic({ index, spawnDecoder = defaultDecoder, random = Math.random, onTrack = () => {}, log = console.log, setTimer = setTimeout, clearTimer = clearTimeout }) {
  const tracks = index && Array.isArray(index.tracks) ? index.tracks : [];
  let order = [], pos = 0, last = -1;
  let chunks = [], buffered = 0;
  let proc = null, paused = false, current = null, failures = 0, timer = null, stopped = true;

  function nextTrack() {
    if (pos >= order.length) {
      order = shuffled(tracks.map((_, i) => i), random);
      if (order.length > 1 && order[0] === last) { order[0] = order[1]; order[1] = last; }
      pos = 0;
    }
    last = order[pos++];
    return tracks[last];
  }

  function play() {
    timer = null;
    if (stopped || tracks.length === 0) return;
    const track = nextTrack();
    const p = spawnDecoder(path.join(index.root, track.path));
    let produced = 0, done = false;
    proc = p;
    paused = false;
    current = { title: track.title, album: track.album };
    p.stdout.on('data', (chunk) => {
      produced += chunk.length;
      chunks.push(chunk);
      buffered += chunk.length;
      if (buffered >= HIGH && !paused) { paused = true; p.stdout.pause(); }
    });
    const finish = () => {
      if (done) return;
      done = true;
      if (proc !== p) return;
      proc = null;
      if (stopped) return;
      if (produced > 0) failures = 0;
      else { failures++; log('could not decode ' + track.path); }
      if (failures >= MAX_FAILURES) { failures = 0; timer = setTimer(play, RETRY_MS); }
      else play();
    };
    p.on('error', (e) => { log('decoder error: ' + (e && e.message)); finish(); });
    p.on('close', finish);
    onTrack(current);
  }

  return {
    start() {
      if (!stopped) return;
      stopped = false;
      play();
    },
    stop() {
      stopped = true;
      if (timer !== null) { clearTimer(timer); timer = null; }
      if (proc) proc.kill();
    },
    // Up to n bytes of audio, always whole sample frames; fewer (or none) when the music has no more yet.
    read(n) {
      const size = Math.min(n - (n % 4), buffered - (buffered % 4));
      if (size <= 0) return Buffer.alloc(0);
      const out = Buffer.allocUnsafe(size);
      let filled = 0;
      while (filled < size) {
        const head = chunks[0];
        const take = Math.min(head.length, size - filled);
        head.copy(out, filled, 0, take);
        filled += take;
        if (take === head.length) chunks.shift(); else chunks[0] = head.subarray(take);
      }
      buffered -= size;
      if (paused && buffered < LOW && proc) { paused = false; proc.stdout.resume(); }
      return out;
    },
    current: () => current,
  };
}

module.exports = { createMusic, loadIndex };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd twitch-bot && npm test 2>&1 | tail -9`
Expected: `pass 72`, `fail 0`.

- [ ] **Step 5: Commit**

```bash
git add twitch-bot/index-music.js twitch-bot/music.js twitch-bot/test/index-music.test.js twitch-bot/test/music.test.js
git commit -m "twitch-bot: music index and shuffled playback as a PCM source

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: The encoder

**Files:**
- Create: `twitch-bot/encoder.js`
- Test: `twitch-bot/test/encoder.test.js`

**Interfaces:**
- Consumes: a `readAudio(nBytes)` function with the contract of `music.read` (Task 7): returns a `Buffer` of at most `nBytes`, a multiple of 4.
- Produces:
  - `ffmpegArgs(output)` → `string[]`.
  - `createEncoder({ output, minFps?, readAudio?, spawnFfmpeg?, now?, log?, setTimer?, clearTimer?, autoTick? })` → `{ start(), stop(), setFrame(rgba), _tick() }`. `setFrame` takes a 640×360 RGBA `Uint8Array` or `Buffer` (921600 bytes) that the caller will not mutate afterwards. `stop()` returns a `Promise` resolved once ffmpeg has exited. With `autoTick: false` nothing is scheduled and the caller drives `_tick()`. `spawnFfmpeg(output)` must return a child-process-like object: `stdin` and `stdio[3]` writable (`write` → boolean, `end`, `once('drain')`, `on('error')`), `stderr` (event `data`), events `exit`/`error`, method `kill(signal)`.

The ffmpeg command line below was run on the Pi on 2026-10-07 with frames written only on change plus a 1-second heartbeat: video timestamps tracked the write times within 33 ms, keyframes fell every 1.97–2.00 s, audio had no gaps, and ffmpeg used 6.4% of one core. Do not change the flags without re-measuring.

Keyframes are forced at the first frame at or after `2n − 0.1` seconds, and the heartbeat puts a frame within about 60 ms of every whole second, so two keyframes are never more than about 2.2 s apart.

- [ ] **Step 1: Write the failing tests**

`twitch-bot/test/encoder.test.js`:

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const { createEncoder, ffmpegArgs } = require('../encoder');

function pipe() {
  const s = new EventEmitter();
  s.chunks = [];
  s.accept = true;
  s.write = (b) => { s.chunks.push(b); return s.accept; };
  s.end = () => { s.ended = true; };
  s.bytes = () => s.chunks.reduce((n, b) => n + b.length, 0);
  return s;
}

function harness(opts = {}) {
  const clock = { t: 5000 }, procs = [], timers = [], logs = [];
  const spawnFfmpeg = (output) => {
    const p = new EventEmitter();
    p.output = output;
    p.stdin = pipe();
    p.stdio = [p.stdin, null, new EventEmitter(), pipe()];
    p.stderr = p.stdio[2];
    p.kill = (signal) => { p.killed = signal; };
    procs.push(p);
    return p;
  };
  const enc = createEncoder(Object.assign({
    output: 'rtmp://live.twitch.tv/app/SECRETKEY', spawnFfmpeg, now: () => clock.t, log: (m) => logs.push(String(m)), autoTick: false,
    setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimer: () => {},
  }, opts));
  const at = (ms) => { clock.t = 5000 + ms; enc._tick(); };
  return { enc, clock, procs, timers, logs, at };
}

const FRAME_A = Buffer.alloc(16, 1), FRAME_B = Buffer.alloc(16, 2), FRAME_C = Buffer.alloc(16, 3);

test('the ffmpeg command reads both pipes and writes FLV to the output', () => {
  const a = ffmpegArgs('rtmp://example/app/key');
  const has = (...seq) => a.some((_, i) => seq.every((v, k) => a[i + k] === v));
  assert.ok(has('-f', 'rawvideo', '-pix_fmt', 'rgba', '-video_size', '640x360'));
  assert.ok(has('-use_wallclock_as_timestamps', '1', '-i', 'pipe:0'));
  assert.ok(has('-f', 's16le', '-ar', '44100', '-ac', '2', '-i', 'pipe:3'));
  assert.ok(has('-vf', 'scale=1280:720:flags=neighbor'));
  assert.ok(has('-fps_mode', 'vfr'));
  assert.ok(has('-threads', '1'));
  assert.ok(has('-force_key_frames', 'expr:gte(t,n_forced*2-0.1)'));
  assert.ok(has('-c:a', 'aac'));
  assert.ok(has('-f', 'flv'));
  assert.equal(a[a.length - 1], 'rtmp://example/app/key');
});

test('audio is written in step with the clock, padded with silence', () => {
  const tone = Buffer.alloc(1000, 7);
  let asked = [];
  const h = harness({ readAudio: (n) => { asked.push(n); return asked.length === 1 ? tone : Buffer.alloc(0); } });
  h.enc.start();
  h.at(0);
  const audio = h.procs[0].stdio[3];
  assert.equal(asked[0], 6615 * 4, '150 ms of lead at 44.1 kHz');
  assert.equal(audio.bytes(), 6615 * 4);
  assert.equal(audio.chunks[0][0], 7);
  assert.equal(audio.chunks[0][999], 7);
  assert.equal(audio.chunks[0][1000], 0, 'silence where the music ran short');
  h.at(1000);
  assert.equal(audio.bytes(), 50715 * 4);
  h.at(1000);
  assert.equal(audio.bytes(), 50715 * 4, 'nothing more is owed at the same instant');
});

test('nothing is written before the first frame is set', () => {
  const h = harness();
  h.enc.start();
  h.at(0);
  h.at(1000);
  assert.equal(h.procs[0].stdin.chunks.length, 0);
});

test('a frame goes out when set, then again on each heartbeat', () => {
  const h = harness();
  h.enc.setFrame(FRAME_A);
  h.enc.start();
  h.at(0);
  const video = h.procs[0].stdin;
  assert.equal(video.chunks.length, 1);
  h.at(20); h.at(500); h.at(980);
  assert.equal(video.chunks.length, 1);
  h.at(1000);
  assert.equal(video.chunks.length, 2);
  h.at(1020);
  assert.equal(video.chunks.length, 2);
  h.at(2000);
  assert.equal(video.chunks.length, 3);
  assert.deepEqual([...video.chunks[2]], [...FRAME_A]);
});

test('a change is written at once, but never two within 50 ms', () => {
  const h = harness();
  h.enc.setFrame(FRAME_A);
  h.enc.start();
  h.at(0);
  const video = h.procs[0].stdin;
  h.enc.setFrame(FRAME_B);
  h.at(20);
  assert.equal(video.chunks.length, 1, 'too soon after the last frame');
  h.enc.setFrame(FRAME_C);
  h.at(40);
  assert.equal(video.chunks.length, 1);
  h.at(60);
  assert.equal(video.chunks.length, 2);
  assert.deepEqual([...video.chunks[1]], [...FRAME_C], 'only the latest picture is sent');
  h.at(300);
  assert.equal(video.chunks.length, 2);
  h.enc.setFrame(FRAME_A);
  h.at(320);
  assert.equal(video.chunks.length, 3);
});

test('minFps sets the heartbeat', () => {
  const h = harness({ minFps: 5 });
  h.enc.setFrame(FRAME_A);
  h.enc.start();
  for (let ms = 0; ms <= 1000; ms += 20) h.at(ms);
  assert.equal(h.procs[0].stdin.chunks.length, 6);
});

test('a missed heartbeat is not made up later', () => {
  const h = harness();
  h.enc.setFrame(FRAME_A);
  h.enc.start();
  h.at(0);
  h.at(5300);
  h.at(5320);
  assert.equal(h.procs[0].stdin.chunks.length, 2);
  h.at(6000);
  assert.equal(h.procs[0].stdin.chunks.length, 3);
});

test('while the video pipe is backed up, frames are dropped, then the current one is sent', () => {
  const h = harness();
  h.enc.setFrame(FRAME_A);
  h.enc.start();
  const video = h.procs[0].stdin;
  video.accept = false;
  h.at(0);
  assert.equal(video.chunks.length, 1);
  h.enc.setFrame(FRAME_B);
  h.at(1000); h.at(2000);
  assert.equal(video.chunks.length, 1);
  video.accept = true;
  video.emit('drain');
  h.at(2020);
  assert.equal(video.chunks.length, 2);
  assert.deepEqual([...video.chunks[1]], [...FRAME_B]);
});

test('audio waits for a backed-up pipe and then catches up exactly', () => {
  const h = harness();
  h.enc.start();
  const audio = h.procs[0].stdio[3];
  audio.accept = false;
  h.at(0);
  h.at(2000);
  assert.equal(audio.bytes(), 6615 * 4);
  audio.accept = true;
  audio.emit('drain');
  h.at(3000);
  assert.equal(audio.bytes(), Math.floor(3150 * 44100 / 1000) * 4);
});

test('an audio pipe stuck for 10 seconds gets ffmpeg killed', () => {
  const h = harness();
  h.enc.start();
  h.procs[0].stdio[3].accept = false;
  h.at(0);
  h.at(9999);
  assert.equal(h.procs[0].killed, undefined);
  h.at(10000);
  assert.equal(h.procs[0].killed, 'SIGKILL');
});

test('ffmpeg is restarted with a doubling delay, and the clocks start again', () => {
  const h = harness();
  h.enc.setFrame(FRAME_A);
  h.enc.start();
  h.at(0);
  h.at(3000);
  h.procs[0].emit('exit', 1, null);
  assert.equal(h.timers[0].ms, 2000);
  h.at(4000);
  assert.equal(h.procs.length, 1);
  h.clock.t = 5000 + 5000;
  h.timers[0].fn();
  assert.equal(h.procs.length, 2);
  h.enc._tick();
  assert.equal(h.procs[1].stdio[3].bytes(), 6615 * 4, 'the audio clock restarted');
  assert.equal(h.procs[1].stdin.chunks.length, 1, 'the current picture is sent again');
  h.procs[1].emit('exit', 1, null);
  assert.equal(h.timers[1].ms, 4000);
});

test('the restart delay is capped at a minute and resets after a healthy minute', () => {
  const h = harness();
  h.enc.start();
  for (let i = 0; i < 7; i++) { h.procs[i].emit('exit', 1, null); h.timers[i].fn(); }
  assert.deepEqual(h.timers.map((t) => t.ms), [2000, 4000, 8000, 16000, 32000, 60000, 60000]);
  h.clock.t += 60000;
  h.procs[7].emit('exit', 1, null);
  assert.equal(h.timers[7].ms, 2000);
});

test('a spawn error also leads to a restart, once', () => {
  const h = harness();
  h.enc.start();
  h.procs[0].emit('error', new Error('spawn ffmpeg ENOENT'));
  h.procs[0].emit('exit', null, null);
  assert.equal(h.timers.length, 1);
});

test('the stream key never reaches the log', () => {
  const h = harness();
  h.enc.start();
  h.procs[0].stderr.emit('data', Buffer.from('Failed to open rtmp://live.twitch.tv/app/SECRETKEY: refused\n'));
  h.procs[0].emit('exit', 1, null);
  assert.ok(h.logs.length >= 2);
  for (const line of h.logs) assert.ok(!line.includes('SECRETKEY'), line);
  assert.ok(h.logs.some((l) => l.includes('<output>')));
});

test('stop ends both pipes, waits for ffmpeg, and does not restart it', async () => {
  const h = harness();
  h.enc.start();
  const p = h.procs[0];
  const stopped = h.enc.stop();
  assert.equal(p.stdin.ended, true);
  assert.equal(p.stdio[3].ended, true);
  p.emit('exit', 0, null);
  await stopped;
  assert.equal(h.timers.length, 0);
  h.enc._tick();
  assert.equal(h.procs.length, 1);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd twitch-bot && node --test test/encoder.test.js 2>&1 | tail -8`
Expected: FAIL with `Cannot find module '../encoder'`.

- [ ] **Step 3: Implement**

`twitch-bot/encoder.js`:

```js
'use strict';
const { spawn } = require('node:child_process');

const RATE = 44100, TICK_MS = 20, LEAD_MS = 150, MIN_GAP_MS = 50, STALL_MS = 10000;
const FIRST_BACKOFF = 2000, MAX_BACKOFF = 60000, HEALTHY_MS = 60000, KILL_AFTER_MS = 3000;

// Measured on the Pi: an unchanged frame costs as much to encode as a changed one, so the saving
// is in sending few frames; one x264 thread is cheaper than the default at these frame rates.
function ffmpegArgs(output) {
  return [
    '-hide_banner', '-nostdin', '-loglevel', 'warning',
    '-thread_queue_size', '64', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-video_size', '640x360', '-framerate', '30',
    '-use_wallclock_as_timestamps', '1', '-i', 'pipe:0',
    '-thread_queue_size', '512', '-f', 's16le', '-ar', '44100', '-ac', '2', '-i', 'pipe:3',
    '-vf', 'scale=1280:720:flags=neighbor', '-fps_mode', 'vfr',
    '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency', '-threads', '1', '-pix_fmt', 'yuv420p',
    '-crf', '23', '-maxrate', '2500k', '-bufsize', '5000k', '-g', '600', '-force_key_frames', 'expr:gte(t,n_forced*2-0.1)',
    '-c:a', 'aac', '-b:a', '160k',
    '-flush_packets', '1', '-f', 'flv', '-y', output,
  ];
}

function defaultSpawn(output) {
  return spawn('ffmpeg', ffmpegArgs(output), { stdio: ['pipe', 'ignore', 'pipe', 'pipe'] });
}

const monotonicMs = () => Number(process.hrtime.bigint() / 1000000n);

// Owns the ffmpeg process and is the stream's only clock. Video frames are stamped by ffmpeg as
// they arrive, so one is written only when the picture changes, plus a heartbeat. Audio is written
// by sample count: exactly as many samples as real time has advanced, so the two never drift apart.
function createEncoder({ output, minFps = 1, readAudio = () => Buffer.alloc(0), spawnFfmpeg = defaultSpawn, now = monotonicMs, log = console.log, setTimer = setTimeout, clearTimer = clearTimeout, autoTick = true }) {
  const beatMs = 1000 / minFps;
  const redact = (text) => String(text).split(output).join('<output>');
  let frame = null, dirty = false;
  let proc = null, t0 = 0, sentSamples = 0, lastWrite = -Infinity, nextBeat = 0;
  let videoBlocked = false, audioBlocked = false, blockedSince = 0;
  let backoff = FIRST_BACKOFF, restartTimer = null, interval = null, stopped = true;

  function launch() {
    restartTimer = null;
    if (stopped) return;
    const p = spawnFfmpeg(output);
    proc = p;
    t0 = now(); sentSamples = 0; lastWrite = -Infinity; nextBeat = 0;
    videoBlocked = false; audioBlocked = false;
    dirty = true;
    p.stdin.on('error', () => {});    // a dying ffmpeg closes its pipes; the exit handler deals with it
    p.stdio[3].on('error', () => {});
    if (p.stderr) p.stderr.on('data', (d) => log('ffmpeg: ' + redact(d).trim()));
    let done = false;
    const finish = (why) => {
      if (done) return;
      done = true;
      if (proc !== p) return;
      const ran = now() - t0;
      proc = null;
      if (stopped) return;
      if (ran >= HEALTHY_MS) backoff = FIRST_BACKOFF;
      log('ffmpeg stopped (' + redact(why) + '), restarting in ' + backoff + ' ms');
      restartTimer = setTimer(launch, backoff);
      backoff = Math.min(backoff * 2, MAX_BACKOFF);
    };
    p.on('error', (e) => finish(e && e.message));
    p.on('exit', (code, signal) => finish(signal || 'code ' + code));
  }

  function tick() {
    const p = proc;
    if (!p) return;
    const t = now() - t0;

    if (audioBlocked) {
      if (now() - blockedSince >= STALL_MS) { log('ffmpeg is not reading, restarting it'); p.kill('SIGKILL'); return; }
    } else {
      const owed = Math.floor((t + LEAD_MS) * RATE / 1000) - sentSamples;
      if (owed > 0) {
        const want = owed * 4;
        let buf = readAudio(want);
        if (buf.length < want) buf = Buffer.concat([buf, Buffer.alloc(want - buf.length)]); // silence
        sentSamples += owed;
        if (!p.stdio[3].write(buf)) {
          audioBlocked = true;
          blockedSince = now();
          p.stdio[3].once('drain', () => { if (proc === p) audioBlocked = false; });
        }
      }
    }

    const beat = t >= nextBeat;
    while (nextBeat <= t) nextBeat += beatMs; // a missed heartbeat is skipped, not made up
    if (frame && !videoBlocked && (beat || (dirty && t - lastWrite >= MIN_GAP_MS))) {
      dirty = false;
      lastWrite = t;
      if (!p.stdin.write(frame)) {
        videoBlocked = true;
        p.stdin.once('drain', () => { if (proc === p) { videoBlocked = false; dirty = true; } });
      }
    }
  }

  return {
    start() {
      if (!stopped) return;
      stopped = false;
      launch();
      if (autoTick) interval = setInterval(tick, TICK_MS);
    },
    stop() {
      stopped = true;
      if (interval) { clearInterval(interval); interval = null; }
      if (restartTimer !== null) { clearTimer(restartTimer); restartTimer = null; }
      const p = proc;
      if (!p) return Promise.resolve();
      return new Promise((resolve) => {
        const killer = setTimeout(() => p.kill('SIGKILL'), KILL_AFTER_MS);
        p.once('exit', () => { clearTimeout(killer); resolve(); });
        p.stdin.end();
        p.stdio[3].end();
      });
    },
    setFrame(rgba) {
      frame = Buffer.isBuffer(rgba) ? rgba : Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength);
      dirty = true;
    },
    _tick: tick,
  };
}

module.exports = { createEncoder, ffmpegArgs };
```

Note on the backed-up video test: a frame set while the pipe is blocked leaves `dirty` true, and the drain handler also sets it, so the current picture is written on the first tick after the pipe drains.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd twitch-bot && npm test 2>&1 | tail -9`
Expected: `pass 87`, `fail 0`. The run must also exit promptly: the `stop` test leaves a 3-second kill timer only if `exit` never fires, and the test fires it.

- [ ] **Step 5: Commit**

```bash
git add twitch-bot/encoder.js twitch-bot/test/encoder.test.js
git commit -m "twitch-bot: encoder that sends frames on change and clocks the audio

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Wiring and the end-to-end test

**Files:**
- Create: `twitch-bot/main.js`
- Test: `twitch-bot/test/e2e.test.js`

**Interfaces:**
- Consumes: everything above — `loadConfig` (Task 2), `createChat` (Task 3), `createRotation` (Task 4), `createSession` (Task 5), `composeFrame` (Task 6), `createMusic`/`loadIndex` (Task 7), `createEncoder` (Task 8); from `../discord-bot/`: `createPool({ size })`, `createSourceStore({ dataDir })`, `createGistStore({ dataDir, token, sources })` → `{ getSource }`, `loadGallery()`.
- Produces: `createApp({ cfg, gallery, getSource, log? })` → `{ session, start(), stop() }` where `cfg` needs `dataDir`, `output`, `minFps`. Running `node main.js` starts the app with the real config and chat.

- [ ] **Step 1: Write the failing test**

`twitch-bot/test/e2e.test.js`:

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');
const { createApp } = require('../main');

const SOKOBAN = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'demo', 'sokoban_basic.txt'), 'utf8');
const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0 && spawnSync('ffprobe', ['-version']).status === 0;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('the whole pipeline produces a playable stream with video and audio', { skip: hasFfmpeg ? false : 'ffmpeg is not installed', timeout: 60000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'twitch-e2e-'));
  fs.mkdirSync(path.join(dir, 'music', 'album'), { recursive: true });
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=330:duration=20', '-ac', '2', path.join(dir, 'music', 'album', 'tone.wav')]);
  fs.writeFileSync(path.join(dir, 'music-index.json'), JSON.stringify({ root: path.join(dir, 'music'), tracks: [{ path: 'album/tone.wav', album: 'album', title: 'tone', seconds: 20 }] }));
  const out = path.join(dir, 'out.flv');

  const app = createApp({
    cfg: { dataDir: dir, output: out, minFps: 1 },
    gallery: [{ gistId: 'aaaa', title: 'Sokoban', author: 'test' }],
    getSource: async () => SOKOBAN,
    log: () => {},
  });
  await app.start();
  assert.equal(app.session.view().phase, 'playing');
  const moves = ['right', 'up', 'l', 'd', 'x', 'z'];
  moves.forEach((text, i) => setTimeout(() => app.session.handleChat({ user: 'tester', text }), 1500 + i * 1300));
  await wait(12000);
  assert.ok(app.session.view().moves.length >= 4, 'chat moved the player');
  await app.stop();

  const streams = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,width,height,sample_rate,channels', '-of', 'json', out], { encoding: 'utf8' })).streams;
  const video = streams.find((s) => s.codec_type === 'video'), audio = streams.find((s) => s.codec_type === 'audio');
  assert.equal(video.codec_name, 'h264');
  assert.deepEqual([video.width, video.height], [1280, 720]);
  assert.equal(audio.codec_name, 'aac');
  assert.equal(Number(audio.sample_rate), 44100);
  assert.equal(audio.channels, 2);

  const packets = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'packet=codec_type,pts_time,flags', '-of', 'csv=p=0', out], { encoding: 'utf8' })
    .trim().split('\n').map((line) => line.split(',')).map(([type, pts, flags]) => ({ type, t: Number(pts), key: String(flags).includes('K') }));
  const v = packets.filter((p) => p.type === 'video'), a = packets.filter((p) => p.type === 'audio');
  assert.ok(v.length >= 12, 'a heartbeat frame each second, plus the moves: got ' + v.length);
  assert.ok(v.length <= 60, 'frames are sent on change, not continuously: got ' + v.length);
  const keys = v.filter((p) => p.key).map((p) => p.t);
  assert.ok(keys.length >= 5, 'keyframes: got ' + keys.length);
  for (let i = 1; i < keys.length; i++) assert.ok(keys[i] - keys[i - 1] <= 2.2, 'keyframe gap ' + (keys[i] - keys[i - 1]));
  assert.ok(a[a.length - 1].t >= 10, 'audio runs the whole time');
  for (let i = 1; i < a.length; i++) assert.ok(a[i].t - a[i - 1].t < 0.1, 'audio gap at ' + a[i].t);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd twitch-bot && node --test test/e2e.test.js 2>&1 | tail -8`
Expected: FAIL with `Cannot find module '../main'`.

- [ ] **Step 3: Implement**

`twitch-bot/main.js`:

```js
'use strict';
const { loadConfig } = require('./config');
const { createChat } = require('./chat');
const { createRotation } = require('./rotation');
const { createSession } = require('./session');
const { composeFrame } = require('./frame');
const { createMusic, loadIndex } = require('./music');
const { createEncoder } = require('./encoder');
const { createPool } = require('../discord-bot/pool');
const { createSourceStore } = require('../discord-bot/sources');
const { createGistStore } = require('../discord-bot/gists');
const { loadGallery } = require('../discord-bot/gallery');

const SESSION_TICK_MS = 500;

// Everything except chat and GitHub, which the end-to-end test replaces.
function createApp({ cfg, gallery, getSource, log = console.log }) {
  const pool = createPool({ size: 1 });
  const rotation = createRotation({ gallery, dataDir: cfg.dataDir });
  const index = loadIndex(cfg.dataDir);
  if (!index) log('no music index (run: node index-music.js); the stream will be silent');
  let session = null, encoder = null, music = null, ticker = null;

  // The picture changes only when the game, the votes or the music change, so that is when it is redrawn.
  const refresh = () => {
    if (!session || !encoder || !music) return;
    try {
      encoder.setFrame(composeFrame(Object.assign(session.view(), { music: music.current() })).rgba);
    } catch (e) { log('could not draw the frame', e); }
  };

  music = createMusic({ index, onTrack: refresh, log });
  encoder = createEncoder({ output: cfg.output, minFps: cfg.minFps, readAudio: music.read, log });
  session = createSession({ pool, getSource, rotation, onChange: refresh, log });

  return {
    session,
    async start() {
      music.start();
      refresh(); // "back soon" until the first game has loaded
      encoder.start();
      ticker = setInterval(() => session.tick(), SESSION_TICK_MS);
      await session.start();
    },
    async stop() {
      if (ticker) { clearInterval(ticker); ticker = null; }
      music.stop();
      await encoder.stop();
      await pool.close();
    },
  };
}

async function main() {
  const cfg = loadConfig();
  const sources = createSourceStore({ dataDir: cfg.dataDir });
  const gists = createGistStore({ dataDir: cfg.dataDir, token: cfg.githubToken, sources });
  const app = createApp({ cfg, gallery: loadGallery(), getSource: gists.getSource });
  const chat = createChat({ channel: cfg.channel, onMessage: (m) => app.session.handleChat(m) });
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    chat.close();
    await app.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  await app.start();
  chat.start();
  console.log('streaming; reading chat in #' + cfg.channel); // never log cfg.output: it contains the stream key
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });

module.exports = { createApp };
```

- [ ] **Step 4: Run the end-to-end test**

Run: `cd twitch-bot && node --test test/e2e.test.js 2>&1 | tail -12`
Expected: PASS in about 14 seconds. If a keyframe-gap or audio-gap assertion fails, print the packet list (`ffprobe -v error -show_entries packet=codec_type,pts_time,flags -of csv=p=0 <out.flv>`) and compare against the measured behaviour recorded in Task 8 before changing anything; do not loosen the assertions to make it pass.

- [ ] **Step 5: Watch the result once**

Run:

```bash
cd twitch-bot && node -e "
const fs=require('fs'),os=require('os'),path=require('path');const {createApp}=require('./main');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'twitch-look-'));const out=path.join(dir,'look.flv');
const app=createApp({cfg:{dataDir:dir,output:out,minFps:1},gallery:[{gistId:'aaaa',title:'x',author:'y'}],getSource:async()=>fs.readFileSync('../src/demo/heroes_of_sokoban.txt','utf8'),log:()=>{}});
(async()=>{await app.start();['a','right','right','up','left'].forEach((t,i)=>setTimeout(()=>app.session.handleChat({user:'viewer'+i,text:t}),4500+i*600));
await new Promise(r=>setTimeout(r,9000));await app.stop();console.log(out);})();" \
  | xargs -I{} ffmpeg -v error -y -i {} -fps_mode passthrough -update 1 /tmp/twitch-last-frame.png && echo wrote /tmp/twitch-last-frame.png
```

Open `/tmp/twitch-last-frame.png` (use the Read tool). Expected: a 1280×720 picture with the Heroes of Sokoban level, its grey brick frame, and `viewer…` names in the move log. (There is no music line: this run has no index.)

- [ ] **Step 6: Run the whole suite and commit**

Run: `cd twitch-bot && npm test 2>&1 | tail -9`
Expected: `pass 88`, `fail 0`.

```bash
git add twitch-bot/main.js twitch-bot/test/e2e.test.js
git commit -m "twitch-bot: wire the stream together, with an end-to-end test

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Deployment files, README and final checks

**Files:**
- Create: `twitch-bot/.env.example`, `twitch-bot/puzzlescript-twitch.service`, `twitch-bot/deploy.sh`, `twitch-bot/README.md`

**Interfaces:**
- Consumes: the config keys from Task 2; `node index-music.js` from Task 7; `node main.js` from Task 9.
- Produces: files only. Nothing is deployed in this task.

- [ ] **Step 1: Write the files**

`twitch-bot/.env.example`:

```
# Channel whose chat is read: the login name, without the #
TWITCH_CHANNEL=
# Stream key from the Twitch dashboard (Settings → Stream). Never commit this.
TWITCH_STREAM_KEY=
# GitHub personal access token, no scopes needed, for the gists API
GITHUB_TOKEN=
# Optional: where the album folders live
MUSIC_DIR=/mnt/media/increpare
# Optional: lowest video frame rate while nothing changes. Raise it if Twitch objects to 1.
MIN_FPS=1
```

`twitch-bot/puzzlescript-twitch.service`:

```
[Unit]
Description=Twitch plays PuzzleScript
After=network-online.target

[Service]
WorkingDirectory=%h/puzzlescript-twitch/twitch-bot
ExecStart=/usr/bin/node main.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=default.target
```

`twitch-bot/deploy.sh`:

```bash
#!/usr/bin/env bash
# twitch-bot/deploy.sh — sync the engine, the shared bot code and the Twitch bot to the Pi.
# It has its own directory there, so it never disturbs the Discord bot in ~/puzzlescript-bot.
set -euo pipefail
HOST="${PSTWITCH_HOST:-box@192.168.178.69}"
DEST="${PSTWITCH_DEST:-puzzlescript-twitch}"
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"

ssh "$HOST" "mkdir -p ~/$DEST/src ~/$DEST/discord-bot ~/$DEST/twitch-bot ~/.config/systemd/user"
rsync -az --delete "$ROOT/src/js/" "$HOST:~/$DEST/src/js/"
rsync -az "$ROOT/src/games_dat.js" "$HOST:~/$DEST/src/games_dat.js"
rsync -az --delete --exclude node_modules --exclude data --exclude .env --exclude test "$ROOT/discord-bot/" "$HOST:~/$DEST/discord-bot/"
rsync -az --delete --exclude node_modules --exclude data --exclude .env "$HERE/" "$HOST:~/$DEST/twitch-bot/"
ssh "$HOST" "cd ~/$DEST/twitch-bot && cp puzzlescript-twitch.service ~/.config/systemd/user/ && systemctl --user daemon-reload \
  && if [ -f .env ] && [ -f data/music-index.json ]; then \
       systemctl --user enable puzzlescript-twitch >/dev/null && systemctl --user restart puzzlescript-twitch \
       && sleep 3 && systemctl --user is-active --quiet puzzlescript-twitch && systemctl --user --no-pager status puzzlescript-twitch | head -5; \
     else echo 'Synced, not started: create .env and run node index-music.js first (see README.md).'; fi"
```

Then: `chmod +x twitch-bot/deploy.sh`

`twitch-bot/README.md`:

```markdown
# Twitch plays PuzzleScript

A stream that loops through the PuzzleScript gallery. Viewers type moves in
chat and each one is applied straight away, in the order it arrived. Realtime
games are skipped. Music is played on shuffle from the album folders on the Pi.

Design: `docs/superpowers/specs/2026-10-07-twitch-plays-puzzlescript-design.md`.

## Chat commands

| Type | To |
|---|---|
| `up` `down` `left` `right`, or `u` `d` `l` `r` | move |
| `action`, `a` or `x` | action |
| `undo` or `z` | undo |
| `restart` | restart the level |
| `!skip` | vote for the next game |

Any case. The whole message has to be the command. A leading `!` also works
(`!up`). The next game comes when the game is won, when enough viewers vote
`!skip` (3, or half of those who moved in the last ten minutes if that is
fewer), or after 15 minutes without a move.

## Layout

The bot uses the engine in `../src/js` and several modules of `../discord-bot`
as a library, so it must sit beside copies of both. `deploy.sh` syncs all
three to `~/puzzlescript-twitch/` on the Pi, separate from the Discord bot.

## Going live (once)

1. `./deploy.sh` — the first run syncs the files and stops there.
2. On the Pi, in `~/puzzlescript-twitch/twitch-bot/`: `cp .env.example .env`
   and fill in the channel, the stream key and a GitHub token.
3. `node index-music.js` — lists the tracks into `data/music-index.json`. The
   music is only read. Run it again only if the album folders change.
4. `./deploy.sh` again — this time it starts the service.
5. If the service should survive logout and reboot: `sudo loginctl enable-linger box`.

## Check on the first stream

- Twitch accepts the stream and viewers see no buffering. While nothing is
  happening the video is 1 frame a second; if Twitch objects, set `MIN_FPS=5`
  (or 10) in `.env` and restart.
- Typing `up` in chat moves the player and your name appears in the log.

## Run locally

    npm test                      # the end-to-end test needs ffmpeg
    OUTPUT=/tmp/test.flv TWITCH_CHANNEL=somechannel GITHUB_TOKEN=... node main.js

With `OUTPUT` set the stream goes to that file (or URL) and no stream key is needed.

## Operations

- Logs: `journalctl --user -u puzzlescript-twitch -f`
- Restart: `systemctl --user restart puzzlescript-twitch`
- `data/state.json` is the game order and position; `data/progress.json` is
  the level reached in each game. Delete either to reset it.
- ffmpeg is restarted automatically if it exits, which also covers Twitch
  ending a broadcast after 48 hours.
- Cost on the Pi 5: about 6% of one core while idle.
```

- [ ] **Step 2: Check the shell script and the unit file**

Run: `bash -n twitch-bot/deploy.sh && echo syntax ok && test -x twitch-bot/deploy.sh && echo executable && grep -c ExecStart twitch-bot/puzzlescript-twitch.service`
Expected: `syntax ok`, `executable`, `1`. Do not run `deploy.sh`.

- [ ] **Step 3: Check that secrets and data cannot be committed**

Run: `cd twitch-bot && touch .env && mkdir -p data && touch data/x && git status --short . ; rm -f .env data/x && rmdir data`
Expected: neither `.env` nor `data/` is listed.

- [ ] **Step 4: Run every suite**

Run: `cd twitch-bot && npm test 2>&1 | tail -9`
Expected: `pass 88`, `fail 0`.

Run: `cd discord-bot && npm test 2>&1 | tail -9`
Expected: `pass 75`, `fail 0` (about 3 minutes).

Run: `cd src && node tests/run_tests_node.js 2>&1 | tail -4`
Expected: `Errors:  0` and `Total:   770 tests` (about 2 minutes). Nothing under `src/` was changed, so this confirms the engine is untouched.

Run: `git status --short && git diff master --stat -- src | tail -1`
Expected: only the four new files are untracked or modified, and no changes under `src/`.

- [ ] **Step 5: Commit**

```bash
git add twitch-bot/.env.example twitch-bot/puzzlescript-twitch.service twitch-bot/deploy.sh twitch-bot/README.md
git commit -m "twitch-bot: deployment script, user service unit, README

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 6: Hand over**

Report to the user: what was built, the test results from Step 4 (with counts), and that going live is theirs to do by following "Going live" in `twitch-bot/README.md`, because it needs their stream key. List the two things to watch on the first stream from the README.

---

## What changed during execution

The code blocks above are the plan as written. The tasks were reviewed one by
one and the branch as a whole, and these parts of the final code differ from
them. The test counts quoted in the tasks are therefore out of date: the
finished suites are 129 tests in `twitch-bot/` and 78 in `discord-bot/`.

- **Commit trailers** name the model that made each commit, not the literal
  `Claude Opus 5.5`.
- **Task 4, rotation test:** "plays every game once before any repeats"
  called `advance()` once per comparison and failed about half the time. It
  now advances once.
- **Task 5, session:** a failed write of progress or of the game order is
  logged and play continues, and a switch always ends in `playing` or
  `waiting`. As planned, one failed write could freeze the session in
  `loading` or abandon a healthy game.
- **Task 7, music:** `stop()` also closes the decoder's pipe (a decoder
  paused on a full pipe ignored the signal and kept the process alive). A
  decoder that cannot start, has no output pipe, or produces nothing for
  10 s counts as a failed track. `index-music.js` refuses to write an empty
  index.
- **Task 8, encoder:**
  - The video drain handler no longer marks the picture as changed. As
    planned, a real 921,600-byte frame always backs the pipe up, so the same
    frame would have been re-sent about 16 times a second.
  - A launch that throws or returns a child without pipes goes through the
    restart backoff.
  - Keyframes are spaced by frame count (`-g max(2, floor(2 × minFps))`)
    instead of `-force_key_frames expr:gte(t,n_forced*2-0.1)`, and `MIN_FPS`
    is kept between 1 and 20. The time rule depended on ffmpeg's start-up
    delay and let the gap reach 2.8 s in the end-to-end test.
  - ffmpeg is restarted if the system clock steps by more than a second.
  - Log lines are buffered by line and the stream key itself is redacted, as
    well as the output address.
- **Task 9, wiring:** shutdown has a try/catch and an 8-second deadline; the
  end-to-end test stops the app and removes its temporary folder even when it
  fails.
- **After Task 10:** `master` was merged in. Its snapshots carry level
  numbers that leave out message screens, and the frame now shows those.
  Commands padded with invisible characters are accepted. The chat reconnect
  delay resets only after a connection has lasted 30 s. `deploy.sh` prints
  the journal when the service fails to start.

