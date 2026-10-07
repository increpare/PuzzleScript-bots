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

test('invisible characters that chat clients add to repeat a message are ignored', () => {
  for (const t of ['up \u{E0000}', 'up\u{E0000}', 'up​', '​up', 'up​‍', '﻿up', 'u­p', '!up \u{E0000}', 'UP\u{E0020}\u{E007F}']) assert.deepEqual(parseCommand(t), input('up'), JSON.stringify(t));
  assert.deepEqual(parseCommand('!skip \u{E0000}'), { type: 'skip' });
  assert.deepEqual(parseCommand('​!SKIP​'), { type: 'skip' });
  assert.deepEqual(parseCommand('r \u{E0000}'), input('right'));
});

test('a message of only invisible characters is not a command', () => {
  for (const t of ['\u{E0000}', ' ​ ', '\u{E0000}​﻿', '!\u{E0000}']) assert.equal(parseCommand(t), null, JSON.stringify(t));
});

test('invisible characters do not turn ordinary chat into a command', () => {
  for (const t of ['up​ up', 'up \u{E0000} up', 'go​up', '!!up​', '\u{E0000}skip']) assert.equal(parseCommand(t), null, JSON.stringify(t));
});

test('go continues past a message', () => {
  assert.deepEqual(parseCommand('go'), { type: 'input', action: 'continue' });
  assert.deepEqual(parseCommand(' GO '), { type: 'input', action: 'continue' });
  assert.deepEqual(parseCommand('!go'), { type: 'input', action: 'continue' });
  assert.equal(parseCommand("let's go"), null);
  assert.equal(parseCommand('go up'), null);
});
