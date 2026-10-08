'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createExports } = require('../workshop-exports');

const game = { html: '<!doctype html><p>é</p>', source: 'title é\n', filename: 'é.html' };

test('exports hold immutable HTML and source snapshots under separate random tokens', () => {
  const exports = createExports();
  const input = { ...game };
  const first = exports.add(input);
  const second = exports.add(input);
  const tokens = [first.htmlToken, first.sourceToken, second.htmlToken, second.sourceToken];
  assert.equal(new Set(tokens).size, 4);
  for (const token of tokens) assert.match(token, /^[A-Za-z0-9_-]{32}$/);
  input.html = 'changed';
  input.source = 'changed';
  const html = exports.get(first.htmlToken);
  assert.deepEqual(html, { body: game.html, filename: 'é.html', contentType: 'text/html; charset=utf-8' });
  assert.deepEqual(exports.get(first.sourceToken), { body: game.source, filename: 'é.txt', contentType: 'text/plain; charset=utf-8' });
  assert.throws(() => { html.body = 'changed'; }, TypeError);
  assert.equal(exports.get(first.htmlToken).body, game.html);
  assert.equal(exports.get('unknown'), null);
});

test('exports expire after fifteen minutes, including when a later export is added', () => {
  let clock = 0;
  const exports = createExports({ now: () => clock });
  const first = exports.add(game);
  clock = 15 * 60 * 1000 - 1;
  assert.equal(exports.get(first.htmlToken).body, game.html);
  clock++;
  assert.equal(exports.get(first.sourceToken), null);
  assert.equal(exports.get(first.htmlToken), null);
  const next = exports.add(game);
  assert.equal(exports.get(next.htmlToken).body, game.html);
});

test('capacity drops oldest whole exports and expiration frees capacity on add', () => {
  let clock = 0;
  const exports = createExports({ now: () => clock, ttlMs: 10, maxBytes: 8 });
  const first = exports.add({ html: '123', source: '4', filename: 'one' });
  const second = exports.add({ html: '567', source: '8', filename: 'two' });
  assert.equal(exports.get(first.htmlToken).body, '123');
  const third = exports.add({ html: 'abc', source: 'd', filename: 'three' });
  assert.equal(exports.get(first.htmlToken), null);
  assert.equal(exports.get(first.sourceToken), null);
  assert.equal(exports.get(second.sourceToken).body, '8');
  clock = 10;
  const fourth = exports.add({ html: 'ghi', source: 'j', filename: 'four' });
  assert.equal(exports.get(third.htmlToken), null);
  assert.equal(exports.get(fourth.htmlToken).body, 'ghi');
});

test('many tiny exports have a bounded entry count as well as a byte limit', () => {
  const exports = createExports();
  const first = exports.add({ html: 'x', source: 'y', filename: 'tiny' });
  let last;
  for (let i = 0; i < 128; i++) last = exports.add({ html: 'x', source: 'y', filename: 'tiny' });
  assert.equal(exports.get(first.htmlToken), null);
  assert.equal(exports.get(first.sourceToken), null);
  assert.equal(exports.get(last.htmlToken).body, 'x');
});

test('export limits count UTF-8 bytes and reject entries exceeding capacity or eight MiB', () => {
  const tiny = createExports({ maxBytes: 5 });
  assert.throws(() => tiny.add({ html: 'éé', source: 'é', filename: 'unicode' }), /too big/i);
  assert.equal(tiny.get(tiny.add({ html: 'é', source: 'é', filename: 'unicode' }).htmlToken).body, 'é');
  const exports = createExports();
  assert.throws(() => exports.add({ html: 'x'.repeat(8 * 1024 * 1024), source: 'x', filename: 'big' }), /too big/i);
});

test('exports require nonempty string content and filenames', () => {
  const exports = createExports();
  for (const input of [null, {}, { ...game, html: '' }, { ...game, source: '' }, { ...game, filename: '' }, { ...game, html: {} }, { ...game, source: [] }, { ...game, filename: 5 }, { ...game, html: '  ' }, { ...game, filename: '\ud800' }]) {
    assert.throws(() => exports.add(input), /bad export/i);
  }
});

test('filenames remove path separators, controls and unsafe punctuation but preserve Unicode', () => {
  const exports = createExports();
  const tokens = exports.add({ ...game, filename: '../folder\\é\r\n\0\u0085:"<>|?*.html' });
  const html = exports.get(tokens.htmlToken);
  assert.match(html.filename, /é/);
  assert.doesNotMatch(html.filename, /[\/\\\x00-\x1f\x7f-\x9f:"<>|?*]/);
  assert.doesNotMatch(html.filename, /^\./);
  assert.match(exports.get(tokens.sourceToken).filename, /\.txt$/);
});
