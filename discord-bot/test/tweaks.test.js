'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { parseTweakChannels, tweakAllowed } = require('../tweaks');

test('unset means nowhere, a list means those channels, a star means everywhere', () => {
  assert.deepEqual(parseTweakChannels(undefined), []);
  assert.deepEqual(parseTweakChannels('  '), []);
  assert.deepEqual(parseTweakChannels('111, 222 ,'), ['111', '222']);
  assert.equal(parseTweakChannels(' * '), '*');
});

test('a channel is allowed by its own id or by its parent, for a thread', () => {
  assert.equal(tweakAllowed([], '111', null), false);
  assert.equal(tweakAllowed(['111'], '111', null), true);
  assert.equal(tweakAllowed(['111'], '999', '111'), true);
  assert.equal(tweakAllowed(['111'], '999', '888'), false);
  assert.equal(tweakAllowed(['111'], '999', null), false);
  assert.equal(tweakAllowed('*', '999', null), true);
});

const { createPending } = require('../tweaks');

test('what a user is about to edit: the newest press wins, and it lapses', () => {
  let t = 0;
  const pending = createPending({ ttlMs: 1000, now: () => t });
  assert.equal(pending.get('u'), null);
  pending.set('u', { gameId: 'a' });
  pending.set('u', { gameId: 'b' });
  pending.set('v', { gameId: 'c' });
  assert.deepEqual(pending.get('u'), { gameId: 'b' });
  assert.deepEqual(pending.get('u'), { gameId: 'b' }); // reading it does not use it up
  t = 999;
  assert.deepEqual(pending.get('v'), { gameId: 'c' });
  t = 1000;
  assert.equal(pending.get('u'), null);
  assert.equal(pending.get('v'), null);
});

test('only so many users are remembered at once, the oldest going first', () => {
  let t = 0;
  const pending = createPending({ ttlMs: 1000, now: () => t, max: 2 });
  pending.set('a', { n: 1 });
  t = 1;
  pending.set('b', { n: 2 });
  t = 2;
  pending.set('c', { n: 3 });
  assert.equal(pending.get('a'), null);
  assert.deepEqual(pending.get('b'), { n: 2 });
  assert.deepEqual(pending.get('c'), { n: 3 });
});
