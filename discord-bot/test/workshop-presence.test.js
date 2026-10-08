'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createPresence } = require('../workshop-presence');

test('who is in the room, with a cursor each, in the order they came in', () => {
  let t = 0;
  const p = createPresence({ now: () => t });
  assert.deepEqual(p.list(), []);
  p.set('c1', { uid: 'u1', name: 'Ada', anchor: 3, head: 9 });
  t = 10;
  p.set('c2', { uid: 'u2', name: 'Bob', anchor: null, head: null });
  const list = p.list();
  assert.deepEqual(list.map((x) => [x.id, x.name, x.anchor, x.head]), [['c1', 'Ada', 3, 9], ['c2', 'Bob', null, null]]);
  for (const x of list) assert.match(x.color, /^#[0-9a-f]{6}$/);
  assert.equal('uid' in list[0], false); // ids are not handed to other people's pages
});

test('a person keeps their colour, whichever window they are in', () => {
  const p = createPresence({ now: () => 0 });
  p.set('c1', { uid: 'u1', name: 'Ada', anchor: 0, head: 0 });
  p.set('c2', { uid: 'u1', name: 'Ada', anchor: 5, head: 5 });
  p.set('c3', { uid: 'u2', name: 'Bob', anchor: 0, head: 0 });
  const [a, b] = p.list();
  assert.equal(a.color, b.color);
  assert.equal(createPresence({ now: () => 0 }).colorOf('u1'), a.color);
});

test('the revision moves only when something others would see has changed', () => {
  let t = 0;
  const p = createPresence({ now: () => t });
  assert.equal(p.rev(), 0);
  p.set('c1', { uid: 'u1', name: 'Ada', anchor: 3, head: 3 });
  assert.equal(p.rev(), 1);
  t = 1000;
  p.set('c1', { uid: 'u1', name: 'Ada', anchor: 3, head: 3 }); // a heartbeat: still here, nothing new
  assert.equal(p.rev(), 1);
  p.set('c1', { uid: 'u1', name: 'Ada', anchor: 3, head: 4 });
  assert.equal(p.rev(), 2);
});

test('someone who has not been heard from for a while has left', () => {
  let t = 0;
  const p = createPresence({ now: () => t, ttlMs: 15000 });
  p.set('c1', { uid: 'u1', name: 'Ada', anchor: 0, head: 0 });
  p.set('c2', { uid: 'u2', name: 'Bob', anchor: 0, head: 0 });
  t = 10000;
  p.set('c2', { uid: 'u2', name: 'Bob', anchor: 0, head: 0 });
  t = 15000;
  assert.equal(p.sweep(), true); // Ada went
  assert.deepEqual(p.list().map((x) => x.name), ['Bob']);
  assert.equal(p.rev(), 3);
  assert.equal(p.sweep(), false);
  assert.equal(p.remove('c2', 'someone else'), false); // only its own user can take an editor out
  assert.equal(p.list().length, 1);
  assert.equal(p.remove('c2', 'u2'), true);
  assert.deepEqual(p.list(), []);
  assert.equal(p.remove('c2', 'u2'), false);
});

test('what is not a cursor is refused, and the room has a limit', () => {
  const p = createPresence({ now: () => 0, max: 2 });
  const bad = (id, entry) => assert.throws(() => p.set(id, entry), (e) => e.name === 'WorkshopError');
  bad('', { uid: 'u', name: 'A', anchor: 0, head: 0 });
  bad('x'.repeat(101), { uid: 'u', name: 'A', anchor: 0, head: 0 });
  bad('c', { uid: 'u', name: 'A', anchor: -1, head: 0 });
  bad('c', { uid: 'u', name: 'A', anchor: 1.5, head: 0 });
  bad('c', { uid: 'u', name: 'A', anchor: 0, head: 'x' });
  bad('c', { uid: 'u', name: 'A', anchor: 0, head: null }); // both or neither
  p.set('c1', { uid: 'u1', name: 'x'.repeat(200), anchor: 0, head: 0 });
  assert.equal(p.list()[0].name.length, 80);
  p.set('c2', { uid: 'u2', name: '', anchor: 0, head: 0 });
  assert.equal(p.list()[1].name, 'someone');
  bad('c3', { uid: 'u3', name: 'C', anchor: 0, head: 0 });
  p.set('c1', { uid: 'u1', name: 'A', anchor: 1, head: 1 }); // those already in can carry on
});
