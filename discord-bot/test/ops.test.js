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
