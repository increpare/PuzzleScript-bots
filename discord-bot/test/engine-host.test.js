'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { createHost, CompileError } = require('../engine-host');

const DEMO = (name) => fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'demo', name), 'utf8');
const SOKOBAN = DEMO('sokoban_basic.txt');

test('load returns metadata and flags', () => {
  const host = createHost();
  const meta = host.load(SOKOBAN, 'seed', 0);
  assert.equal(meta.title, 'Simple Block Pushing Game');
  assert.equal(meta.author, 'David Skinner');
  assert.ok(meta.levelCount >= 1);
  assert.deepEqual(meta.flags, { noaction: false, noundo: false, norestart: false, realtime: false });
  host.dispose();
});

test('snapshot of a level exposes cells, sprites and colours', () => {
  const host = createHost();
  host.load(SOKOBAN, 'seed', 0);
  const s = host.snapshot();
  assert.equal(s.kind, 'level');
  assert.equal(s.levelIndex, 0);
  assert.ok(s.width > 0 && s.height > 0);
  assert.equal(s.cells.length, s.width * s.height);
  assert.equal(s.background, '#000000');
  assert.equal(s.textColor, '#ffffff');
  assert.deepEqual(s.viewport, { x: 0, y: 0, w: s.width, h: s.height });
  // every cell has at least the background object
  for (const ids of s.cells) assert.ok(ids.length >= 1);
  // a sprite looks like a 5x5 matrix with colours
  const anyId = s.cells[0][0];
  assert.equal(s.sprites[anyId].dat.length, 5);
  assert.equal(s.sprites[anyId].dat[0].length, 5);
  assert.ok(Array.isArray(s.sprites[anyId].colors));
  host.dispose();
});

test('compile errors throw CompileError with the engine message', () => {
  const host = createHost();
  assert.throws(
    () => host.load('title broken\n\n=======\nOBJECTS\n=======\n\nPlayer\nred\n\n=======\nLEGEND\n=======\n\nP = Player\n\n=======\nSOUNDS\n=======\n\n================\nCOLLISIONLAYERS\n================\n\nPlayer\n\n=======\nRULES\n=======\n\n[ > Player | Wall ] -> [ > Player | > Wall ]\n\n==============\nWINCONDITIONS\n==============\n\n=======\nLEVELS\n=======\n\nP\n', 'seed', 0),
    (err) => err instanceof CompileError && /Wall|unknown|not defined|undefined/i.test(err.message)
  );
  host.dispose();
});

test('realtime games are flagged', () => {
  const host = createHost();
  const src = 'title rt\nrealtime_interval 0.1\n\n=======\nOBJECTS\n=======\n\nBackground\nblack\n\nPlayer\nred\n\n=======\nLEGEND\n=======\n\n. = Background\nP = Player\n\n=======\nSOUNDS\n=======\n\n================\nCOLLISIONLAYERS\n================\n\nBackground\nPlayer\n\n=======\nRULES\n=======\n\n==============\nWINCONDITIONS\n==============\n\n=======\nLEVELS\n=======\n\nP..\n';
  const meta = host.load(src, 'seed', 0);
  assert.equal(meta.flags.realtime, true);
  host.dispose();
});
