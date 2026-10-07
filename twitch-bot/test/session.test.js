'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createSession } = require('../session');

// A toy engine: a game is a list of screens. On a level, 'right' solves it; everything else is
// applied without effect (undo is refused when noundo). On a message only 'continue' works.
function fakePool() {
  const games = new Map(), calls = [];
  const snap = (g) => {
    const kind = g.index >= g.def.screens.length ? 'finished' : g.def.screens[g.index];
    return { kind, levelIndex: g.index, levelCount: g.def.screens.length, message: kind === 'message' ? 'm' + g.index : null, background: '#000000', textColor: '#ffffff' };
  };
  return {
    calls,
    async load(id, source, seed, level) {
      calls.push(['load', id, level]);
      const def = JSON.parse(source);
      if (def.compileError) throw Object.assign(new Error('bad'), { name: 'CompileError' });
      games.set(id, { def, index: level });
      return { title: def.title, author: 'someone', levelCount: def.screens.length, flags: { noaction: false, noundo: !!def.noundo, norestart: false, realtime: !!def.realtime } };
    },
    async snapshot(id) { return snap(games.get(id)); },
    async tiles() { return { wall: null, background: null, player: null }; },
    async input(id, action) {
      calls.push(['input', id, action]);
      const g = games.get(id);
      if (g.def.failOn === action) throw Object.assign(new Error('timeout'), { name: 'TimeoutError' });
      const kind = snap(g).kind;
      if (kind === 'message') { if (action !== 'continue') return false; g.index++; return true; }
      if (kind !== 'level') return false;
      if (action === 'undo' && g.def.noundo) return false;
      if (action === 'right') g.index++;
      return true;
    },
    async drop(id) { calls.push(['drop', id]); games.delete(id); },
  };
}

// Add a method name to `failing` and that method throws (as a failed JSON write would) until removed.
function fakeRotation(entries, saved = {}) {
  let pos = 0;
  const calls = [], failing = new Set();
  const guard = (name) => { if (failing.has(name)) throw new Error('disk full (' + name + ')'); };
  return {
    calls, saved, failing,
    current: () => entries[pos % entries.length],
    advance() { guard('advance'); pos++; return entries[pos % entries.length]; },
    savedLevel: (id) => saved[id] || 0,
    saveLevel(id, level) { guard('saveLevel'); saved[id] = level; calls.push(['save', id, level]); },
    clearLevel(id) { guard('clearLevel'); delete saved[id]; calls.push(['clear', id]); },
  };
}

// defs: { gistId: game definition }. Entries are played in the order given.
function setup(defs, saved) {
  const clock = { t: 1000000 };
  const pool = fakePool();
  const entries = Object.keys(defs).map((gistId) => ({ gistId, title: defs[gistId].title, author: 'someone' }));
  const rotation = fakeRotation(entries, saved);
  let changes = 0;
  const session = createSession({
    pool, rotation, now: () => clock.t, onChange: () => { changes++; }, log: () => {},
    getSource: async (id) => JSON.stringify(defs[id]),
  });
  const say = (user, text) => session.handleChat({ user, text });
  return { clock, pool, rotation, session, say, changes: () => changes };
}

const LEVELS3 = { title: 'Three', screens: ['level', 'level', 'level'] };

test('start loads the current game and shows it', async () => {
  const h = setup({ g1: LEVELS3 });
  assert.equal(h.session.view().phase, 'loading');
  assert.equal(h.session.view().snapshot.message, 'back soon');
  await h.session.start();
  const v = h.session.view();
  assert.equal(v.phase, 'playing');
  assert.equal(v.entry.gistId, 'g1');
  assert.equal(v.meta.title, 'Three');
  assert.equal(v.snapshot.kind, 'level');
  assert.deepEqual(v.tiles, { wall: null, background: null, player: null });
  assert.deepEqual(v.moves, []);
  assert.ok(h.changes() >= 1);
});

test('commands apply in arrival order and are logged newest first', async () => {
  const h = setup({ g1: LEVELS3 });
  await h.session.start();
  h.say('pip', 'up');
  h.say('mo', 'L');
  h.say('pip', 'x');
  await h.session.idle();
  assert.deepEqual(h.pool.calls.filter((c) => c[0] === 'input').map((c) => c[2]), ['up', 'left', 'action']);
  assert.deepEqual(h.session.view().moves, [{ action: 'action', user: 'pip' }, { action: 'left', user: 'mo' }, { action: 'up', user: 'pip' }]);
});

