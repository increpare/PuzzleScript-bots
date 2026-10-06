'use strict';
const fs = require('node:fs');
const path = require('node:path');

function createRegistry({ dataDir, pool, getSource, maxLive = 30, now = Date.now }) {
  const gamesDir = path.join(dataDir, 'games');
  fs.mkdirSync(gamesDir, { recursive: true });
  const records = new Map();
  const live = [];            // gameIds, most recent last
  const queues = new Map();   // gameId -> Promise chain (never rejects)
  const busy = new Map();     // gameId -> in-flight operation count (never evicted/pruned while > 0)
  let closed = false;
  const closedError = () => Object.assign(new Error('registry closed'), { name: 'RegistryClosedError' });
  const markBusy = (id) => busy.set(id, (busy.get(id) || 0) + 1);
  const unmarkBusy = (id) => { const n = (busy.get(id) || 1) - 1; if (n > 0) busy.set(id, n); else busy.delete(id); };

  function syntheticSnapshot(rec) {
    const levelCount = rec.meta ? rec.meta.levelCount : 0;
    if (rec.status === 'finished') {
      return { kind: 'finished', levelIndex: rec.meta ? rec.meta.levelCount - 1 : 0, levelCount, background: '#000000', textColor: '#ffffff', message: null };
    }
    return { kind: 'message', message: 'game stopped: ' + (rec.deadReason || 'error'), levelIndex: 0, levelCount, background: '#000000', textColor: '#ffffff' };
  }

  const fileFor = (id) => path.join(gamesDir, id + '.json');
  function persist(rec) {
    if (records.get(rec.gameId) !== rec) return; // pruned while in flight: do not resurrect
    rec.updatedAt = now();
    const tmp = fileFor(rec.gameId) + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(rec));
    fs.renameSync(tmp, fileFor(rec.gameId));
  }

  function touchLive(gameId) {
    const i = live.indexOf(gameId);
    if (i !== -1) live.splice(i, 1);
    live.push(gameId);
  }
  function forgetLive(gameId) {
    const i = live.indexOf(gameId);
    if (i !== -1) live.splice(i, 1);
  }
  async function enforceLiveLimit() {
    while (live.length > maxLive) {
      const i = live.findIndex((id) => !busy.has(id));
      if (i === -1) return; // everything is mid-operation; try again later
      const [victim] = live.splice(i, 1);
      await pool.drop(victim);
    }
  }
  if (typeof pool.onEvicted === 'function') pool.onEvicted((ids) => ids.forEach(forgetLive));

  async function ensureLive(rec) {
    if (pool.has(rec.gameId)) { touchLive(rec.gameId); return; }
    const source = await getSource(rec.gistId);
    try {
      await pool.load(rec.gameId, source, rec.seed, rec.startLevel);
      if (rec.inputs.length) await pool.apply(rec.gameId, rec.inputs);
    } catch (e) {
      // never leave a half-replayed game registered in the pool
      await pool.drop(rec.gameId).catch(() => {});
      throw e;
    }
    touchLive(rec.gameId);
    await enforceLiveLimit();
  }

  function enqueue(gameId, fn) {
    const prev = queues.get(gameId) || Promise.resolve();
    const next = prev.then(fn);
    const tail = next.catch(() => {});
    queues.set(gameId, tail);
    tail.then(() => { if (queues.get(gameId) === tail) queues.delete(gameId); });
    return next;
  }

  function markDead(rec, err) {
    rec.status = 'dead';
    rec.deadReason = String((err && err.message) || err);
    forgetLive(rec.gameId);
    persist(rec);
    pool.drop(rec.gameId).catch(() => {});
  }

  return {
    async start({ gameId, channelId, gistId, startLevel = 0 }) {
      if (closed) throw closedError();
      markBusy(gameId);
      try {
      const source = await getSource(gistId);
      const rec = { gameId, channelId, gistId, seed: gameId, startLevel, inputs: [], status: 'playing', meta: null, createdAt: now(), updatedAt: now() };
      rec.meta = await pool.load(gameId, source, rec.seed, startLevel);
      records.set(gameId, rec);
      touchLive(gameId);
      await enforceLiveLimit();
      const snapshot = await pool.snapshot(gameId);
      if (snapshot.kind === 'finished') rec.status = 'finished';
      persist(rec);
      return { record: rec, snapshot };
      } finally { unmarkBusy(gameId); }
    },

    press(gameId, action) {
      if (closed) return Promise.reject(closedError());
      markBusy(gameId);
      return enqueue(gameId, async () => {
       try {
        const rec = records.get(gameId);
        if (!rec) throw Object.assign(new Error('unknown game'), { name: 'NoGameError' });
        if (rec.status !== 'playing') {
          return { record: rec, snapshot: syntheticSnapshot(rec), applied: false };
        }
        try {
          await ensureLive(rec);
          const applied = await pool.input(gameId, action);
          if (applied) rec.inputs.push(action);
          const snapshot = await pool.snapshot(gameId);
          if (snapshot.kind === 'finished') rec.status = 'finished';
          if (applied || snapshot.kind === 'finished') persist(rec);
          return { record: rec, snapshot, applied };
        } catch (e) {
          // EvictedError (bystander of another game's timeout) and other transient failures: not dead
          if (e.name === 'TimeoutError' || e.name === 'EngineError' || e.name === 'CompileError') markDead(rec, e);
          throw e;
        }
       } finally { unmarkBusy(gameId); }
      });
    },

    get: (gameId) => records.get(gameId),

    loadAll() {
      let n = 0;
      for (const f of fs.readdirSync(gamesDir)) {
        if (!f.endsWith('.json')) continue;
        try {
          const rec = JSON.parse(fs.readFileSync(path.join(gamesDir, f), 'utf8'));
          if (!rec || typeof rec.gameId !== 'string' || !Array.isArray(rec.inputs)) continue;
          records.set(rec.gameId, rec);
          n++;
        } catch (e) { /* skip corrupt file */ }
      }
      return n;
    },

    markDead(gameId, reason) {
      const rec = records.get(gameId);
      if (rec) markDead(rec, reason);
    },

    prune(maxAgeMs) {
      let n = 0;
      for (const rec of [...records.values()]) {
        if (!busy.has(rec.gameId) && now() - rec.updatedAt > maxAgeMs) {
          records.delete(rec.gameId);
          forgetLive(rec.gameId);
          try { fs.unlinkSync(fileFor(rec.gameId)); } catch (e) { /* already gone */ }
          pool.drop(rec.gameId).catch(() => {});
          n++;
        }
      }
      return n;
    },

    async close() {
      closed = true;
      while (queues.size) await Promise.all([...queues.values()]);
    },
  };
}

module.exports = { createRegistry };
