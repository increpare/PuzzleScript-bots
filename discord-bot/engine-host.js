'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { SRC_DIR } = require('./engine-src');

const ENGINE_FILES = [
  'js/storagewrapper.js', 'js/bitvec.js', 'js/level.js', 'js/languageConstants.js',
  'js/globalVariables.js', 'js/debug.js', 'js/font.js', 'js/rng.js', 'js/riffwave.js',
  'js/sfxr.js', 'js/codemirror/stringstream.js', 'js/colorhelpers.js', 'js/colors.js',
  'js/engine.js', 'js/parser.js', 'js/compiler.js', 'js/soundbar.js',
];
// A chain of again turns is run until it ends, repeats a state, or reaches this many turns.
const STEP_CAP = 1000;
// Frames kept for animating one move; beyond either limit the move is shown without animation.
const MAX_FRAMES = 300;
const MAX_CAPTURE_BYTES = 16 * 1024 * 1024;
const DEFAULT_AGAIN_INTERVAL_MS = 150; // the engine's own default
// How long each move of a typed run stays on screen: as long as a held key takes to repeat.
const RUN_MOVE_MS = 150;
const REPLAY_BUDGET_SCALE = 3;

class CompileError extends Error {}
class EngineError extends Error {}
CompileError.prototype.name = 'CompileError';
EngineError.prototype.name = 'EngineError';
// A move's chain of again turns ran past the time budget. The host is left part-way through the
// chain, so it must be discarded and rebuilt from the input log.
class MoveTooLongError extends Error {}
MoveTooLongError.prototype.name = 'MoveTooLongError';

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

