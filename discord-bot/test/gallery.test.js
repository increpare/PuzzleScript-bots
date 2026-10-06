'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { loadGallery, suggest } = require('../gallery');

test('loadGallery reads the gallery', () => {
  const g = loadGallery();
  assert.ok(g.length > 100);
  for (const e of g) assert.match(e.gistId, /^[0-9a-f]+$/i);
});

test('suggest with empty query returns 25 short names', () => {
  const s = suggest(loadGallery(), '');
  assert.strictEqual(s.length, 25);
  for (const c of s) assert.ok(c.name.length <= 100);
});

test('suggest finds microban first', () => {
  assert.strictEqual(suggest(loadGallery(), 'microban')[0].value, '6841219');
});

test('suggest with no match is empty', () => {
  assert.deepStrictEqual(suggest(loadGallery(), 'zzzzzz'), []);
});
