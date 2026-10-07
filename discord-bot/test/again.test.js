'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { createHost, MoveTooLongError } = require('../engine-host');

const FIXTURE = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');
const LOOP = FIXTURE('again-loop.txt');
const SLIDE = FIXTURE('again-slide.txt');

// x position of the first cell holding an object with the given colour
function findX(s, colour) {
  const id = Object.keys(s.sprites).map(Number).find((k) => s.sprites[k].colors[0] === colour);
  const i = s.cells.findIndex((ids) => ids.includes(id));
  return i === -1 ? -1 : (i / s.height) | 0;
}

test('a chain of again turns runs to its end', () => {
  const host = createHost();
  host.load(SLIDE, 'seed', 0);
  assert.equal(host.input('right'), true);
  const s = host.snapshot();
  assert.strictEqual(s.animating, null);
  assert.equal(s.cells[7 * s.height + 1].length, 2, 'the puck slid to the far wall');
  host.dispose();
});

test('an again loop that never ends is stopped when a state repeats, and reported as looping', () => {
  const host = createHost();
  host.load(LOOP, 'seed', 0);
  assert.equal(host.input('right'), true);
  assert.strictEqual(host.snapshot().animating, null, 'an ordinary move');
  assert.equal(host.input('right'), true, 'the move that sets the bomb off is made');
  const s = host.snapshot();
  assert.equal(s.kind, 'level');
  assert.equal(s.animating, 'loop');
  host.dispose();
});

test('moves are ignored while an animation is still running, as in the browser; undo ends it', () => {
  const host = createHost();
  host.load(LOOP, 'seed', 0);
  host.input('right'); host.input('right');
  const before = host.levelString();
  assert.equal(host.input('left'), false);
  assert.equal(host.input('action'), false);
  assert.equal(host.levelString(), before);
  assert.equal(host.input('undo'), true);
  assert.equal(host.snapshot().animating, null);
  assert.equal(host.input('left'), true, 'moves work again after undo');
  host.dispose();
});

test('restart also ends a looping animation', () => {
  const host = createHost();
  host.load(LOOP, 'seed', 0);
  const start = host.levelString();
  host.input('right'); host.input('right');
  assert.equal(host.input('restart'), true);
  assert.equal(host.snapshot().animating, null);
  assert.equal(host.levelString(), start);
  host.dispose();
});

test('replaying the same inputs reaches the same looping state', () => {
  const run = () => {
    const host = createHost();
    host.load(LOOP, 'seed', 0);
    host.replay(['right', 'right', 'left', 'undo', 'right', 'right']);
    const out = [host.levelString(), host.snapshot().animating];
    host.dispose();
    return out;
  };
  assert.deepEqual(run(), run());
  assert.equal(run()[1], 'loop');
});

test('a chain longer than the step cap pauses, and continue carries it on', () => {
  const host = createHost({ stepCap: 2 });
  host.load(SLIDE, 'seed', 0);
  assert.equal(host.input('right'), true);
  let s = host.snapshot();
  assert.equal(s.animating, 'more');
  assert.ok(findX(s, '#b2dcef') < 7, 'the puck has not arrived yet');
  assert.equal(host.input('left'), false, 'moves wait for the animation');
  let guard = 0;
  while (host.snapshot().animating === 'more' && guard++ < 10) assert.equal(host.input('continue'), true);
  s = host.snapshot();
  assert.equal(s.animating, null);
  assert.equal(findX(s, '#b2dcef'), 7);
  assert.equal(host.input('continue'), false, 'nothing left to continue');
  host.dispose();
});

test('continue does nothing on a loop', () => {
  const host = createHost();
  host.load(LOOP, 'seed', 0);
  host.input('right'); host.input('right');
  assert.equal(host.input('continue'), false);
  host.dispose();
});

test('a move whose chain outruns the time budget throws, and one within it does not', () => {
  let t = 0;
  const host = createHost({ totalMs: 10, now: () => (t += 3) });
  host.load(LOOP, 'seed', 0);
  assert.equal(host.input('right'), true, 'a single turn fits the budget');
  host.dispose();
  const slow = createHost({ totalMs: 10, now: () => (t += 3) });
  slow.load(SLIDE, 'seed', 0);
  assert.throws(() => slow.input('right'), (e) => e instanceof MoveTooLongError && e.name === 'MoveTooLongError');
  slow.dispose();
});

test('onStep is called once for every turn the engine runs', () => {
  let steps = 0;
  const host = createHost({ onStep: () => steps++ });
  host.load(SLIDE, 'seed', 0);
  steps = 0;
  host.input('right');
  assert.equal(steps, 5, 'the move and four again turns');
  host.dispose();
});

test('frames are captured for a chain: one per turn, ending on the final state', () => {
  const host = createHost();
  host.load(SLIDE, 'seed', 0);
  host.input('right', { capture: true });
  const frames = host.takeFrames();
  assert.equal(frames.loop, false);
  assert.equal(frames.intervalMs, 150, 'the engine default again interval');
  assert.equal(frames.list.length, 5);
  assert.ok(frames.list.every((f) => f.kind === 'level' && f.width === 9 && f.height === 3 && f.repeat === 1));
  assert.ok(frames.list[0].objects instanceof Int32Array);
  assert.notDeepEqual([...frames.list[0].objects], [...frames.list[1].objects]);
  assert.equal(host.takeFrames(), null, 'frames are handed over once');
  host.dispose();
});

test('a loop is captured as one pass around it', () => {
  const host = createHost();
  host.load(LOOP, 'seed', 0);
  host.input('right', { capture: true });
  assert.equal(host.takeFrames(), null, 'a single turn has nothing to animate');
  host.input('right', { capture: true });
  const frames = host.takeFrames();
  assert.equal(frames.loop, true);
  assert.equal(frames.list.length, 3, 'three distinct states before the first repeats');
  host.dispose();
});

test('frames are not captured unless asked for', () => {
  const host = createHost();
  host.load(SLIDE, 'seed', 0);
  host.input('right');
  assert.equal(host.takeFrames(), null);
  host.dispose();
});

test('the frame interval follows again_interval', () => {
  const host = createHost();
  host.load(SLIDE.replace('author test', 'author test\nagain_interval 0.05'), 'seed', 0);
  host.input('right', { capture: true });
  assert.equal(host.takeFrames().intervalMs, 50);
  host.dispose();
});

test('capturing stops, without affecting the move, when there are too many frames', () => {
  const host = createHost({ maxFrames: 3 });
  host.load(SLIDE, 'seed', 0);
  assert.equal(host.input('right', { capture: true }), true);
  assert.equal(host.takeFrames(), null);
  assert.equal(findX(host.snapshot(), '#b2dcef'), 7);
  host.dispose();
});

test('captured frames carry what is needed to draw them without the final snapshot', () => {
  const host = createHost();
  host.load(SLIDE, 'seed', 0);
  host.input('right', { capture: true });
  const frames = host.takeFrames();
  const snap = host.snapshot();
  assert.deepEqual(frames.sprites, snap.sprites);
  assert.equal(frames.background, snap.background);
  assert.equal(frames.textColor, snap.textColor);
  assert.equal(frames.stride, 1);
  assert.equal(frames.objectCount, Object.keys(snap.sprites).length);
  host.dispose();
});
