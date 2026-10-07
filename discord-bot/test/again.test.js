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

test('replaying the input log gets three times the budget of a live move', () => {
  let t = 0;
  const host = createHost({ totalMs: 10, now: () => (t += 3) });
  host.load(SLIDE, 'seed', 0);
  assert.throws(() => host.input('right'), MoveTooLongError);
  host.dispose();
  const again = createHost({ totalMs: 10, now: () => (t += 3) });
  again.load(SLIDE, 'seed', 0);
  again.replay(['right']);
  assert.equal(findX(again.snapshot(), '#b2dcef'), 7);
  again.dispose();
});

// A corridor long enough for hundreds of again turns, with enough objects declared before the
// sliding one that it gets id 31: the top bit of a word in the engine's level array.
function longSlide(length) {
  const fillers = Array.from({ length: 30 }, (_, i) => 'F' + String.fromCharCode(97 + (i % 26)) + (i >= 26 ? 'x' : ''));
  return ['title long slide', 'author test', '', '========', 'OBJECTS', '========', '', 'Background', 'black', '',
    fillers.map((f) => f + '\ngreen\n').join('\n'),
    'Sliding', 'lightblue', '', 'Player', 'red', '', 'Wall', 'grey', '', 'Puck', 'blue', '',
    '=======', 'LEGEND', '=======', '', '. = Background', '# = Wall', 'P = Player', 'K = Puck', '',
    '=======', 'SOUNDS', '=======', '', '================', 'COLLISIONLAYERS', '================', '',
    'Background', fillers.join(', '), 'Sliding, Player, Wall, Puck', '',
    '======', 'RULES', '======', '', '[ > Player | Puck ] -> [ Player | Sliding ]', '[ Sliding ] -> [ right Sliding ] again', '',
    '==============', 'WINCONDITIONS', '==============', '', '=======', 'LEVELS', '=======', '',
    '#'.repeat(length + 4), '#PK' + '.'.repeat(length) + '#', '#'.repeat(length + 4), ''].join('\n');
}

test('a long chain that ends by itself is never mistaken for a loop', () => {
  const src = longSlide(950);
  // these seeds made a weaker state hash report a repeat part-way along the corridor
  for (const seed of ['seed4', 'seed9', 'seed14', 'seed19']) {
    const host = createHost();
    host.load(src, seed, 0);
    assert.equal(host._ps.state.objects.sliding.id, 31);
    host.input('right');
    const s = host.snapshot();
    assert.strictEqual(s.animating, null, seed);
    assert.equal(findX(s, '#b2dcef'), 952, seed + ': the puck reached the far wall');
    host.dispose();
  }
});

test('a loop reached through a lead-in is reported as a loop, but its frames are not one that can simply be repeated', () => {
  const host = createHost();
  host.load(FIXTURE('again-fuse.txt'), 'seed', 0);
  host.input('right', { capture: true });
  assert.equal(host.snapshot().animating, 'loop');
  const frames = host.takeFrames();
  assert.equal(frames.list.length, 5, 'two fuse states, then one pass round three explosion states');
  assert.equal(frames.loop, false, 'repeating these frames would replay the fuse');
  host.dispose();
});

test('the frames of a chain that was only paused are not marked as a loop', () => {
  const host = createHost({ stepCap: 2 });
  host.load(SLIDE, 'seed', 0);
  host.input('right', { capture: true });
  assert.equal(host.snapshot().animating, 'more');
  assert.equal(host.takeFrames().loop, false);
  host.dispose();
});

test('playing live with frames captured and replaying the log leave the engine in the same state', () => {
  const rng = (host) => { const r = host._ps.RandomGen._state; return [r.i, r.j, r.s.join(',')]; };
  for (const [src, moves] of [[LOOP, ['right', 'right', 'left', 'undo', 'right', 'right']], [SLIDE, ['right', 'left', 'undo', 'right']], [FIXTURE('again-fuse.txt'), ['right', 'undo', 'right']]]) {
    const live = createHost();
    live.load(src, 'seed', 0);
    const applied = [];
    for (const m of moves) if (live.input(m, { capture: true })) applied.push(m);
    const replayed = createHost();
    replayed.load(src, 'seed', 0);
    replayed.replay(applied);
    assert.equal(replayed.levelString(), live.levelString());
    assert.equal(replayed.snapshot().animating, live.snapshot().animating);
    assert.deepEqual(rng(replayed), rng(live));
    live.dispose(); replayed.dispose();
  }
});

test('a message raised by the move that starts a loop is shown first; continue then reveals the loop', () => {
  const host = createHost();
  host.load(LOOP.replace('[ Player | Boom1 ] again', '[ Player | Boom1 ] again message boom'), 'seed', 0);
  host.input('right'); host.input('right');
  let s = host.snapshot();
  assert.deepEqual([s.kind, s.message, s.animating], ['message', 'boom', 'loop']);
  assert.equal(host.input('continue'), true);
  s = host.snapshot();
  assert.deepEqual([s.kind, s.animating], ['level', 'loop']);
  host.dispose();
});

test('rebuilding a game gives the chain at the start of a level the longer budget too', () => {
  const src = SLIDE.replace('author test', 'author test\nrun_rules_on_level_start').replace('K = Puck', 'K = Sliding');
  let t = 0;
  const live = createHost({ totalMs: 10, now: () => (t += 3) });
  assert.throws(() => live.load(src, 'seed', 0), MoveTooLongError);
  live.dispose();
  const rebuilt = createHost({ totalMs: 10, now: () => (t += 3) });
  rebuilt.load(src, 'seed', 0, { rebuild: true });
  assert.equal(findX(rebuilt.snapshot(), '#b2dcef'), 7);
  rebuilt.dispose();
});
