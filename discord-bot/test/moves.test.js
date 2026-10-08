'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { parseMoves } = require('../moves');

const flags = (f) => Object.assign({ noaction: false, noundo: false, norestart: false, realtime: false }, f);

test('letters become moves, in order', () => {
  assert.deepEqual(parseMoves('uldrxz', flags({})), { ok: true, actions: ['up', 'left', 'down', 'right', 'action', 'undo'] });
});

test('capitals, spaces, commas and line breaks between the letters do not matter', () => {
  assert.deepEqual(parseMoves(' U u,R\n z ', flags({})), { ok: true, actions: ['up', 'up', 'right', 'undo'] });
});

test('a letter that is not a move refuses the whole line and is named', () => {
  const r = parseMoves('uuwr', flags({}));
  assert.equal(r.ok, false);
  assert.match(r.error, /"w"/);
});

test('an empty line is refused', () => {
  assert.equal(parseMoves('  , ', flags({})).ok, false);
  assert.equal(parseMoves(undefined, flags({})).ok, false);
});

test('fifty moves are taken and fifty-one are not', () => {
  assert.equal(parseMoves('r'.repeat(50), flags({})).actions.length, 50);
  const r = parseMoves('r'.repeat(51), flags({}));
  assert.equal(r.ok, false);
  assert.match(r.error, /51/);
});

test('a game without an action button or without undo refuses that letter', () => {
  assert.match(parseMoves('rx', flags({ noaction: true })).error, /action/);
  assert.match(parseMoves('rz', flags({ noundo: true })).error, /undo/);
  assert.equal(parseMoves('rz', flags({ noaction: true })).ok, true);
});
