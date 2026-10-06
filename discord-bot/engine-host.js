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
  // Top-level let bindings in the engine are not properties of the context
  // global, so expose the ones we need through accessors (same global lexical scope).
  const ps = vm.runInContext(`({
    get state() { return state; },
    get level() { return level; },
    get curlevel() { return curlevel; },
    get titleScreen() { return titleScreen; },
    get messagetext() { return messagetext; },
    get againing() { return againing; },
    set againing(v) { againing = v; },
    get oldflickscreendat() { return oldflickscreendat; },
    get errorStrings() { return errorStrings; },
    get errorCount() { return errorCount; },
    get STRIDE_OBJ() { return STRIDE_OBJ; },
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
    try {
      ctx.compile(['loadLevel', levelIndex | 0], source, gameSeed + ':' + (levelIndex | 0));
    } catch (e) {
      throw new CompileError(ps.errorCount > 0 ? firstError() : String(e && e.message || e));
    }
    if (ps.errorCount > 0) throw new CompileError(firstError());
    if (!ps.state || !ps.state.levels || ps.state.levels.length === 0) throw new CompileError('game has no levels');
    drainAgain();
    const md = ps.state.metadata || {};
    return {
      title: md.title || 'untitled',
      author: md.author || '',
      levelCount: ps.state.levels.length,
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
    while (ps.againing) {
      ps.againing = false;
      ctx.processInput(-1);
      if (++n > AGAIN_LIMIT) throw new EngineError('again loop did not terminate');
    }
  }

  function findPlayer() {
    const level = ps.level;
    const mask = ps.state.playerMask;
    const probe = new ctx.BitVec(ps.STRIDE_OBJ);
    for (let i = 0; i < level.n_tiles; i++) {
      level.getCellInto(i, probe);
      if (probe.anyBitsInCommon(mask)) return { x: (i / level.height) | 0, y: i % level.height };
    }
    return null;
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
      background: hexColor(state.bgcolor),
      textColor: hexColor(state.fgcolor),
      message: null,
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
