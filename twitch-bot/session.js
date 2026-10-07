'use strict';
const { parseCommand } = require('./commands');

const MAX_QUEUE = 30, LOG_SIZE = 12;
const MESSAGE_HOLD_MS = 4000, FINISHED_HOLD_MS = 10000, IDLE_MS = 15 * 60 * 1000;
const ACTIVE_MS = 10 * 60 * 1000, MAX_SKIPS = 10, RETRY_MS = 60000;
const DISMISSERS = ['up', 'down', 'left', 'right', 'action'];
const BACK_SOON = { kind: 'message', message: 'back soon', levelIndex: 0, levelCount: 0, background: '#000000', textColor: '#ffffff' };

const skip = (why) => Object.assign(new Error(why), { name: 'SkipError' });

// The game on screen and everything chat does to it. All engine work goes through one
// promise chain, so commands are applied strictly in the order they arrived.
function createSession({ pool, getSource, rotation, now = Date.now, onChange = () => {}, log = console.log }) {
  let phase = 'loading';
  let counter = 0, gameId = null, entry = null, meta = null, snapshot = BACK_SOON, tiles = null;
  let queue = [], moves = [], votes = new Set();
  const activity = new Map(); // login -> when their last command was applied
  let lastApplied = 0, messageSince = 0, finishedAt = 0, retryAt = 0;
  let chain = Promise.resolve(), pumping = false, switching = false;

  function run(fn) {
    chain = chain.then(fn).catch((e) => log('session error', e));
    return chain;
  }

  // Remembering progress is a convenience: a failed write (disk full, permissions) is logged and
  // the game carries on rather than being abandoned.
  function persist(what, fn) {
    try { fn(); } catch (err) { log('could not ' + what + ': ' + (err && err.message)); }
  }

  async function loadGame(e) {
    const source = await getSource(e.gistId);
    const id = 'tw' + (++counter);
    try {
      let level = rotation.savedLevel(e.gistId);
      let m = await pool.load(id, source, id, level);
      if (m.flags.realtime) throw skip('realtime game');
      let snap = await pool.snapshot(id);
      if (level > 0 && snap.kind === 'finished') {
        // the saved level is past the end (the game was edited): start over
        persist('clear the saved level', () => rotation.clearLevel(e.gistId));
        m = await pool.load(id, source, id, 0);
        snap = await pool.snapshot(id);
      }
      if (snap.kind === 'finished') throw skip('nothing to play');
      return { id, meta: m, snapshot: snap, tiles: await pool.tiles(id) };
    } catch (err) {
      await pool.drop(id).catch(() => {});
      throw err;
    }
  }

  // Always ends in 'playing' or 'waiting', never stuck in 'loading': tick() retries from 'waiting'.
  async function switchGame(advance) {
    phase = 'loading';
    queue = [];
    votes = new Set();
    const old = gameId;
    gameId = null;
    try {
      if (old) await pool.drop(old).catch(() => {});
      let e = advance ? rotation.advance() : rotation.current();
      for (let skips = 0; skips < MAX_SKIPS; skips++) {
        try {
          const g = await loadGame(e);
          gameId = g.id; entry = e; meta = g.meta; snapshot = g.snapshot; tiles = g.tiles;
          moves = [];
          lastApplied = now();
          messageSince = now();
          phase = 'playing';
          onChange();
          return;
        } catch (err) {
          log('skipping ' + e.title + ': ' + (err && err.name) + ' ' + (err && err.message));
          e = rotation.advance();
        }
      }
    } catch (err) {
      // the game order itself could not be read or saved
      log('could not choose the next game: ' + (err && err.name) + ' ' + (err && err.message));
    }
    // nothing loads (GitHub is probably unreachable): show a holding screen and try again later
    entry = null; meta = null; snapshot = BACK_SOON; tiles = null; moves = [];
    retryAt = now() + RETRY_MS;
    phase = 'waiting';
    onChange();
  }

  function requestSwitch(advance) {
    if (switching) return;
    switching = true;
    run(async () => {
      try { await switchGame(advance); } finally { switching = false; }
    });
  }

  function needed() {
    const cutoff = now() - ACTIVE_MS;
    let active = 0;
    for (const at of activity.values()) if (at >= cutoff) active++;
    return Math.max(1, Math.min(3, Math.ceil(active / 2)));
  }

  async function applyOne(item) {
    let action = item.action;
    if (snapshot.kind === 'message') {
      if (now() - messageSince < MESSAGE_HOLD_MS || !DISMISSERS.includes(action)) return;
      action = 'continue';
    }
    if (!(await pool.input(gameId, action))) return;
    const prev = snapshot;
    snapshot = await pool.snapshot(gameId);
    lastApplied = now();
    activity.set(item.user, now());
    moves.unshift({ action, user: item.user });
    if (moves.length > LOG_SIZE) moves.length = LOG_SIZE;
    if (snapshot.kind === 'finished') {
      phase = 'finished';
      finishedAt = now();
      queue = [];
      persist('clear the saved level', () => rotation.clearLevel(entry.gistId));
    } else {
      const newMessage = snapshot.kind === 'message' && (prev.kind !== 'message' || snapshot.levelIndex !== prev.levelIndex);
      if (newMessage) messageSince = now();
      // moves typed at the old screen must not spill into the new one
      if (newMessage || snapshot.levelIndex !== prev.levelIndex) queue = [];
      if (snapshot.levelIndex > prev.levelIndex) persist('save the level reached', () => rotation.saveLevel(entry.gistId, snapshot.levelIndex));
    }
    onChange();
  }

  function pump() {
    if (pumping) return;
    pumping = true;
    run(async () => {
      try {
        while (queue.length && phase === 'playing') {
          const item = queue.shift();
          try {
            await applyOne(item);
          } catch (err) {
            log('game failed: ' + (entry && entry.title) + ': ' + (err && err.name) + ' ' + (err && err.message));
            await switchGame(true);
          }
        }
      } finally { pumping = false; }
    });
  }

  return {
    start: () => run(() => switchGame(false)),
    handleChat({ user, text }) {
      const cmd = parseCommand(text);
      if (!cmd || phase !== 'playing') return;
      if (cmd.type === 'skip') {
        votes.add(user);
        if (votes.size >= needed()) requestSwitch(true); else onChange();
        return;
      }
      if (queue.length >= MAX_QUEUE) return;
      queue.push({ user, action: cmd.action });
      pump();
    },
    tick() {
      const t = now();
      for (const [user, at] of activity) if (t - at > ACTIVE_MS) activity.delete(user);
      if (phase === 'finished' && t - finishedAt >= FINISHED_HOLD_MS) requestSwitch(true);
      else if (phase === 'playing' && t - lastApplied >= IDLE_MS) requestSwitch(true);
      else if (phase === 'waiting' && t >= retryAt) requestSwitch(false);
    },
    view: () => ({ phase, entry, meta, snapshot, tiles, moves: moves.slice(), votes: { count: votes.size, needed: needed() } }),
    idle: () => chain,
  };
}

module.exports = { createSession };