test('ordinary chat does nothing', async () => {
  const h = setup({ g1: LEVELS3 });
  await h.session.start();
  h.say('pip', 'lol right?');
  await h.session.idle();
  assert.deepEqual(h.session.view().moves, []);
});

test('a command the game refuses is not logged', async () => {
  const h = setup({ g1: { title: 'NoUndo', screens: ['level'], noundo: true } });
  await h.session.start();
  h.say('pip', 'undo');
  await h.session.idle();
  assert.deepEqual(h.session.view().moves, []);
});

test('the log keeps only the last 12 moves', async () => {
  const h = setup({ g1: LEVELS3 });
  await h.session.start();
  for (let i = 0; i < 15; i++) h.say('u' + i, 'up');
  await h.session.idle();
  const moves = h.session.view().moves;
  assert.equal(moves.length, 12);
  assert.equal(moves[0].user, 'u14');
});

test('at most 30 commands wait', async () => {
  const h = setup({ g1: LEVELS3 });
  await h.session.start();
  for (let i = 0; i < 40; i++) h.say('pip', 'up');
  await h.session.idle();
  assert.equal(h.pool.calls.filter((c) => c[0] === 'input').length, 30);
});

test('only go gets past a message, and it works straight away', async () => {
  const h = setup({ g1: { title: 'Msg', screens: ['message', 'level'] } });
  await h.session.start();
  assert.equal(h.session.view().snapshot.kind, 'message');
  for (const text of ['u', 'a', 'undo', 'restart']) h.say('pip', text);
  await h.session.idle();
  assert.equal(h.session.view().snapshot.kind, 'message');
  assert.deepEqual(h.session.view().moves, []);
  assert.equal(h.pool.calls.filter((c) => c[0] === 'input').length, 0, 'nothing but go reaches the game during a message');
  h.say('mo', 'go');
  await h.session.idle();
  assert.equal(h.session.view().snapshot.kind, 'level');
  assert.deepEqual(h.session.view().moves, [{ action: 'continue', user: 'mo' }]);
});

test('go does nothing on a level', async () => {
  const h = setup({ g1: LEVELS3 });
  await h.session.start();
  h.say('pip', 'go');
  await h.session.idle();
  assert.deepEqual(h.session.view().moves, []);
  assert.equal(h.pool.calls.filter((c) => c[0] === 'input').length, 0);
  assert.equal(h.session.view().snapshot.levelIndex, 0);
});

test('queued commands are dropped when the level changes', async () => {
  const h = setup({ g1: LEVELS3 });
  await h.session.start();
  h.say('pip', 'right');
  h.say('mo', 'up');
  h.say('mo', 'up');
  await h.session.idle();
  assert.equal(h.session.view().snapshot.levelIndex, 1);
  assert.deepEqual(h.session.view().moves, [{ action: 'right', user: 'pip' }]);
});

test('the level reached is saved as it advances', async () => {
  const h = setup({ g1: LEVELS3 });
  await h.session.start();
  h.say('pip', 'right');
  await h.session.idle();
  h.say('pip', 'right');
  await h.session.idle();
  assert.deepEqual(h.rotation.calls, [['save', 'g1', 1], ['save', 'g1', 2]]);
});

test('a game resumes at its saved level', async () => {
  const h = setup({ g1: LEVELS3 }, { g1: 2 });
  await h.session.start();
  assert.equal(h.session.view().snapshot.levelIndex, 2);
  assert.deepEqual(h.pool.calls[0].slice(0, 3), ['load', 'tw1', 2]);
});

test('a saved level past the end starts the game over', async () => {
  const h = setup({ g1: { title: 'Short', screens: ['level', 'level'] } }, { g1: 5 });
  await h.session.start();
  assert.equal(h.session.view().phase, 'playing');
  assert.equal(h.session.view().snapshot.levelIndex, 0);
  assert.deepEqual(h.rotation.calls, [['clear', 'g1']]);
});

