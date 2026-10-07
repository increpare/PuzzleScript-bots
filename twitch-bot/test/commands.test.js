'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { parseCommand } = require('../commands');

const input = (action) => ({ type: 'input', action });

test('full words map to actions', () => {
  for (const w of ['up', 'down', 'left', 'right', 'action', 'undo', 'restart']) assert.deepEqual(parseCommand(w), input(w));
});

test('single letters map to actions', () => {
  assert.deepEqual(parseCommand('u'), input('up'));
  assert.deepEqual(parseCommand('d'), input('down'));
  assert.deepEqual(parseCommand('l'), input('left'));
  assert.deepEqual(parseCommand('r'), input('right'));
  assert.deepEqual(parseCommand('a'), input('action'));
  assert.deepEqual(parseCommand('x'), input('action'));
  assert.deepEqual(parseCommand('z'), input('undo'));
});

test('case and surrounding space are ignored', () => {
  assert.deepEqual(parseCommand('  UP '), input('up'));
  assert.deepEqual(parseCommand('R'), input('right'));
  assert.deepEqual(parseCommand('Restart'), input('restart'));
});

test('one leading ! is allowed on inputs', () => {
  assert.deepEqual(parseCommand('!up'), input('up'));
  assert.deepEqual(parseCommand('!z'), input('undo'));
  assert.equal(parseCommand('!!up'), null);
});

test('skip needs the !', () => {
  assert.deepEqual(parseCommand('!skip'), { type: 'skip' });
  assert.deepEqual(parseCommand('!SKIP'), { type: 'skip' });
  assert.equal(parseCommand('skip'), null);
});

test('ordinary chat is not a command', () => {
  for (const t of ['lol right?', 'go up', 'up up', '', '   ', 'uu', 'restart!', 'hasOwnProperty', 'toString']) assert.equal(parseCommand(t), null);
  assert.equal(parseCommand(undefined), null);
});
