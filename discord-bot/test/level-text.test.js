'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { createHost } = require('../engine-host');
const { createPool } = require('../pool');
const { SRC_DIR } = require('../engine-src');

const DEMO = (name) => fs.readFileSync(path.join(SRC_DIR, 'demo', name), 'utf8');
const SOKOBAN_FIRST = ['####..', '#.o#..', '#..###', '#@p..#', '#..*.#', '#..###', '####..'].join('\n');

test('a level comes back as the rows it was written as', () => {
  const host = createHost();
  host.load(DEMO('sokoban_basic.txt'), 'seed', 0);
  assert.equal(host.levelText(), SOKOBAN_FIRST);
});

test('the text has the shape of the level, for a range of games', () => {
  const host = createHost();
  for (const name of ['sokoban_basic.txt', 'microban.txt', 'blockfaker.txt', 'limerick.txt', 'atlas shrank.txt']) {
    const meta = host.load(DEMO(name), 'seed', 0);
    host.load(DEMO(name), 'seed', meta.realLevels[0]);
    const snap = host.snapshot();
    const rows = host.levelText().split('\n');
    assert.equal(rows.length, snap.height, name);
    for (const row of rows) assert.equal(row.length, snap.width, name);
  }
});

test('it reads the level as it stands, not as it started', () => {
  const host = createHost();
  host.load(DEMO('sokoban_basic.txt'), 'seed', 0);
  assert.equal(host.input('right'), true);
  const rows = host.levelText().split('\n');
  assert.equal(rows[3], '#@.p.#');
});

test('the pool hands the text back from a worker', async () => {
  const pool = createPool({ size: 1 });
  try {
    await pool.load('g', DEMO('sokoban_basic.txt'), 'seed', 0);
    assert.equal(await pool.levelText('g'), SOKOBAN_FIRST);
  } finally { await pool.close(); }
});
