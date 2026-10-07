'use strict';
const { parentPort, workerData } = require('node:worker_threads');
const { createOps } = require('./worker-ops');

// While a job runs, tell the pool that it is still getting somewhere, at most this often.
// The pool only stops a worker that has gone quiet for longer than its per-step limit.
const PING_MS = 100;
// Only a pool that asks for these gets them: one that does not know about them would take each for a result.
const wantsProgress = !!(workerData && workerData.progress);
let currentId = null;
let lastPing = 0;
function ping() {
  const t = Date.now();
  if (!wantsProgress || currentId === null || t - lastPing < PING_MS) return;
  lastPing = t;
  parentPort.postMessage({ id: currentId, progress: true });
}

const totalMs = workerData && typeof workerData.totalMs === 'number' ? workerData.totalMs : Infinity;
const handle = createOps({ totalMs, ping });

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
