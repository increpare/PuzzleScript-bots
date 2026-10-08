'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { createOps } = require('../worker-ops');

const SLIDE = fs.readFileSync(path.join(__dirname, 'fixtures', 'again-slide.txt'), 'utf8');

test('loading a game to rebuild it gets the longer budget, and loading a new one does not', () => {
  // the puck starts sliding as the level opens, and each turn costs 3 ms of a 10 ms budget
  const src = SLIDE.replace('author test', 'author test\nrun_rules_on_level_start').replace('K = Puck', 'K = Sliding');
  let t = 0;
  const handle = createOps({ totalMs: 10, now: () => (t += 3) });
  assert.throws(() => handle({ op: 'load', gameId: 'new', args: { source: src, seed: 'seed', levelIndex: 0 } }), (e) => e.name === 'MoveTooLongError');
  const meta = handle({ op: 'load', gameId: 'old', args: { source: src, seed: 'seed', levelIndex: 0, rebuild: true } });
  assert.equal(meta.title, 'again slide');
  assert.equal(handle({ op: 'snapshot', gameId: 'old', args: {} }).kind, 'level');
});

test('a move still gets its picture when the animation cannot be made', () => {
  const logged = [];
  const handle = createOps({ animate: () => { throw new Error('no animation today'); }, log: (...a) => logged.push(a.join(' ')) });
  handle({ op: 'load', gameId: 's', args: { source: SLIDE, seed: 'seed', levelIndex: 0 } });
  const r = handle({ op: 'play', gameId: 's', args: { action: 'right', animate: true } });
  assert.deepEqual([r.applied, r.snapshot.kind, r.gif], [true, 'level', null]);
  assert.equal(logged.length, 1);
  assert.match(logged[0], /no animation today/);
});

test('a move that is refused part-way takes its game with it', () => {
  let t = 0, budget = Infinity;
  const handle = createOps({ totalMs: 10, now: () => (budget === Infinity ? 0 : (t += 6)) });
  handle({ op: 'load', gameId: 's', args: { source: SLIDE, seed: 'seed', levelIndex: 0 } });
  budget = 10;
  assert.throws(() => handle({ op: 'play', gameId: 's', args: { action: 'right' } }), (e) => e.name === 'MoveTooLongError');
  assert.throws(() => handle({ op: 'snapshot', gameId: 's', args: {} }), (e) => e.name === 'NoGameError');
});

// x position of the first cell holding an object with the given colour
function findX(s, colour) {
  const id = Object.keys(s.sprites).map(Number).find((k) => s.sprites[k].colors[0] === colour);
  const i = s.cells.findIndex((ids) => ids.includes(id));
  return i === -1 ? -1 : (i / s.height) | 0;
}

test('run makes typed moves as one press: how many were made, the picture they leave and one animation of them all', () => {
  const handle = createOps();
  handle({ op: 'load', gameId: 's', args: { source: SLIDE, seed: 'seed', levelIndex: 0 } });
  // the first step sends the puck off, and the player follows it two squares
  const r = handle({ op: 'run', gameId: 's', args: { actions: ['right', 'right', 'right'], animate: true } });
  assert.equal(r.made, 3);
  assert.equal(findX(r.snapshot, '#be2633'), 3, 'the player, in red, has walked from 1 to 3');
  assert.equal(Buffer.from(r.gif).toString('latin1', 0, 6), 'GIF89a');
  const quiet = handle({ op: 'run', gameId: 's', args: { actions: ['right'] } });
  assert.deepEqual([quiet.made, quiet.gif], [1, null], 'no animation unless it is asked for');
});

test('a run that makes nothing has no animation', () => {
  const handle = createOps();
  const source = fs.readFileSync(path.join(__dirname, 'fixtures', 'message-game.txt'), 'utf8');
  handle({ op: 'load', gameId: 'm', args: { source, seed: 'seed', levelIndex: 0 } });
  // the game opens on a message, where no move is taken
  const r = handle({ op: 'run', gameId: 'm', args: { actions: ['right', 'right'], animate: true } });
  assert.deepEqual([r.made, r.snapshot.kind, r.gif], [0, 'message', null]);
});

test('a sound is made from its seed, and belongs to no game', () => {
  const handle = createOps();
  const r = handle({ op: 'sound', gameId: null, args: { seed: 9675111 } });
  assert.equal(Buffer.from(r.wav).toString('latin1', 0, 4), 'RIFF');
  assert.ok(r.seconds > 0.05 && r.seconds < 1, 'a short laser: ' + r.seconds);
});

test('sprites are read and drawn from their text, and belong to no game', () => {
  const handle = createOps();
  const drawn = handle({ op: 'sprites', gameId: null, args: { text: 'Player\nred\n\nWall\ngreen' } });
  assert.deepEqual([drawn.ok, drawn.names, drawn.notes], [true, ['Player', 'Wall'], []]);
  assert.equal(Buffer.from(drawn.png).toString('latin1', 1, 4), 'PNG');
  const refused = handle({ op: 'sprites', gameId: null, args: { text: 'Player\nblurple' } });
  assert.equal(refused.ok, false);
  assert.match(refused.problems[0], /blurple/);
});

test('a run that is refused part-way takes its game with it', () => {
  let t = 0, budget = Infinity;
  const handle = createOps({ totalMs: 10, now: () => (budget === Infinity ? 0 : (t += 6)) });
  handle({ op: 'load', gameId: 's', args: { source: SLIDE, seed: 'seed', levelIndex: 0 } });
  budget = 10;
  assert.throws(() => handle({ op: 'run', gameId: 's', args: { actions: ['left', 'left', 'left'] } }), (e) => e.name === 'MoveTooLongError');
  assert.throws(() => handle({ op: 'snapshot', gameId: 's', args: {} }), (e) => e.name === 'NoGameError');
});
