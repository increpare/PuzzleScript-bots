'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { ChangeSet } = require('../vendor/codemirror-state.cjs');
const { createSignals } = require('../workshop-signals');

test('signals expose a bounded sender name, colour, position and remaining lifetime', () => {
  assert.equal(typeof createSignals, 'function');
  let time = 0;
  const signals = createSignals({ now: () => time, colorOf: () => '#123456' });
  signals.add({ uid: 'u1', name: 'Ada', pos: 3 });
  const [signal] = signals.list();
  assert.match(signal.id, /^[A-Za-z0-9_-]{16,}$/);
  assert.deepEqual({ ...signal, id: null }, { id: null, name: 'Ada', color: '#123456', pos: 3, remainingMs: 5000 });
  assert.equal('uid' in signal, false);
  time = 1250;
  assert.equal(signals.list()[0].remainingMs, 3750);
  time = 5000;
  assert.deepEqual(signals.list(), []);
});

test('one active signal per user, with a 500ms emission limit', () => {
  let time = 0;
  const signals = createSignals({ now: () => time });
  signals.add({ uid: 'u1', name: 'Ada', pos: 3 });
  const original = signals.list()[0].id;
  time = 499;
  assert.throws(() => signals.add({ uid: 'u1', name: 'Ada', pos: 4 }), (e) => e.name === 'WorkshopError' && e.status === 429);
  assert.equal(signals.list()[0].id, original);
  time = 500;
  signals.add({ uid: 'u1', name: 'Ada', pos: 4 });
  assert.equal(signals.list().length, 1);
  assert.notEqual(signals.list()[0].id, original);
  assert.equal(signals.list()[0].remainingMs, 5000);
});

test('invalid identity and position are refused; names are bounded', () => {
  const signals = createSignals({ now: () => 0 });
  for (const uid of ['', null, 42, 'x'.repeat(101)]) {
    assert.throws(() => signals.add({ uid, name: 'Ada', pos: 0 }), { name: 'WorkshopError' });
  }
  for (const name of [null, 42]) {
    assert.throws(() => signals.add({ uid: 'u1', name, pos: 0 }), { name: 'WorkshopError' });
  }
  for (const pos of [-1, 1.5, null, '0', Infinity]) {
    assert.throws(() => signals.add({ uid: 'u1', name: 'Ada', pos }), { name: 'WorkshopError' });
  }
  signals.add({ uid: 'u1', name: 'x'.repeat(200), pos: 0 });
  signals.add({ uid: 'u2', name: '', pos: 0 });
  assert.equal(signals.list()[0].name.length, 80);
  assert.equal(signals.list()[1].name, 'someone');
});

test('capacity permits replacing an existing user and reuses expired entries', () => {
  let time = 0;
  const signals = createSignals({ now: () => time, max: 2 });
  signals.add({ uid: 'u1', name: 'Ada', pos: 0 });
  signals.add({ uid: 'u2', name: 'Bob', pos: 1 });
  assert.throws(() => signals.add({ uid: 'u3', name: 'C', pos: 0 }), { name: 'WorkshopError' });
  time = 500;
  signals.add({ uid: 'u1', name: 'Ada', pos: 2 });
  assert.equal(signals.list().length, 2);
  time = 5000;
  signals.add({ uid: 'u3', name: 'C', pos: 0 });
  assert.deepEqual(signals.list().map((s) => s.name), ['Ada', 'C']);
});

test('signals map after inserted text and to the edge of removed text', () => {
  const signals = createSignals({ now: () => 0 });
  signals.add({ uid: 'u1', name: 'Ada', pos: 2 });
  signals.add({ uid: 'u2', name: 'Bob', pos: 4 });
  signals.map(ChangeSet.of({ from: 2, insert: 'xy' }, 6));
  assert.deepEqual(signals.list().map((s) => s.pos), [4, 6]);
  signals.map(ChangeSet.of({ from: 3, to: 7 }, 8).toJSON());
  assert.deepEqual(signals.list().map((s) => s.pos), [3, 3]);
});