test('winning shows the finished screen for 10 seconds, then the next game', async () => {
  const h = setup({ g1: { title: 'One', screens: ['level'] }, g2: LEVELS3 });
  await h.session.start();
  h.say('pip', 'right');
  await h.session.idle();
  assert.equal(h.session.view().phase, 'finished');
  assert.equal(h.session.view().snapshot.kind, 'finished');
  assert.deepEqual(h.rotation.calls, [['clear', 'g1']]);
  h.say('pip', 'up');
  h.clock.t += 9999;
  h.session.tick();
  await h.session.idle();
  assert.equal(h.session.view().entry.gistId, 'g1');
  h.clock.t += 1;
  h.session.tick();
  h.session.tick();
  await h.session.idle();
  assert.equal(h.session.view().entry.gistId, 'g2');
  assert.equal(h.session.view().phase, 'playing');
  assert.deepEqual(h.session.view().moves, []);
  assert.ok(h.pool.calls.some((c) => c[0] === 'drop' && c[1] === 'tw1'));
});

test('15 minutes without a move brings the next game', async () => {
  const h = setup({ g1: LEVELS3, g2: LEVELS3 });
  await h.session.start();
  h.clock.t += 14 * 60000;
  h.say('pip', 'up');
  await h.session.idle();
  h.clock.t += 14 * 60000;
  h.session.tick();
  await h.session.idle();
  assert.equal(h.session.view().entry.gistId, 'g1');
  h.clock.t += 60000;
  h.session.tick();
  await h.session.idle();
  assert.equal(h.session.view().entry.gistId, 'g2');
});

test('one skip vote is enough when nobody has been playing', async () => {
  const h = setup({ g1: LEVELS3, g2: LEVELS3 });
  await h.session.start();
  assert.deepEqual(h.session.view().votes, { count: 0, needed: 1 });
  h.say('pip', '!skip');
  await h.session.idle();
  assert.equal(h.session.view().entry.gistId, 'g2');
  assert.deepEqual(h.session.view().votes, { count: 0, needed: 1 });
});

test('skip needs half the recent players, at most 3, and counts each voter once', async () => {
  const h = setup({ g1: LEVELS3, g2: LEVELS3 });
  await h.session.start();
  for (const u of ['a', 'b', 'c', 'd']) h.say(u, 'up');
  await h.session.idle();
  assert.equal(h.session.view().votes.needed, 2);
  h.say('a', '!skip');
  h.say('a', '!skip');
  await h.session.idle();
  assert.equal(h.session.view().entry.gistId, 'g1');
  assert.deepEqual(h.session.view().votes, { count: 1, needed: 2 });
  for (const u of ['e', 'f', 'g']) h.say(u, 'up');
  await h.session.idle();
  assert.equal(h.session.view().votes.needed, 3);
  h.say('b', '!skip');
  await h.session.idle();
  assert.equal(h.session.view().entry.gistId, 'g1');
  h.say('zed', '!skip');
  await h.session.idle();
  assert.equal(h.session.view().entry.gistId, 'g2');
});

test('players stop counting as recent after 10 minutes', async () => {
  const h = setup({ g1: LEVELS3, g2: LEVELS3 });
  await h.session.start();
  for (const u of ['a', 'b', 'c', 'd', 'e', 'f']) h.say(u, 'up');
  await h.session.idle();
  assert.equal(h.session.view().votes.needed, 3);
  h.clock.t += 10 * 60000 + 1;
  h.say('a', 'up');
  await h.session.idle();
  assert.equal(h.session.view().votes.needed, 1);
});

test('realtime games and games that do not compile are skipped', async () => {
  const h = setup({ g1: { title: 'RT', screens: ['level'], realtime: true }, g2: { title: 'Bad', screens: [], compileError: true }, g3: LEVELS3 });
  await h.session.start();
  assert.equal(h.session.view().entry.gistId, 'g3');
  assert.ok(h.pool.calls.some((c) => c[0] === 'drop' && c[1] === 'tw1'));
});

test('a game with nothing to play is skipped', async () => {
  const h = setup({ g1: { title: 'Empty', screens: [] }, g2: LEVELS3 });
  await h.session.start();
  assert.equal(h.session.view().entry.gistId, 'g2');
});