// levelToText: the level as legend glyphs. It is the editor page's own file, run here in the same
// engine scope, so that the bot and the page turn a level into text in exactly one way.
let levelTextScript = null;
function getLevelTextScript() {
  if (levelTextScript === null) {
    const file = path.join(__dirname, 'activity', 'level-text.js');
    levelTextScript = new vm.Script(fs.readFileSync(file, 'utf8'), { filename: 'level-text.js' });
  }
  return levelTextScript;
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

// Players count levels without the message screens between them. A message screen is shown
// under the number of the level it introduces.
function levelNumbering(levels, cur) {
  let before = 0, total = 0;
  for (let i = 0; i < levels.length; i++) {
    if (levels[i] && levels[i].message !== undefined) continue;
    total++;
    if (i <= cur) before++;
  }
  const onMessage = levels[cur] && levels[cur].message !== undefined;
  return { levelNumber: Math.max(1, Math.min(total, onMessage ? before + 1 : before)), realLevelCount: total };
}

// totalMs: wall-clock budget for one input's whole chain (checked between turns).
// onStep: called after every turn the engine runs, so a caller can tell slow progress from none.
// A fresh context with the engine loaded in it and nothing compiled.
function createEngineContext() {
  const ctx = vm.createContext(makeSandbox());
  getEngineScript().runInContext(ctx);
  return ctx;
}

function createHost({ totalMs = Infinity, stepCap = STEP_CAP, maxFrames = MAX_FRAMES, onStep = null, now = Date.now } = {}) {
  const ctx = createEngineContext();
  getLevelTextScript().runInContext(ctx);
  // Top-level let bindings in the engine are not properties of the context
  // global, so expose the ones we need through accessors (same global lexical scope).
  const ps = vm.runInContext(`({
    get state() { return state; },
    get level() { return level; },
    get curlevel() { return curlevel; },
    get titleScreen() { return titleScreen; },
    get messagetext() { return messagetext; },
    set messagetext(v) { messagetext = v; },
    get againing() { return againing; },
    set againing(v) { againing = v; },
    get oldflickscreendat() { return oldflickscreendat; },
    get errorStrings() { return errorStrings; },
    get errorCount() { return errorCount; },
    get STRIDE_OBJ() { return STRIDE_OBJ; },
    get RandomGen() { return RandomGen; },
    get restartTarget() { return restartTarget; },
    set unitTesting(v) { unitTesting = v; },
    set lazyFunctionGeneration(v) { lazyFunctionGeneration = v; },
  })`, ctx);
  ctx.stripHTMLTags = (s) => s.replace(/<\/?[a-zA-Z][^>]*>/g, '').trim();
  ps.unitTesting = true;
  ps.lazyFunctionGeneration = false;

  // Make every level load deterministic from the game seed. The engine
  // generates a Math.random()-based seed when none is passed (nextLevel,
  // checkpoint restores); we route all of those through the game seed.
  let gameSeed = 'seed';
  const origLoadLevelFromLevelDat = ctx.loadLevelFromLevelDat;
  ctx.loadLevelFromLevelDat = function (state, leveldat, randomseed, clearinputhistory) {
    if (!randomseed) randomseed = gameSeed + ':' + ps.curlevel;
    return origLoadLevelFromLevelDat(state, leveldat, randomseed, clearinputhistory);
  };

  function resetErrors() {
    ctx.resetParserErrorState();
  }

  function firstError() {
    const s = (ps.errorStrings && ps.errorStrings[0]) || 'unknown compile error';
    return ctx.stripHTMLTags(String(s));
  }

  // rebuild: the game is being brought back from its input log, which allows the longer replay budget
  function load(source, seed, levelIndex, { rebuild = false } = {}) {
    gameSeed = String(seed);
    resetErrors();
    // Seeding asymmetry: the first level is seeded with the raw game seed (matching the
    // harness); later loads derive 'seed:curlevel' (see loadLevelFromLevelDat). Rebuilds
    // always start from startLevel, so replaying the input log is deterministic.
    try {
      ctx.compile(['loadLevel', levelIndex | 0], source, gameSeed);
    } catch (e) {
      throw new CompileError(ps.errorCount > 0 ? firstError() : String(e && e.message || e));
    }
    if (ps.errorCount > 0) throw new CompileError(firstError());
    if (!ps.state || !ps.state.levels || ps.state.levels.length === 0) throw new CompileError('game has no levels');
    begin(false, rebuild ? REPLAY_BUDGET_SCALE : 1);
    try { drainAgain(); } finally { end(); }
    const md = ps.state.metadata || {};
    return {
      title: md.title || 'untitled',
      author: md.author || '',
      levelCount: ps.state.levels.length,
      // indices of the entries that are real levels (message screens are entries too, but are not counted as levels)
      realLevels: ps.state.levels.map((l, i) => (l && l.message === undefined ? i : -1)).filter((i) => i >= 0),
      flags: {
        noaction: 'noaction' in md,
        noundo: 'noundo' in md,
        norestart: 'norestart' in md,
        realtime: md.realtime_interval !== undefined,
      },
    };
  }

  // Per-call bookkeeping: the deadline for this input, and the frames captured for animating it.
  let call = null;
  // Why the last chain stopped while the engine still wanted another turn: 'loop' (a state came
  // round again, so it would never end) or 'more' (it reached the step cap). null when it ended.
  let pending = null;
  // Whether a loop closed on the first state of its chain, so that its frames can simply be repeated.
  let loopIsWhole = false;
  let lastFrames = null;

  function begin(capture, budgetScale = 1) {
    call = { deadline: now() + totalMs * budgetScale, capture: capture ? { list: [], bytes: 0, ok: true } : null };
    lastFrames = null;
  }

  function end() {
    const c = call && call.capture;
    call = null;
    if (!c || !c.ok || c.list.length < 2) return;
    lastFrames = {
      list: c.list,
      loop: pending === 'loop' && loopIsWhole,
      intervalMs: againIntervalMs(),
      stride: ps.STRIDE_OBJ,
      objectCount: ps.state.objectCount,
      sprites: allSprites(),
      background: hexColor(ps.state.bgcolor),
      textColor: hexColor(ps.state.fgcolor),
    };
  }

  // The time between the turns of an again chain, which is also the time one frame is shown for.
  function againIntervalMs() {
    const interval = Number((ps.state.metadata || {}).again_interval);
    return Number.isFinite(interval) && interval > 0 ? Math.round(interval * 1000) : DEFAULT_AGAIN_INTERVAL_MS;
  }

  // A digest of everything the next turn depends on: which level it is, the level itself, pending
  // movements, the random generator, and the state a restart command would return to. Two different
  // states sharing a key would cut a chain short, so this is a real digest and not a quick hash.
  function stateKey() {
    const bytes = (a) => Buffer.from(a.buffer, a.byteOffset, a.byteLength);
    const h = crypto.createHash('sha256');
    h.update(String(ps.curlevel | 0));
    const level = ps.level;
    if (level && level.objects) h.update(bytes(level.objects));
    h.update('|');
    if (level && level.movements) h.update(bytes(level.movements));
    h.update('|');
    const r = ps.RandomGen && ps.RandomGen._state;
    if (r && r.s) h.update(Buffer.from([r.i, r.j, ...r.s]));
    h.update('|');
    const target = ps.restartTarget;
    if (target && target.dat) h.update(bytes(ArrayBuffer.isView(target.dat) ? target.dat : Int32Array.from(target.dat)));
    return h.digest('base64');
  }

  function sameFrame(a, b) {
    if (a.kind !== b.kind) return false;
    if (a.kind !== 'level') return a.message === b.message;
    if (a.width !== b.width || a.height !== b.height || a.objects.length !== b.objects.length) return false;
    const va = a.viewport, vb = b.viewport;
    if (va.x !== vb.x || va.y !== vb.y || va.w !== vb.w || va.h !== vb.h) return false;
    for (let i = 0; i < a.objects.length; i++) if (a.objects[i] !== b.objects[i]) return false;
    return true;
  }

  // What the screen shows right now, in a form small enough to keep one per turn.
  function captureFrame() {
    const c = call.capture;
    let f;
    const leveldat = ps.state.levels[ps.curlevel];
    if (ps.titleScreen) f = { kind: 'finished', message: null };
    else if (leveldat && leveldat.message !== undefined) f = { kind: 'message', message: String(leveldat.message).trim() };
    else {
      const level = ps.level;
      f = { kind: 'level', width: level.width, height: level.height, viewport: viewport(), objects: new Int32Array(level.objects) };
    }
    const prev = c.list[c.list.length - 1];
    if (prev && sameFrame(prev, f)) { prev.repeat++; return; }
    f.repeat = 1;
    c.bytes += f.objects ? f.objects.byteLength : 0;
    if (c.list.length >= maxFrames || c.bytes > MAX_CAPTURE_BYTES) { c.ok = false; c.list = []; return; }
    c.list.push(f);
  }

  // Runs after every turn of the engine.
  function afterStep() {
    if (onStep) onStep();
    if (call === null) return;
    if (now() > call.deadline) throw new MoveTooLongError('the move took too long');
    if (call.capture && call.capture.ok) captureFrame();
  }

  // Run the again turns the engine has asked for. A chain that would never end is stopped when a
  // state repeats; a very long one is paused at the step cap. Both stops depend only on the game
  // and its inputs, never on timing, so replaying the input log stops in the same place.
  function drainAgain() {
    pending = null;
    loopIsWhole = false;
    if (!ps.againing) return;
    const first = stateKey();
    // the state the chain starts from is only among the frames if this call has already drawn it
    const firstWasCaptured = !!(call && call.capture && call.capture.ok && call.capture.list.length > 0);
    const seen = new Set([first]);
    let n = 0;
    while (ps.againing) {
      if (n >= stepCap) { pending = 'more'; return; }
      ps.againing = false;
      ctx.processInput(-1);
      n++;
      if (ps.againing) {
        const key = stateKey();
        // the repeated state is where the loop closes: it is already on screen, so do not count it again
        if (seen.has(key)) {
          if (onStep) onStep();
          pending = 'loop';
          loopIsWhole = key === first && firstWasCaptured;
          return;
        }
        seen.add(key);
      }
      afterStep();
    }
  }

  function findPlayer() {
    const positions = ctx.getPlayerPositions();
    if (positions.length === 0) return null;
    const i = positions[0];
    const level = ps.level;
    return { x: (i / level.height) | 0, y: i % level.height };
  }

  function viewport() {
    const level = ps.level;
    const md = ps.state.metadata;
    const full = { x: 0, y: 0, w: level.width, h: level.height };
    const ofd = ps.oldflickscreendat || [];
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

  // Every object's sprite, by object id.
  function allSprites() {
    const state = ps.state;
    const sprites = {};
    for (let k = 0; k < state.objectCount; k++) {
      const o = state.objects[state.idDict[k]];
      sprites[k] = { colors: o.colors.map(hexColor), dat: o.spritematrix };
    }
    return sprites;
  }

  function snapshot() {
    const state = ps.state;
    const base = {
      levelIndex: ps.curlevel | 0,
      levelCount: state.levels.length,
      ...levelNumbering(state.levels, ps.curlevel | 0),
      background: hexColor(state.bgcolor),
      textColor: hexColor(state.fgcolor),
      message: null,
      // 'loop' or 'more' while an again chain is still running (moves are ignored until it is undone,
      // restarted or, for 'more', continued); null otherwise
      animating: ps.againing ? (pending || 'more') : null,
      width: 0, height: 0, cells: [], sprites: {}, viewport: { x: 0, y: 0, w: 0, h: 0 },
    };
    if (ps.titleScreen) return Object.assign(base, { kind: 'finished' });
    const leveldat = state.levels[ps.curlevel];
    if (leveldat && leveldat.message !== undefined) {
      return Object.assign(base, { kind: 'message', message: String(leveldat.message).trim() });
    }
    if (ps.messagetext && ps.messagetext.length > 0) {
      // in-rule message: the level state is already updated; show the text as an overlay frame
      return Object.assign(base, { kind: 'message', message: String(ps.messagetext).trim() });
    }
    const level = ps.level;
    const cells = new Array(level.n_tiles);
    const probe = new ctx.BitVec(ps.STRIDE_OBJ);
    const objectCount = state.objectCount;
    for (let i = 0; i < level.n_tiles; i++) {
      level.getCellInto(i, probe);
      const ids = [];
      for (let k = 0; k < objectCount; k++) if (probe.get(k)) ids.push(k);
      cells[i] = ids;
    }
    return Object.assign(base, { kind: 'level', width: level.width, height: level.height, cells, sprites: allSprites(), viewport: viewport() });
  }

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

  const DIRS = { up: 0, left: 1, down: 2, right: 3, action: 4 };

  function kindNow() {
    if (ps.titleScreen) return 'finished';
    const leveldat = ps.state.levels[ps.curlevel];
    if (leveldat && leveldat.message !== undefined) return 'messageLevel';
    if (ps.messagetext && ps.messagetext.length > 0) return 'messageRule';
    return 'level';
  }

  function rawInput(code) {
    ctx.processInput(code);
    afterStep();
    drainAgain();
  }

  function tick() { rawInput(-1); }

  function doInput(action) {
    const kind = kindNow();
    if (action === 'continue') {
      if (kind === 'messageLevel') { ctx.nextLevel(); afterStep(); drainAgain(); return true; }
      if (kind === 'messageRule') { ps.messagetext = ''; return true; }
      // a chain paused at the step cap carries on; a loop has nowhere new to go
      if (kind === 'level' && ps.againing && pending === 'more') { drainAgain(); return true; }
      return false;
    }
    if (kind !== 'level') return false;
    if (action === 'undo') {
      if ('noundo' in ps.state.metadata) return false;
      ctx.DoUndo(false, true); afterStep(); drainAgain(); return true;
    }
    if (action === 'restart') {
      if ('norestart' in ps.state.metadata) return false;
      ctx.DoRestart(); afterStep(); drainAgain(); return true;
    }
    if (!(action in DIRS)) return false;
    if (action === 'action' && 'noaction' in ps.state.metadata) return false;
    // The engine ignores moves while an again chain is running. A chain that is still running here
    // is a loop or a paused one, so the move is ignored until undo, restart or continue.
    if (ps.againing) return false;
    rawInput(DIRS[action]);
    return true;
  }

  // capture: keep a frame per turn so the move can be shown as an animation (see takeFrames)
  function input(action, { capture = false } = {}) {
    begin(capture);
    try { return doInput(action); } finally { end(); }
  }

  // Keeps the newest frame on screen long enough to be read: a frame is shown for a whole number
  // of again intervals, and a move of a run is to last at least RUN_MOVE_MS.
  function holdFrame() {
    const c = call && call.capture;
    if (!c || !c.ok || c.list.length === 0) return;
    c.list[c.list.length - 1].repeat += Math.ceil(RUN_MOVE_MS / againIntervalMs()) - 1;
  }

  // Several moves made as one, for moves that are typed rather than pressed. Each is made in turn
  // until the game does not take one or play leaves the level it began on (for a message, the next
  // level or the end). Returns how many were made. Captured, it is one animation: where the run
  // starts, then every move, with the board held after each as long as a held key takes to repeat.
  function run(actions, { capture = false } = {}) {
    begin(capture);
    let made = 0;
    try {
      const startLevel = ps.curlevel | 0;
      if (call.capture) { captureFrame(); holdFrame(); }
      for (const action of actions) {
        if (!doInput(action)) break;
        made++;
        holdFrame();
        if (kindNow() !== 'level' || (ps.curlevel | 0) !== startLevel) break;
      }
      return made;
    } finally {
      // A loop that ends a run cannot be shown by repeating its frames: they open with the moves that led to it.
      loopIsWhole = false;
      end();
    }
  }

  // The frames of the last input, if it was captured and ran for more than one turn. Handed over once.
  function takeFrames() {
    const f = lastFrames;
    lastFrames = null;
    return f;
  }

  // Rebuilding a game from its input log gets a longer budget than a live move: every input in the
  // log was within budget when it was made, and a busy moment must not make a game impossible to resume.
  function replay(actions) {
    for (const a of actions) {
      begin(false, REPLAY_BUDGET_SCALE);
      try { doInput(a); } finally { end(); }
    }
  }

  return {
    load,
    input,
    run,
    tick,
    replay,
    takeFrames,
    _rawInput: rawInput,
    _ps: ps,
    snapshot,
    frameTiles,
    levelString: () => ctx.convertLevelToString(),
    // One legend glyph per cell. With no index: the level being played, as it stands. With the
    // index of a level: that level as written, before run_rules_on_level_start or any move.
    levelText(levelIndex) {
      if (levelIndex === undefined || levelIndex === null) return String(ctx.levelToText());
      const written = ps.state.levels[levelIndex];
      if (!written || written.message !== undefined) throw new EngineError('that is not a level');
      return String(ctx.levelToText(written));
    },
    dispose() { /* nothing to free; the context is garbage collected */ },
    _ctx: ctx, // test aid only
    _drainAgain: drainAgain,
  };
}

module.exports = { createHost, createEngineContext, CompileError, EngineError, MoveTooLongError, REPLAY_BUDGET_SCALE };
