'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { createHost } = require('../engine-host');
const { SRC_DIR } = require('../engine-src');

const FIXTURE = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');
const SOKOBAN = fs.readFileSync(path.join(SRC_DIR, 'demo', 'sokoban_basic.txt'), 'utf8');
const SLIDE = FIXTURE('again-slide.txt');
const LOOP = FIXTURE('again-loop.txt');

// How long a frame stays on screen.
const shownMs = (frames, f) => frames.intervalMs * f.repeat;

test('a run of moves leaves the game where the same presses one at a time would', () => {
  const moves = ['up', 'up', 'left', 'undo', 'down', 'right'];
  const one = createHost(), all = createHost();
  one.load(SOKOBAN, 'seed', 0);
  all.load(SOKOBAN, 'seed', 0);
  const start = one.levelString();
  for (const m of moves) one.input(m);
  assert.equal(all.run(moves), 6);
  assert.equal(all.levelString(), one.levelString());
  assert.notEqual(all.levelString(), start, 'the moves did something');
});

test('a run stops where the level is won and plays nothing into the next one', () => {
  const host = createHost(), fresh = createHost();
  host.load(FIXTURE('two-level-random.txt'), 'seed', 0);
  fresh.load(FIXTURE('two-level-random.txt'), 'seed', 0);
  fresh.input('right');
  assert.equal(host.run(['right', 'left', 'left']), 1);
  assert.equal(host.snapshot().levelIndex, 1);
  assert.equal(host.levelString(), fresh.levelString(), 'the second level stands as it opened');
});

test('a run stops at a message', () => {
  const host = createHost();
  host.load(FIXTURE('message-game.txt'), 'seed', 1);
  assert.equal(host.run(['right', 'right', 'right']), 1);
  const s = host.snapshot();
  assert.deepEqual([s.kind, s.message], ['message', 'you pressed it']);
});

test('a run stops at a move the game does not take, and does not count it', () => {
  const host = createHost();
  host.load(SOKOBAN.replace('homepage www.puzzlescript.net', 'homepage www.puzzlescript.net\nnoaction'), 'seed', 0);
  assert.equal(host.run(['left', 'action', 'up']), 1);
});

test('a run is captured from where it starts, one frame a move, each shown as long as a held key repeats', () => {
  const host = createHost();
  host.load(SLIDE, 'seed', 0);
  host.input('right'); // the puck slides away, and the corridor is clear
  assert.equal(host.run(['right', 'right', 'right'], { capture: true }), 3);
  const frames = host.takeFrames();
  assert.equal(frames.list.length, 4, 'the start and three moves');
  assert.ok(frames.list.every((f) => shownMs(frames, f) >= 150), 'every frame can be read');
  assert.ok(frames.list.every((f) => shownMs(frames, f) < 300), 'and none dawdles');
  assert.equal(frames.loop, false);
});

test('a move that changes nothing still takes its time in the run', () => {
  const host = createHost();
  host.load(SLIDE, 'seed', 0);
  assert.equal(host.run(['up', 'up'], { capture: true }), 2, 'walking into the wall is still a move');
  assert.equal(host.takeFrames(), null, 'nothing moved, so there is nothing to animate');
  host.run(['up', 'right'], { capture: true });
  const frames = host.takeFrames();
  // the start and the bump into the wall are one picture, held for both
  assert.ok(shownMs(frames, frames.list[0]) >= 300);
});

test('the turns of an again chain inside a run go by at the game\'s own pace, and the settled board is held', () => {
  const host = createHost();
  host.load(SLIDE.replace('author test', 'author test\nagain_interval 0.05'), 'seed', 0);
  assert.equal(host.run(['right', 'right'], { capture: true }), 2);
  const frames = host.takeFrames();
  // the start, five turns of the slide (as a single press captures them), then the step after the puck
  assert.equal(frames.list.length, 7);
  assert.deepEqual(frames.list.slice(1, 5).map((f) => shownMs(frames, f)), [50, 50, 50, 50], 'the slide is not slowed down');
  assert.ok(shownMs(frames, frames.list[0]) >= 150, 'the start can be read');
  assert.ok(shownMs(frames, frames.list[5]) >= 150, 'where the slide ends is held before the next move');
});

test('a run that ends in a loop is not one that can simply be repeated', () => {
  const host = createHost();
  host.load(LOOP, 'seed', 0);
  // the second step right sets the bomb off, and it flickers for ever
  assert.equal(host.run(['right', 'right'], { capture: true }), 2);
  assert.equal(host.snapshot().animating, 'loop');
  assert.equal(host.takeFrames().loop, false, 'repeating the frames would replay the walk up to the bomb');
});

test('nothing is made of a run while an animation is still running', () => {
  const host = createHost();
  host.load(LOOP, 'seed', 0);
  host.input('right'); host.input('right');
  assert.equal(host.run(['left', 'left']), 0);
});

test('a run has one time budget for all its moves', () => {
  let t = 0;
  // every turn of the engine costs 3 ms of a 10 ms budget: two moves fit, four do not
  const host = createHost({ totalMs: 10, now: () => (t += 3) });
  host.load(SOKOBAN, 'seed', 0);
  assert.equal(host.run(['left', 'right']), 2);
  assert.throws(() => host.run(['left', 'right', 'left', 'right']), (e) => e.name === 'MoveTooLongError');
});
