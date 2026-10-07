'use strict';
const { parentPort, workerData } = require('node:worker_threads');
const { createHost } = require('./engine-host');
const { buildAnimation } = require('./animation');

const hosts = new Map();

// While a job runs, tell the pool that it is still getting somewhere, at most this often.
// The pool only stops a worker that has gone quiet for longer than its per-step limit.
const PING_MS = 100;
let currentId = null;
let lastPing = 0;
function ping() {
  const t = Date.now();
  if (currentId === null || t - lastPing < PING_MS) return;
  lastPing = t;
  parentPort.postMessage({ id: currentId, progress: true });
}

const totalMs = workerData && typeof workerData.totalMs === 'number' ? workerData.totalMs : Infinity;
const newHost = () => createHost({ totalMs, onStep: ping });

function need(gameId) {
  const host = hosts.get(gameId);
  if (!host) throw Object.assign(new Error('no such game'), { name: 'NoGameError' });
  return host;
}

function spin(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) { /* busy wait, test only */ }
}

function handle(msg) {
  const { op, gameId, args } = msg;
  switch (op) {
    case 'load': {
      const host = hosts.get(gameId) || newHost();
      const meta = host.load(args.source, args.seed, args.levelIndex);
      hosts.set(gameId, host);
      return meta;
    }
    case 'apply': {
      need(gameId).replay(args.actions);
      return null;
    }
    case 'input': {
      return need(gameId).input(args.action);
    }
    // One move, the picture it leaves, and (when asked) an animation of the turns it took.
    case 'play': {
      const host = need(gameId);
      let applied;
      try {
        applied = host.input(args.action, { capture: !!args.animate });
      } catch (e) {
        // the game is part-way through a move: it cannot be used again, only rebuilt
        host.dispose();
        hosts.delete(gameId);
        throw e;
      }
      const snapshot = host.snapshot();
      const frames = host.takeFrames();
      const gif = applied && frames ? buildAnimation({ base: snapshot, frames, onProgress: ping }) : null;
      return { applied, snapshot, gif };
    }
    case 'snapshot': {
      return need(gameId).snapshot();
    }
    case 'tiles': {
      return need(gameId).frameTiles();
    }
    case 'drop': {
      const host = hosts.get(gameId);
      if (host) host.dispose();
      hosts.delete(gameId);
      return null;
    }
    case '__spin': {
      spin(args.ms);
      return null;
    }
    case '__steps': { // test only: work that keeps reporting progress
      for (let i = 0; i < args.count; i++) { spin(args.ms); ping(); }
      return null;
    }
    default:
      throw new Error('unknown op ' + op);
  }
}

parentPort.on('message', (msg) => {
  currentId = msg.id;
  lastPing = Date.now();
  try {
    const result = handle(msg);
    parentPort.postMessage({ id: msg.id, ok: true, result });
  } catch (e) {
    parentPort.postMessage({ id: msg.id, ok: false, error: { name: e && e.name || 'Error', message: String(e && e.message || e) } });
  } finally {
    currentId = null;
  }
});
