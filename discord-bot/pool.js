'use strict';
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { REPLAY_BUDGET_SCALE } = require('./engine-host');

// compileMs: how long a game may take to compile.
// inputMs:   how long a worker may go without finishing a turn of the engine. A job that keeps making
//            progress is not stopped by this limit; one stuck inside a single turn is.
// totalMs:   how long one move's whole chain of again turns may take. The game checks this itself
//            between turns and refuses the move, which leaves the worker and its other games alone.
// Rebuilding a game from its input log gets each of these three times over: everything in the log
// was within the limits when it was played, and a busy moment must not make a game impossible to resume.
function createPool({ size = 2, compileMs = 10000, inputMs = 3000, totalMs = 20000, onEvicted = () => {}, workerFile = path.join(__dirname, 'worker.js') } = {}) {
  // entry: {worker, queue: item[], inflight: item|null, games: Set}
  // item:  {id, gameId, op, args, deadlineMs, resolve, reject, timer}
  const evictionListeners = [onEvicted];
  const workers = [];
  const gameToWorker = new Map();
  let nextId = 1;
  let rr = 0;
  let closed = false;

  function spawn() {
    const entry = { worker: new Worker(workerFile, { workerData: { totalMs, progress: true }, resourceLimits: { maxOldGenerationSizeMb: 512 } }), queue: [], inflight: null, games: new Set() };
    entry.worker.on('message', (msg) => {
      const item = entry.inflight;
      if (!item || item.id !== msg.id) return;
      if (msg.progress) { arm(entry, item); return; } // still working: start the wait again
      clearTimeout(item.timer);
      entry.inflight = null;
      if (msg.ok) item.resolve(msg.result);
      else item.reject(Object.assign(new Error(msg.error.message), { name: msg.error.name }));
      pump(entry);
    });
    entry.worker.on('error', (err) => {
      const item = entry.inflight;
      if (item) {
        clearTimeout(item.timer);
        entry.inflight = null;
        entry.games.delete(item.gameId);
        if (gameToWorker.get(item.gameId) === entry) gameToWorker.delete(item.gameId);
        item.reject(Object.assign(new Error('worker crashed: ' + (err && err.message || err)), { name: 'ResourceError' }));
      }
      kill(entry, Object.assign(new Error('worker evicted'), { name: 'EvictedError' }));
    });
    entry.worker.on('exit', () => { if (!closed) kill(entry, new Error('worker exited')); });
    return entry;
  }

  // Reject everything pending on an entry (inflight first, then queued).
  function rejectAll(entry, reason) {
    const items = entry.inflight ? [entry.inflight, ...entry.queue] : entry.queue.slice();
    if (entry.inflight) clearTimeout(entry.inflight.timer);
    entry.inflight = null;
    entry.queue = [];
    for (const it of items) it.reject(reason);
  }

  function kill(entry, reason) {
    const idx = workers.indexOf(entry);
    if (idx === -1) return;
    workers.splice(idx, 1);
    rejectAll(entry, reason);
    const evicted = [];
    for (const g of entry.games) {
      if (gameToWorker.get(g) === entry) gameToWorker.delete(g);
      evicted.push(g);
    }
    entry.games.clear();
    entry.worker.terminate().catch(() => {});
    if (!closed) {
      workers.push(spawn());
      if (evicted.length) {
        for (const fn of evictionListeners) {
          try { fn(evicted); } catch (e) { /* listener errors must not break the pool */ }
        }
      }
    }
  }

  for (let i = 0; i < size; i++) workers.push(spawn());

  // Start (or restart) the wait for the job in flight. If the worker stays silent for the whole
  // wait it is stuck, and the only way to stop it is to end the worker.
  function arm(entry, item) {
    clearTimeout(item.timer);
    item.timer = setTimeout(() => {
      entry.inflight = null;
      entry.games.delete(item.gameId);
      if (gameToWorker.get(item.gameId) === entry) gameToWorker.delete(item.gameId);
      // reject the culprit first, then evict bystanders
      item.reject(Object.assign(new Error('timeout'), { name: 'TimeoutError' }));
      kill(entry, Object.assign(new Error('worker evicted'), { name: 'EvictedError' }));
    }, item.deadlineMs);
  }

  function pump(entry) {
    if (entry.inflight !== null || entry.queue.length === 0 || workers.indexOf(entry) === -1) return;
    const item = entry.queue.shift();
    entry.inflight = item;
    arm(entry, item);
    entry.worker.postMessage({ id: item.id, op: item.op, gameId: item.gameId, args: item.args });
  }

  function call(entry, gameId, op, args, deadlineMs) {
    return new Promise((resolve, reject) => {
      entry.queue.push({ id: nextId++, gameId, op, args, deadlineMs, resolve, reject, timer: null });
      pump(entry);
    });
  }

  // Work that belongs to no game goes to the workers in turn.
  function anyWorker(op, args) {
    if (closed) return Promise.reject(Object.assign(new Error('pool closed'), { name: 'PoolClosedError' }));
    return call(workers[rr++ % workers.length], null, op, args, inputMs);
  }

  function entryFor(gameId) {
    const e = gameToWorker.get(gameId);
    if (!e) throw Object.assign(new Error('no such game'), { name: 'NoGameError' });
    return e;
  }

  return {
    // rebuild: the game is being brought back from its input log (see above)
    async load(gameId, source, seed, levelIndex, { rebuild = false } = {}) {
      if (closed) throw Object.assign(new Error('pool closed'), { name: 'PoolClosedError' });
      let entry = gameToWorker.get(gameId);
      if (!entry) { entry = workers[rr++ % workers.length]; }
      gameToWorker.set(gameId, entry);
      entry.games.add(gameId);
      try {
        return await call(entry, gameId, 'load', { source, seed, levelIndex, rebuild }, rebuild ? compileMs * REPLAY_BUDGET_SCALE : compileMs);
      } catch (e) {
        if (gameToWorker.get(gameId) === entry) { entry.games.delete(gameId); gameToWorker.delete(gameId); }
        throw e;
      }
    },
    // replays inputs from the log, so it is only ever part of a rebuild
    apply(gameId, actions) { return call(entryFor(gameId), gameId, 'apply', { actions }, inputMs * REPLAY_BUDGET_SCALE); },
    input(gameId, action) { return call(entryFor(gameId), gameId, 'input', { action }, inputMs); },
    // {applied, snapshot, gif}: one move, the picture it leaves, and with animate an animation of its
    // again turns (null when the move took a single turn or the animation could not be made)
    play(gameId, action, { animate = false } = {}) { return call(entryFor(gameId), gameId, 'play', { action, animate }, inputMs); },
    // {made, snapshot, gif}: typed moves made as one press. made is how many of them the game took.
    run(gameId, actions, { animate = false } = {}) { return call(entryFor(gameId), gameId, 'run', { actions, animate }, inputMs); },
    // {wav, seconds}: the sound of a seed, as the editor plays it (see sfx.js)
    sound(seed) { return anyWorker('sound', { seed }); },
    // {ok, names, notes, png} or {ok: false, problems}: object definitions drawn as a picture (see sprites.js)
    sprites(text) { return anyWorker('sprites', { text }); },
    snapshot(gameId) { return call(entryFor(gameId), gameId, 'snapshot', {}, inputMs); },
    tiles(gameId) { return call(entryFor(gameId), gameId, 'tiles', {}, inputMs); },
    // A level as the text a LEVELS section would hold: with levelIndex, that level as written;
    // without, the level being played as it stands.
    levelText(gameId, { levelIndex } = {}) { return call(entryFor(gameId), gameId, 'levelText', { levelIndex }, inputMs); },
    onEvicted(fn) { evictionListeners.push(fn); },
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
      const dying = workers.splice(0);
      for (const e of dying) rejectAll(e, Object.assign(new Error('pool closed'), { name: 'PoolClosedError' }));
      await Promise.all(dying.map((e) => e.worker.terminate()));
    },
    _call(gameId, op, args, deadlineMs) { return call(entryFor(gameId), gameId, op, args, deadlineMs); },
  };
}

module.exports = { createPool };
