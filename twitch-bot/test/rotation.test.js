'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRotation } = require('../rotation');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'twitch-rotation-'));
const GALLERY = [
  { gistId: 'aaa1', title: 'One', author: 'a' },
  { gistId: 'bbb2', title: 'Two', author: 'b' },
  { gistId: 'ccc3', title: 'Three', author: 'c' },
];

test('plays every game once before any repeats', () => {
  const r = createRotation({ gallery: GALLERY, dataDir: tmp() });
  const seen = [r.current().gistId, r.advance().gistId, r.advance().gistId];
  assert.deepEqual(seen.slice().sort(), ['aaa1', 'bbb2', 'ccc3']);
  assert.ok(GALLERY.some((g) => g.gistId === r.advance().gistId));
});

test('current is stable until advance', () => {
  const r = createRotation({ gallery: GALLERY, dataDir: tmp() });
  assert.equal(r.current(), r.current());
  assert.equal(r.current().title.length > 0, true);
});

test('order and position survive a restart', () => {
  const dir = tmp();
  const a = createRotation({ gallery: GALLERY, dataDir: dir });
  a.advance();
  const expected = a.current().gistId;
  const b = createRotation({ gallery: GALLERY, dataDir: dir });
  assert.equal(b.current().gistId, expected);
  assert.equal(b.advance().gistId, a.advance().gistId);
});

test('a saved order that no longer matches the gallery is replaced', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ order: ['aaa1', 'gone', 'ccc3'], pos: 1 }));
  const r = createRotation({ gallery: GALLERY, dataDir: dir });
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
  assert.deepEqual(saved.order.slice().sort(), ['aaa1', 'bbb2', 'ccc3']);
  assert.equal(saved.pos, 0);
  assert.ok(r.current());
});

test('corrupt files are ignored', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'state.json'), '{not json');
  fs.writeFileSync(path.join(dir, 'progress.json'), '[1,2');
  const r = createRotation({ gallery: GALLERY, dataDir: dir });
  assert.ok(r.current());
  assert.equal(r.savedLevel('aaa1'), 0);
});

test('level progress is saved, read back after a restart, and cleared', () => {
  const dir = tmp();
  const a = createRotation({ gallery: GALLERY, dataDir: dir });
  assert.equal(a.savedLevel('aaa1'), 0);
  a.saveLevel('aaa1', 4);
  assert.equal(a.savedLevel('aaa1'), 4);
  const b = createRotation({ gallery: GALLERY, dataDir: dir });
  assert.equal(b.savedLevel('aaa1'), 4);
  b.clearLevel('aaa1');
  assert.equal(createRotation({ gallery: GALLERY, dataDir: dir }).savedLevel('aaa1'), 0);
});

test('an empty gallery is an error', () => {
  assert.throws(() => createRotation({ gallery: [], dataDir: tmp() }), /gallery is empty/);
});