test('after 10 skips in a row it waits a minute showing back soon, then carries on', async () => {
  const defs = {};
  for (let i = 0; i < 10; i++) defs['bad' + i] = { title: 'Bad', screens: [], compileError: true };
  defs.good = LEVELS3;
  const h = setup(defs);
  await h.session.start();
  let v = h.session.view();
  assert.equal(v.phase, 'waiting');
  assert.equal(v.snapshot.message, 'back soon');
  assert.equal(v.entry, null);
  assert.equal(h.pool.calls.filter((c) => c[0] === 'load').length, 10);
  h.say('pip', 'up');
  h.clock.t += 59999;
  h.session.tick();
  await h.session.idle();
  assert.equal(h.session.view().phase, 'waiting');
  h.clock.t += 1;
  h.session.tick();
  await h.session.idle();
  v = h.session.view();
  assert.equal(v.phase, 'playing');
  assert.equal(v.entry.gistId, 'good');
});

test('a game that fails mid-play is dropped for the next one', async () => {
  const h = setup({ g1: { title: 'Hangs', screens: ['level'], failOn: 'action' }, g2: LEVELS3 });
  await h.session.start();
  h.say('pip', 'a');
  await h.session.idle();
  assert.equal(h.session.view().entry.gistId, 'g2');
  assert.equal(h.session.view().phase, 'playing');
});

test('if the game order cannot be advanced it shows back soon, then retries a minute later', async () => {
  const h = setup({ g1: LEVELS3, g2: LEVELS3 });
  await h.session.start();
  h.rotation.failing.add('advance');
  h.say('pip', '!skip');
  await h.session.idle();
  const v = h.session.view();
  assert.equal(v.phase, 'waiting');
  assert.equal(v.snapshot.message, 'back soon');
  assert.equal(v.entry, null);
  h.clock.t += 59999;
  h.session.tick();
  await h.session.idle();
  assert.equal(h.session.view().phase, 'waiting');
  h.rotation.failing.delete('advance');
  h.clock.t += 1;
  h.session.tick();
  await h.session.idle();
  assert.equal(h.session.view().phase, 'playing');
  assert.equal(h.session.view().snapshot.kind, 'level');
});

test('a failed progress save does not abandon the game', async () => {
  const h = setup({ g1: LEVELS3, g2: LEVELS3 });
  await h.session.start();
  h.rotation.failing.add('saveLevel');
  h.say('pip', 'right');
  await h.session.idle();
  const v = h.session.view();
  assert.equal(v.phase, 'playing');
  assert.equal(v.entry.gistId, 'g1');
  assert.equal(v.snapshot.levelIndex, 1);
  assert.deepEqual(v.moves, [{ action: 'right', user: 'pip' }]);
  assert.equal(h.pool.calls.filter((c) => c[0] === 'drop').length, 0);
});

test('a failed progress clear on a win still shows the finished screen for 10 seconds', async () => {
  const h = setup({ g1: { title: 'One', screens: ['level'] }, g2: LEVELS3 });
  await h.session.start();
  h.rotation.failing.add('clearLevel');
  const before = h.changes();
  h.say('pip', 'right');
  await h.session.idle();
  assert.equal(h.session.view().phase, 'finished');
  assert.equal(h.session.view().snapshot.kind, 'finished');
  assert.ok(h.changes() > before);
  h.clock.t += 9999;
  h.session.tick();
  await h.session.idle();
  assert.equal(h.session.view().entry.gistId, 'g1');
  assert.equal(h.session.view().phase, 'finished');
  h.clock.t += 1;
  h.session.tick();
  await h.session.idle();
  assert.equal(h.session.view().entry.gistId, 'g2');
  assert.equal(h.session.view().phase, 'playing');
});

test('a failed progress clear while loading still starts the game over', async () => {
  const h = setup({ g1: { title: 'Short', screens: ['level', 'level'] } }, { g1: 5 });
  h.rotation.failing.add('clearLevel');
  await h.session.start();
  assert.equal(h.session.view().phase, 'playing');
  assert.equal(h.session.view().entry.gistId, 'g1');
  assert.equal(h.session.view().snapshot.levelIndex, 0);
});
