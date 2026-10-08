'use strict';
const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');
const { createSourceStore } = require('./sources');
const { splice } = require('./levels');

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

// How many presses in a row may be refused for taking too long before the game is stopped.
const MAX_REFUSALS = 3;

// levels: the store of sent levels (see levels.js), needed only for games that run on one.
function createRegistry({ dataDir, pool, getSource, maxLive = 30, now = Date.now, maxRecordBytes = 1_000_000, maxSourceBytes = 99_000_000, sources = createSourceStore({ dataDir, maxBytes: maxSourceBytes, now }), levels = null }) {
  const gamesDir = path.join(dataDir, 'games');
  fs.mkdirSync(gamesDir, { recursive: true });
  const recordSizes = new Map(); // gameId -> bytes on disk
  let recordBytes = 0;

  const records = new Map();
  const live = [];            // gameIds, most recent last
  const queues = new Map();   // gameId -> Promise chain (never rejects)
  const busy = new Map();     // gameId -> in-flight operation count (never evicted/pruned while > 0)
  const refusals = new Map(); // gameId -> presses in a row that took too long
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
    refusals.delete(gameId);
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

  const engineError = (message) => Object.assign(new Error(message), { name: 'EngineError' });

  // The source of a game on a sent level: the game the level was made for, with that one level in
  // place of its own. The game is the copy the level was made against, or the gist as it is now.
  async function levelSource(level) {
    let base = sources.load(level.baseSourceHash);
    if (base === null) base = await getSource(level.gistId);
    return splice(base, level.text);
  }

  async function ensureLive(rec) {
    if (pool.has(rec.gameId)) { touchLive(rec.gameId); return; }
    // Prefer the stored copy of the source the game started with; only if it has been evicted
    // do we go back to the gist, and then it must still be the same source.
    let source = rec.sourceHash ? sources.load(rec.sourceHash) : null;
    if (source === null && rec.levelId) {
      const level = levels ? levels.get(rec.levelId) : null;
      if (!level) throw engineError('this level is no longer available');
      // The game may have changed since the level was sent. The level is then played on the game
      // as it is now, if it still fits.
      source = await levelSource(level);
      rec.sourceHash = sha256(source);
      sources.save(source);
    } else if (source === null) {
      source = await getSource(rec.gistId);
      if (rec.sourceHash && rec.sourceHash !== sha256(source)) {
        const err = Object.assign(new Error('the game source changed'), { name: 'EngineError' });
        markDead(rec, err);
        throw err;
      }
      if (rec.sourceHash) sources.save(source);
    }
    try {
      await pool.load(rec.gameId, source, rec.seed, rec.startLevel, { rebuild: true });
      if (rec.inputs.length) await pool.apply(rec.gameId, rec.inputs);
    } catch (e) {
      // never leave a half-replayed game registered in the pool
      await pool.drop(rec.gameId).catch(() => {});
      if (rec.levelId && e.name === 'CompileError') throw engineError('this level no longer works with the current version of the game');
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
    refusals.delete(rec.gameId);
    forgetLive(rec.gameId);
    persist(rec);
    pool.drop(rec.gameId).catch(() => {});
  }

  // A press, or a line of typed moves, on a game. make() has the pool make them and says which were
  // made: { made: [the actions], snapshot, gif }. by: the display name of whoever it was.
  function play(gameId, by, make) {
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
        const { made, snapshot, gif } = await make();
        const applied = made.length > 0;
        if (applied) { rec.inputs.push(...made); refusals.delete(gameId); if (by) rec.lastMover = String(by).slice(0, 80); }
        // A level is solved when a move (not continue/undo/restart) takes play from a level to a later one.
        const prev = rec.cur;
        // (Typed moves stop where play leaves the level, so the last of them is the one that did it.)
        const isMove = applied && !['continue', 'undo', 'restart'].includes(made[made.length - 1]);
        const advanced = snapshot.kind === 'finished' || snapshot.levelIndex > (prev ? prev.levelIndex : Infinity);
        const solvedLevel = isMove && prev && prev.kind === 'level' && advanced ? prev.levelIndex : null;
        rec.cur = { kind: snapshot.kind, levelIndex: snapshot.levelIndex };
        if (snapshot.kind === 'finished') rec.status = 'finished';
        if (applied || snapshot.kind === 'finished') persist(rec);
        return { record: rec, snapshot, applied, made: made.length, solvedLevel, gif: gif || null };
      } catch (e) {
        if (e.name === 'EngineError' || e.name === 'CompileError' || e.name === 'ResourceError') markDead(rec, e);
        // EvictedError (bystander of another game's timeout) and other transient failures leave the game as it is
        else if (!['EvictedError', 'PoolClosedError', 'RegistryClosedError', 'GistError'].includes(e.name)) {
          // A move that took too long (MoveTooLongError, or TimeoutError when the worker had to be
          // stopped) is refused, not fatal: it was never added to the input log. Like any unknown
          // failure it may have left the live game part-way through a move, so that copy is thrown
          // away and the next press rebuilds the game from the log.
          await pool.drop(gameId).catch(() => {});
          forgetLive(gameId);
          // The pool or its worker no longer had the game. The record is fine, and pressing again rebuilds it.
          if (e.name === 'NoGameError') throw Object.assign(new Error('the game has to be rebuilt'), { name: 'EvictedError' });
          if (e.name === 'MoveTooLongError' || e.name === 'TimeoutError') {
            // Each refusal costs a worker seconds of work, and a TimeoutError costs every game on that
            // worker a rebuild, so a game that does nothing else is stopped.
            const n = (refusals.get(gameId) || 0) + 1;
            refusals.set(gameId, n);
            if (n >= MAX_REFUSALS) {
              const fatal = Object.assign(new Error('its moves kept taking too long'), { name: 'EngineError' });
              markDead(rec, fatal);
              throw fatal;
            }
          }
        }
        throw e;
      }
     } finally { unmarkBusy(gameId); }
    });
  }

  return {
    // startLevelNumber counts real levels from 1, skipping message screens.
    // level: a sent level (a record from the level store). The game is then that one level.
    async start({ gameId, channelId, gistId, startLevelNumber = 1, level = null }) {
      if (closed) throw closedError();
      markBusy(gameId);
      try {
      if (level) gistId = level.gistId;
      const source = level ? await levelSource(level) : await getSource(gistId);
      const rec = { gameId, channelId, gistId, seed: gameId, sourceHash: sha256(source), startLevel: 0, inputs: [], status: 'playing', meta: null, createdAt: now(), updatedAt: now() };
      if (level) rec.levelId = level.id;
      rec.meta = await pool.load(gameId, source, rec.seed, 0);
      if (!level && startLevelNumber > 1) {
        const real = rec.meta.realLevels || [];
        if (startLevelNumber > real.length) {
          await pool.drop(gameId).catch(() => {});
          throw Object.assign(new Error('that game only has ' + real.length + (real.length === 1 ? ' level' : ' levels')), { name: 'LevelRangeError' });
        }
        rec.startLevel = real[startLevelNumber - 1];
        rec.meta = await pool.load(gameId, source, rec.seed, rec.startLevel);
      }
      sources.save(source);
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
      return play(gameId, by, async () => {
        const { applied, snapshot, gif } = await pool.play(gameId, action, { animate: true });
        return { made: applied ? [action] : [], snapshot, gif };
      });
    },

    // Typed moves, made as one press. The game takes them in turn until it refuses one or play
    // leaves the level, and only those it took are recorded. made: how many that was.
    run(gameId, actions, by) {
      return play(gameId, by, async () => {
        const { made, snapshot, gif } = await pool.run(gameId, actions, { animate: true });
        return { made: actions.slice(0, made), snapshot, gif };
      });
    },

    // Starts a finished game on a sent level afresh, in the same record, so in the same message.
    // Any other game is left as it is.
    again(gameId) {
      if (closed) return Promise.reject(closedError());
      markBusy(gameId);
      return enqueue(gameId, async () => {
        try {
          const rec = records.get(gameId);
          if (!rec) throw Object.assign(new Error('unknown game'), { name: 'NoGameError' });
          if (!rec.levelId || rec.status !== 'finished') {
            if (rec.status !== 'playing') return { record: rec, snapshot: syntheticSnapshot(rec), applied: false };
            await ensureLive(rec);
            return { record: rec, snapshot: await pool.snapshot(gameId), applied: false };
          }
          await pool.drop(gameId).catch(() => {});
          forgetLive(gameId);
          rec.inputs = [];
          rec.status = 'playing';
          delete rec.lastMover;
          try {
            await ensureLive(rec);
          } catch (e) {
            if (e.name === 'EngineError' || e.name === 'CompileError' || e.name === 'ResourceError') markDead(rec, e);
            else rec.status = 'finished'; // a passing failure: it is still there to be played again
            throw e;
          }
          const snapshot = await pool.snapshot(gameId);
          rec.cur = { kind: snapshot.kind, levelIndex: snapshot.levelIndex };
          persist(rec);
          return { record: rec, snapshot, applied: true };
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
