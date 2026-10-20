'use strict';
const vm = require('node:vm');
const { createCanvas } = require('@napi-rs/canvas');
const { createEngineContext, CompileError, EngineError, MoveTooLongError, REPLAY_BUDGET_SCALE } = require('./engine-host');
const { matchesSource, getPayload, getMetadata } = require('./legacy/pushing-it');
const { FRAME_W, FRAME_H } = require('./renderer');

const payload = new vm.Script(getPayload(), { filename: 'pushing-it-original.js' });
const DIRS = { up: 0, left: 1, down: 2, right: 3, action: 4 };
const MAX_CAPTURE_BYTES = 16 * 1024 * 1024;
const MOVE_MS = 150;

// The original game owns all geometry, drawing, collision detection, undo and win logic.
// This host supplies its browser globals and advances its timers in due-time/insertion order.
function createPushingItHost({ totalMs = Infinity, stepCap = 1000, maxFrames = 300, onStep = null, now = Date.now } = {}) {
  const ctx = createEngineContext();
  const ps = vm.runInContext(`({
    get state() { return state; },
    get titleScreen() { return titleScreen; },
    get againing() { return againing; },
    set againing(v) { againing = v; },
    set unitTesting(v) { unitTesting = v; },
    set lazyFunctionGeneration(v) { lazyFunctionGeneration = v; }
  })`, ctx);
  ps.unitTesting = true;
  ps.lazyFunctionGeneration = false;
  ctx.stripHTMLTags = (s) => String(s).replace(/<\/?[a-zA-Z][^>]*>/g, '').trim();
  const canvases = [];
  const makeCanvas = (w = 300, h = 150) => {
    const c = createCanvas(w, h);
    canvases.push(c);
    return c;
  };
  const canvas = makeCanvas(FRAME_W, FRAME_H);
  canvas.setAttribute = () => {};
  canvas.style = {};
  const elements = { gameCanvas: canvas, homepagelink: {}, hacklink: {} };
  ctx.document.getElementById = (id) => elements[id] || null;
  ctx.document.createElement = (tag) => tag.toLowerCase() === 'canvas' ? makeCanvas() : { style: {} };
  ctx.canvas = canvas;
  ctx.ctx = canvas.getContext('2d');
  // Audio is not played by game workers; ULBS only unlocks the browser's AudioContext.
  ctx.ULBS = () => {};
  // The 2021 payload uses the engine's former names for its title dimensions.
  Object.assign(ctx, vm.runInContext('({ titleWidth: TERMINAL_WIDTH, titleHeight: TERMINAL_HEIGHT })', ctx));

  let clock = 0, serial = 0;
  const timers = new Map();
  ctx.setTimeout = (fn, delay = 0) => {
    const id = ++serial;
    timers.set(id, { id, due: clock + Math.max(0, Number(delay) || 0), fn });
    return id;
  };
  ctx.clearTimeout = (id) => timers.delete(id);
  let call = null, lastFrames = null, interrupted = null;

  function raster() {
    return { width: FRAME_W, height: FRAME_H, rgba: new Uint8Array(ctx.ctx.getImageData(0, 0, FRAME_W, FRAME_H).data) };
  }

  function remember() {
    const capture = call && call.capture;
    if (!capture || !capture.ok) return;
    const image = raster();
    const prev = capture.list[capture.list.length - 1];
    if (prev && Buffer.from(prev.raster.rgba).equals(Buffer.from(image.rgba))) return;
    // Drawing twice at one instant only exposes the last picture, as in a browser event loop.
    if (prev && prev.at === clock) { capture.list.pop(); capture.bytes -= prev.raster.rgba.byteLength; }
    if (capture.list.length >= maxFrames || capture.bytes + image.rgba.byteLength > MAX_CAPTURE_BYTES) {
      capture.ok = false;
      capture.list = [];
      return;
    }
    capture.bytes += image.rgba.byteLength;
    capture.list.push({ kind: 'level', raster: image, at: clock, repeat: 1 });
  }

  function begin(capture, scale = 1) {
    lastFrames = null;
    call = { deadline: now() + totalMs * scale, capture: capture ? { list: [], bytes: 0, ok: true } : null };
    remember();
  }

  function end() {
    const c = call && call.capture;
    call = null;
    if (!c || !c.ok || c.list.length < 2) return;
    const list = c.list.map((f, i) => ({ ...f, delayMs: i + 1 < c.list.length ? c.list[i + 1].at - f.at : MOVE_MS }));
    lastFrames = { list, raster: true, loop: false, intervalMs: 40, sprites: {}, palette: Object.values(ctx.colscheme), background: '#c1fbc6', textColor: '#a20021' };
  }

  function afterStep() {
    if (onStep) onStep();
    if (call && now() > call.deadline) throw new MoveTooLongError('the move took too long');
  }

  function nextTimer() {
    let next = null;
    for (const timer of timers.values()) if (!next || timer.due < next.due || (timer.due === next.due && timer.id < next.id)) next = timer;
    return next;
  }

  function drain() {
    let steps = 0;
    while (timers.size && steps < stepCap) {
      const timer = nextTimer();
      clock = timer.due;
      timers.delete(timer.id);
      timer.fn();
      steps++;
      afterStep();
      const next = nextTimer();
      if (!next || next.due !== clock) remember();
    }
  }

  function load(source, seed, levelIndex = 0, { rebuild = false } = {}) {
    if (!matchesSource(source)) throw new CompileError('this is not the preserved version of Pushing It');
    timers.clear();
    interrupted = null;
    clock = 0;
    // restart leaves the engine on its title screen, exactly where play.html injects the payload.
    ctx.compile(['restart'], source, String(seed));
    payload.runInContext(ctx);
    if (!Number.isInteger(levelIndex) || levelIndex < 0 || levelIndex >= ctx.grid.length) throw new CompileError('that is not a Pushing It level');
    ctx.nextLevel();
    if (levelIndex !== 0) {
      ctx.mylevel = levelIndex;
      ctx.undostack = [];
      ctx.loadmylevel();
      ctx.draw();
    }
    begin(false, rebuild ? REPLAY_BUDGET_SCALE : 1);
    try { afterStep(); drain(); } finally { end(); }
    return getMetadata();
  }

  function snapshot() {
    const finished = ps.titleScreen;
    return {
      kind: finished ? 'finished' : 'level', levelIndex: Math.min(ctx.mylevel, ctx.grid.length - 1),
      levelCount: ctx.grid.length, levelNumber: Math.min(ctx.mylevel + 1, ctx.grid.length), realLevelCount: ctx.grid.length,
      background: '#c1fbc6', textColor: '#a20021', message: null,
      animating: timers.size ? 'more' : null,
      width: 0, height: 0, cells: [], sprites: {}, viewport: { x: 0, y: 0, w: 0, h: 0 },
      ...(finished ? {} : { raster: raster() }),
    };
  }

  function doInput(action) {
    if (ps.titleScreen) return false;
    if (action === 'continue') {
      if (!timers.size) return false;
      drain();
      if (!timers.size) interrupted = null;
      return true;
    }
    if (action === 'undo' || action === 'restart') {
      const restore = timers.size && interrupted;
      timers.clear();
      ps.againing = false;
      ctx.mywinning = false;
      if (action === 'undo' && restore) {
        // A paused move has not necessarily added its undo entry yet.
        ctx.fromState(ctx.clone(restore.state));
        ctx.undostack.length = restore.stackLength;
        ctx.draw();
      } else if (action === 'undo') ctx.DoUndo();
      else ctx.DoRestart();
    } else {
      if (!(action in DIRS) || timers.size || ps.againing) return false;
      interrupted = { state: ctx.getstate(), stackLength: ctx.undostack.length };
      ctx.processInput(DIRS[action]);
    }
    afterStep();
    remember();
    drain();
    if (!timers.size) interrupted = null;
    return true;
  }

  function input(action, { capture = false } = {}) {
    begin(capture);
    try { return doInput(action); } finally { end(); }
  }

  function run(actions, { capture = false } = {}) {
    begin(capture);
    let made = 0;
    const start = ctx.mylevel;
    try {
      for (const action of actions) {
        clock += MOVE_MS;
        if (!doInput(action)) break;
        made++;
        if (ps.titleScreen || ctx.mylevel !== start || timers.size) break;
      }
      return made;
    } finally { end(); }
  }

  function sprite(name) {
    const colors = [];
    const dat = ctx.mysprites[name].split('|').map((row) => Array.from(row, (ch) => {
      if (ch === '.') return -1;
      const c = ctx.cols[ch];
      if (!colors.includes(c)) colors.push(c);
      return colors.indexOf(c);
    }));
    return { colors, dat };
  }

  return {
    load, snapshot, input, run,
    replay(actions) {
      for (const action of actions) {
        begin(false, REPLAY_BUDGET_SCALE);
        try { doInput(action); } finally { end(); }
      }
    },
    takeFrames() { const frames = lastFrames; lastFrames = null; return frames; },
    tick() { begin(false); try { drain(); } finally { end(); } },
    frameTiles() { return { wall: sprite('wmyall'), background: null, player: sprite('player') }; },
    levelText() { throw new EngineError('Pushing It uses custom geometry and cannot be edited as a PuzzleScript level'); },
    dispose() { timers.clear(); for (const c of canvases) { c.width = 1; c.height = 1; } lastFrames = null; },
    _ctx: ctx,
  };
}

module.exports = { createPushingItHost };
