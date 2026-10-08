'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { loadGallery, loadGames, suggest } = require('../gallery');

test('loadGallery reads the gallery', () => {
  const g = loadGallery();
  assert.ok(g.length > 100);
  for (const e of g) {
    assert.match(e.gistId, /^[0-9a-f]+$/i);
    assert.strictEqual(e.starred, true);
  }
});

test('loadGames puts the gallery first and lists no game twice', () => {
  const gallery = loadGallery();
  const games = loadGames();
  assert.ok(games.length > gallery.length);
  assert.deepStrictEqual(games.slice(0, gallery.length), gallery);
  for (const e of games.slice(gallery.length)) {
    assert.match(e.gistId, /^[0-9a-f]+$/);
    assert.strictEqual(e.starred, false);
    assert.ok(e.title);
  }
  assert.strictEqual(new Set(games.map((e) => e.gistId)).size, games.length);
});

test('suggest with empty query returns 25 short names from the gallery', () => {
  const s = suggest(loadGames(), '');
  assert.strictEqual(s.length, 25);
  for (const c of s) {
    assert.ok(c.name.length <= 100);
    assert.ok(c.name.startsWith('⭐ '));
  }
});

test('suggest finds microban first', () => {
  assert.strictEqual(suggest(loadGames(), 'microban')[0].value, '6841219');
});

test('suggest with no match is empty', () => {
  assert.deepStrictEqual(suggest(loadGames(), 'zzzzzzzz'), []);
});

const game = (gistId, title, author, starred) => ({ gistId, title, author, starred: !!starred });

test('suggest stars the gallery games only', () => {
  const s = suggest([game('a1', 'Boxes', 'Ann', true), game('b2', 'Boxes Two', '')], 'boxes');
  assert.deepStrictEqual(s, [{ name: '⭐ Boxes — Ann', value: 'a1' }, { name: 'Boxes Two', value: 'b2' }]);
});

test('suggest puts gallery games before the others, however well the others match', () => {
  const games = [game('a1', 'Crate', 'Ann'), game('b2', 'The Big Crate Game', 'Bob', true), game('c3', 'Other', 'Crate Fan', true)];
  assert.deepStrictEqual(suggest(games, 'crate').map((c) => c.value), ['b2', 'c3', 'a1']);
});

test('suggest orders matches: start of the title, start of a word, inside a word, author', () => {
  const games = [
    game('d4', 'Other', 'Rockwell'),
    game('c3', 'Bedrock', 'Ann'),
    game('b2', 'Push the Rock', 'Ann'),
    game('a1', 'Rock Pusher', 'Ann'),
  ];
  assert.deepStrictEqual(suggest(games, ' ROCK ').map((c) => c.value), ['a1', 'b2', 'c3', 'd4']);
});

test('suggest keeps to the limit', () => {
  const games = [];
  for (let i = 0; i < 40; i++) games.push(game('a' + i, 'Maze ' + i, 'Ann', i >= 30));
  const s = suggest(games, 'maze');
  assert.strictEqual(s.length, 25);
  assert.deepStrictEqual(s.slice(0, 10).map((c) => c.value), games.slice(30).map((g) => g.gistId));
});
