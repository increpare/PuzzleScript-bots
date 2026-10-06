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
