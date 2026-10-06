'use strict';
const fs = require('node:fs');
const path = require('node:path');

function createRegistry({ dataDir, pool, getSource, maxLive = 30, now = Date.now }) {
  const gamesDir = path.join(dataDir, 'games');
  fs.mkdirSync(gamesDir, { recursive: true });
  const records = new Map();
  const live = [];            // gameIds, most recent last
  const queues = new Map();   // gameId -> Promise chain (never rejects)

  const fileFor = (id) => path.join(gamesDir, id + '.json');
  function persist(rec) {
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
      const victim = live.shift();
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
  }

  return {
    async start({ gameId, channelId, gistId, startLevel = 0 }) {
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
    },

    press(gameId, action) {
      return enqueue(gameId, async () => {
        const rec = records.get(gameId);
        if (!rec) throw Object.assign(new Error('unknown game'), { name: 'NoGameError' });
        if (rec.status !== 'playing') {
          const snapshot = await pool.snapshot(gameId).catch(() => ({ kind: rec.status === 'finished' ? 'finished' : 'dead' }));
          return { record: rec, snapshot, applied: false };
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

    prune(maxAgeMs) {
      let n = 0;
      for (const rec of [...records.values()]) {
        if (now() - rec.updatedAt > maxAgeMs) {
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
      while (queues.size) await Promise.all([...queues.values()]);
    },
  };
}

module.exports = { createRegistry };
