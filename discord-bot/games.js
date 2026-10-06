'use strict';
const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

function createRegistry({ dataDir, pool, getSource, maxLive = 30, now = Date.now, maxRecordBytes = 1_000_000, maxSourceBytes = 100_000_000 }) {
  const gamesDir = path.join(dataDir, 'games');
  fs.mkdirSync(gamesDir, { recursive: true });
  // Game sources are stored once per distinct source (by hash), apart from the small per-game records,
  // so a game keeps working after its gist is edited and each store has its own size cap.
  const sourcesDir = path.join(dataDir, 'sources');
  fs.mkdirSync(sourcesDir, { recursive: true });
  const sourceFile = (hash) => path.join(sourcesDir, hash + '.txt');
  const recordSizes = new Map(); // gameId -> bytes on disk
  let recordBytes = 0;

  function enforceSourceCap(keepHash) {
    const files = [];
    let total = 0;
    for (const f of fs.readdirSync(sourcesDir)) {
      if (!f.endsWith('.txt')) continue;
      try {
        const st = fs.statSync(path.join(sourcesDir, f));
        files.push({ f, size: st.size, mtime: st.mtimeMs });
        total += st.size;
      } catch (e) { /* raced with a delete */ }
    }
    files.sort((a, b) => a.mtime - b.mtime); // least recently used first
    for (const x of files) {
      if (total <= maxSourceBytes) break;
      if (x.f === keepHash + '.txt') continue;
      try { fs.unlinkSync(path.join(sourcesDir, x.f)); total -= x.size; } catch (e) { /* already gone */ }
    }
  }
  function saveSource(hash, source) {
    if (!fs.existsSync(sourceFile(hash))) {
      const tmp = sourceFile(hash) + '.tmp';
      fs.writeFileSync(tmp, source);
      fs.renameSync(tmp, sourceFile(hash));
      enforceSourceCap(hash);
    }
  }
  function loadSource(hash) {
    try {
      const source = fs.readFileSync(sourceFile(hash), 'utf8');
      const t = new Date(now());
      try { fs.utimesSync(sourceFile(hash), t, t); } catch (e) { /* recency is best effort */ }
      return source;
    } catch (e) { return null; }
  }
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
    const json = JSON.stringify(rec);
    fs.writeFileSync(tmp, json);
    fs.renameSync(tmp, fileFor(rec.gameId));
    const size = Buffer.byteLength(json);
    recordBytes += size - (recordSizes.get(rec.gameId) || 0);
    recordSizes.set(rec.gameId, size);
    enforceRecordCap(rec.gameId);
  }

  function removeRecord(gameId) {
    records.delete(gameId);
    recordBytes -= recordSizes.get(gameId) || 0;
    recordSizes.delete(gameId);
    forgetLive(gameId);
    try { fs.unlinkSync(fileFor(gameId)); } catch (e) { /* already gone */ }
    pool.drop(gameId).catch(() => {});
  }

  // Over the cap: drop finished and stopped games first, then the least recently played ones.
  function enforceRecordCap(keepId) {
    if (recordBytes <= maxRecordBytes) return;
    const candidates = [...records.values()]
      .filter((r) => r.gameId !== keepId && !busy.has(r.gameId))
      .sort((a, b) => ((a.status === 'playing') - (b.status === 'playing')) || (a.updatedAt - b.updatedAt));
    for (const r of candidates) {
      if (recordBytes <= maxRecordBytes) break;
      removeRecord(r.gameId);
    }
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
    // Prefer the stored copy of the source the game started with; only if it has been evicted
    // do we go back to the gist, and then it must still be the same source.
    let source = rec.sourceHash ? loadSource(rec.sourceHash) : null;
    if (source === null) {
      source = await getSource(rec.gistId);
      if (rec.sourceHash && rec.sourceHash !== sha256(source)) {
        const err = Object.assign(new Error('the game source changed'), { name: 'EngineError' });
        markDead(rec, err);
        throw err;
      }
      if (rec.sourceHash) saveSource(rec.sourceHash, source);
    }
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
      const rec = { gameId, channelId, gistId, seed: gameId, sourceHash: sha256(source), startLevel, inputs: [], status: 'playing', meta: null, createdAt: now(), updatedAt: now() };
      rec.meta = await pool.load(gameId, source, rec.seed, startLevel);
      saveSource(rec.sourceHash, source);
      records.set(gameId, rec);
      touchLive(gameId);
      await enforceLiveLimit();
      const snapshot = await pool.snapshot(gameId);
      rec.cur = { kind: snapshot.kind, levelIndex: snapshot.levelIndex };
      if (snapshot.kind === 'finished') rec.status = 'finished';
      persist(rec);
      return { record: rec, snapshot };
      } finally { unmarkBusy(gameId); }
    },

    press(gameId, action, by) {
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
          if (applied) { rec.inputs.push(action); if (by) rec.lastMover = String(by).slice(0, 80); }
          const snapshot = await pool.snapshot(gameId);
          // A level is solved when a move (not continue/undo/restart) takes play from a level to a later one.
          const prev = rec.cur;
          const isMove = applied && !['continue', 'undo', 'restart'].includes(action);
          const advanced = snapshot.kind === 'finished' || snapshot.levelIndex > (prev ? prev.levelIndex : Infinity);
          const solvedLevel = isMove && prev && prev.kind === 'level' && advanced ? prev.levelIndex : null;
          rec.cur = { kind: snapshot.kind, levelIndex: snapshot.levelIndex };
          if (snapshot.kind === 'finished') rec.status = 'finished';
          if (applied || snapshot.kind === 'finished') persist(rec);
          return { record: rec, snapshot, applied, solvedLevel };
        } catch (e) {
          // EvictedError (bystander of another game's timeout) and other transient failures: not dead
          if (e.name === 'TimeoutError' || e.name === 'EngineError' || e.name === 'CompileError' || e.name === 'ResourceError') markDead(rec, e);
          else if (!['EvictedError', 'PoolClosedError', 'RegistryClosedError', 'NoGameError', 'GistError'].includes(e.name)) {
            // unknown failure: the host may have diverged from the input log; rebuild on next press
            await pool.drop(gameId).catch(() => {});
            forgetLive(gameId);
          }
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
          const size = fs.statSync(path.join(gamesDir, f)).size;
          recordSizes.set(rec.gameId, size);
          recordBytes += size;
          n++;
        } catch (e) { /* skip corrupt file */ }
      }
      return n;
    },

    markDead(gameId, reason) {
      const rec = records.get(gameId);
      if (rec) markDead(rec, reason);
    },

    storage: () => ({ recordBytes, records: records.size }),

    async close() {
      closed = true;
      while (queues.size) await Promise.all([...queues.values()]);
    },
  };
}

module.exports = { createRegistry };
