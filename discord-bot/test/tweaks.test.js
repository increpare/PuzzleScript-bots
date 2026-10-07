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
