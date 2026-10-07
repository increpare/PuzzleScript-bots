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
// A chain of again turns is run until it ends, repeats a state, or reaches this many turns.
const STEP_CAP = 1000;
// Frames kept for animating one move; beyond either limit the move is shown without animation.
const MAX_FRAMES = 300;
const MAX_CAPTURE_BYTES = 16 * 1024 * 1024;
const DEFAULT_AGAIN_INTERVAL_MS = 150; // the engine's own default

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
function createHost({ totalMs = Infinity, stepCap = STEP_CAP, maxFrames = MAX_FRAMES, onStep = null, now = Date.now } = {}) {
  const ctx = vm.createContext(makeSandbox());
  getEngineScript().runInContext(ctx);
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

  function load(source, seed, levelIndex) {
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
    begin(false);
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
  let lastFrames = null;

  function begin(capture) {
    call = { deadline: now() + totalMs, capture: capture ? { list: [], bytes: 0, ok: true } : null };
    lastFrames = null;
  }

  function end() {
    const c = call && call.capture;
    call = null;
    if (!c || !c.ok || c.list.length < 2) return;
    const md = ps.state.metadata || {};
    const interval = Number(md.again_interval);
    lastFrames = {
      list: c.list,
      loop: pending !== null,
      intervalMs: Number.isFinite(interval) && interval > 0 ? Math.round(interval * 1000) : DEFAULT_AGAIN_INTERVAL_MS,
      stride: ps.STRIDE_OBJ,
      objectCount: ps.state.objectCount,
    };
  }

  // Everything the next turn depends on, folded into one 53-bit number: the level, pending
  // movements, which level it is, and the random generator. Two different states colliding would
  // cut a chain short, so two independent 32-bit hashes are combined.
  function stateKey() {
    let h1 = 0x811c9dc5 | 0, h2 = 0x1b873593 | 0;
    const mix = (v) => {
      h1 = Math.imul(h1 ^ v, 0x01000193);
      h2 = Math.imul((h2 + v) | 0, 0x85ebca6b) ^ (h2 >>> 13);
    };
    mix(ps.curlevel | 0);
    const level = ps.level;
    const o = (level && level.objects) || [];
    for (let i = 0; i < o.length; i++) mix(o[i]);
    const m = (level && level.movements) || [];
    for (let i = 0; i < m.length; i++) mix(m[i]);
    const r = ps.RandomGen && ps.RandomGen._state;
    if (r && r.s) { mix(r.i); mix(r.j); for (let i = 0; i < r.s.length; i++) mix(r.s[i]); }
    return (h1 >>> 0) * 0x200000 + ((h2 >>> 0) & 0x1fffff);
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
    if (!ps.againing) return;
    const seen = new Set([stateKey()]);
    let n = 0;
    while (ps.againing) {
      if (n >= stepCap) { pending = 'more'; return; }
      ps.againing = false;
      ctx.processInput(-1);
      n++;
      if (ps.againing) {
        const key = stateKey();
        // the repeated state is where the loop closes: it is already on screen, so do not count it again
        if (seen.has(key)) { if (onStep) onStep(); pending = 'loop'; return; }
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
    const sprites = {};
    for (let k = 0; k < objectCount; k++) {
      const o = state.objects[state.idDict[k]];
      sprites[k] = { colors: o.colors.map(hexColor), dat: o.spritematrix };
    }
    return Object.assign(base, { kind: 'level', width: level.width, height: level.height, cells, sprites, viewport: viewport() });
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

  // The frames of the last input, if it was captured and ran for more than one turn. Handed over once.
  function takeFrames() {
    const f = lastFrames;
    lastFrames = null;
    return f;
  }

  function replay(actions) { for (const a of actions) input(a); }

  return {
    load,
    input,
    tick,
    replay,
    takeFrames,
    _rawInput: rawInput,
    _ps: ps,
    snapshot,
    frameTiles,
    levelString: () => ctx.convertLevelToString(),
    dispose() { /* nothing to free; the context is garbage collected */ },
    _ctx: ctx, // test aid only
    _drainAgain: drainAgain,
  };
}

module.exports = { createHost, CompileError, EngineError, MoveTooLongError };
