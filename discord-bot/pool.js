'use strict';
const path = require('node:path');
const { Worker } = require('node:worker_threads');

function createPool({ size = 2, compileMs = 10000, inputMs = 3000, onEvicted = () => {} } = {}) {
  // entry: {worker, queue: item[], inflight: item|null, games: Set}
  // item:  {id, gameId, op, args, deadlineMs, resolve, reject, timer}
  const evictionListeners = [onEvicted];
  const workers = [];
  const gameToWorker = new Map();
  let nextId = 1;
  let rr = 0;
  let closed = false;

  function spawn() {
    const entry = { worker: new Worker(path.join(__dirname, 'worker.js'), { resourceLimits: { maxOldGenerationSizeMb: 512 } }), queue: [], inflight: null, games: new Set() };
    entry.worker.on('message', (msg) => {
      const item = entry.inflight;
      if (!item || item.id !== msg.id) return;
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

  function pump(entry) {
    if (entry.inflight !== null || entry.queue.length === 0 || workers.indexOf(entry) === -1) return;
    const item = entry.queue.shift();
    entry.inflight = item;
    item.timer = setTimeout(() => {
      entry.inflight = null;
      entry.games.delete(item.gameId);
      if (gameToWorker.get(item.gameId) === entry) gameToWorker.delete(item.gameId);
      // reject the culprit first, then evict bystanders
      item.reject(Object.assign(new Error('timeout'), { name: 'TimeoutError' }));
      kill(entry, Object.assign(new Error('worker evicted'), { name: 'EvictedError' }));
    }, item.deadlineMs);
    entry.worker.postMessage({ id: item.id, op: item.op, gameId: item.gameId, args: item.args });
  }

  function call(entry, gameId, op, args, deadlineMs) {
    return new Promise((resolve, reject) => {
      entry.queue.push({ id: nextId++, gameId, op, args, deadlineMs, resolve, reject, timer: null });
      pump(entry);
    });
  }

  function entryFor(gameId) {
    const e = gameToWorker.get(gameId);
    if (!e) throw Object.assign(new Error('no such game'), { name: 'NoGameError' });
    return e;
  }

  return {
    async load(gameId, source, seed, levelIndex) {
      if (closed) throw Object.assign(new Error('pool closed'), { name: 'PoolClosedError' });
      let entry = gameToWorker.get(gameId);
      if (!entry) { entry = workers[rr++ % workers.length]; }
      gameToWorker.set(gameId, entry);
      entry.games.add(gameId);
      try {
        return await call(entry, gameId, 'load', { source, seed, levelIndex }, compileMs);
      } catch (e) {
        if (gameToWorker.get(gameId) === entry) { entry.games.delete(gameId); gameToWorker.delete(gameId); }
        throw e;
      }
    },
    apply(gameId, actions) {
      return call(entryFor(gameId), gameId, 'apply', { actions }, inputMs * Math.max(1, actions.length));
    },
    input(gameId, action) { return call(entryFor(gameId), gameId, 'input', { action }, inputMs); },
    snapshot(gameId) { return call(entryFor(gameId), gameId, 'snapshot', {}, inputMs); },
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
