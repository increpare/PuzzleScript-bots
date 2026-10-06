'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createPool } = require('../pool');
const { createRegistry } = require('../games');

const SOKOBAN = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'demo', 'sokoban_basic.txt'), 'utf8');
const getSource = async (id) => { if (id === 'sok') return SOKOBAN; throw new Error('unknown gist'); };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'psbot-games-'));

test('start creates and persists a record with a snapshot', async () => {
  const dir = tmp();
  const pool = createPool({ size: 1 });
  const reg = createRegistry({ dataDir: dir, pool, getSource });
  try {
    const { record, snapshot } = await reg.start({ gameId: 'm1', channelId: 'c', gistId: 'sok' });
    assert.equal(record.status, 'playing');
    assert.equal(record.meta.title, 'Simple Block Pushing Game');
    assert.equal(snapshot.kind, 'level');
    assert.ok(fs.existsSync(path.join(dir, 'games', 'm1.json')));
  } finally { await reg.close(); await pool.close(); }
});

test('press appends applied inputs and persists; inapplicable inputs are not recorded', async () => {
  const dir = tmp();
  const pool = createPool({ size: 1 });
  const reg = createRegistry({ dataDir: dir, pool, getSource });
  try {
    await reg.start({ gameId: 'm2', channelId: 'c', gistId: 'sok' });
    const r1 = await reg.press('m2', 'right');
    assert.equal(r1.applied, true);
    assert.deepEqual(r1.record.inputs, ['right']);
    const r2 = await reg.press('m2', 'continue');
    assert.equal(r2.applied, false);
    assert.deepEqual(r2.record.inputs, ['right']);
    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'games', 'm2.json'), 'utf8'));
    assert.deepEqual(onDisk.inputs, ['right']);
  } finally { await reg.close(); await pool.close(); }
});

test('a game evicted from the pool is rebuilt by replay on the next press', async () => {
  const dir = tmp();
  const pool = createPool({ size: 1 });
  const reg = createRegistry({ dataDir: dir, pool, getSource, maxLive: 1 });
  try {
    await reg.start({ gameId: 'a', channelId: 'c', gistId: 'sok' });
    await reg.press('a', 'right');
    const snapA = (await reg.press('a', 'right')).snapshot;
    await reg.start({ gameId: 'b', channelId: 'c', gistId: 'sok' }); // evicts a (maxLive 1)
    assert.equal(pool.has('a'), false);
    const again = await reg.press('a', 'undo');
    assert.equal(pool.has('a'), true);
    // after two rights and an undo we should be one right from the start: compare with a fresh run
    const reg2 = createRegistry({ dataDir: tmp(), pool, getSource });
    await reg2.start({ gameId: 'z', channelId: 'c', gistId: 'sok' });
    const one = (await reg2.press('z', 'right')).snapshot;
    assert.deepEqual(again.snapshot.cells, one.cells);
    assert.notDeepEqual(snapA.cells, one.cells);
    await reg2.close();
  } finally { await reg.close(); await pool.close(); }
});

test('loadAll restores records from disk and presses keep working', async () => {
  const dir = tmp();
  const pool = createPool({ size: 1 });
  let reg = createRegistry({ dataDir: dir, pool, getSource });
  await reg.start({ gameId: 'p', channelId: 'c', gistId: 'sok' });
  await reg.press('p', 'right');
  await reg.close();
  reg = createRegistry({ dataDir: dir, pool, getSource });
  try {
    assert.equal(reg.loadAll(), 1);
    assert.deepEqual(reg.get('p').inputs, ['right']);
    const r = await reg.press('p', 'undo');
    assert.equal(r.applied, true);
  } finally { await reg.close(); await pool.close(); }
});

test('concurrent presses on one game apply in order', async () => {
  const dir = tmp();
  const pool = createPool({ size: 1 });
  const reg = createRegistry({ dataDir: dir, pool, getSource });
  try {
    await reg.start({ gameId: 'q', channelId: 'c', gistId: 'sok' });
    const results = await Promise.all([reg.press('q', 'right'), reg.press('q', 'right'), reg.press('q', 'undo')]);
    assert.deepEqual(results[2].record.inputs, ['right', 'right', 'undo']);
  } finally { await reg.close(); await pool.close(); }
});

test('prune deletes idle records', async () => {
  const dir = tmp();
  const pool = createPool({ size: 1 });
  let t = 1_000_000;
  const reg = createRegistry({ dataDir: dir, pool, getSource, now: () => t });
  try {
    await reg.start({ gameId: 'old', channelId: 'c', gistId: 'sok' });
    t += 15 * 24 * 3600 * 1000;
    await reg.start({ gameId: 'new', channelId: 'c', gistId: 'sok' });
    assert.equal(reg.prune(14 * 24 * 3600 * 1000), 1);
    assert.equal(reg.get('old'), undefined);
    assert.equal(fs.existsSync(path.join(dir, 'games', 'old.json')), false);
    assert.ok(reg.get('new'));
  } finally { await reg.close(); await pool.close(); }
});

test('loadAll tolerates corrupt files', async () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, 'games'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'games', 'bad.json'), '{not json');
  fs.writeFileSync(path.join(dir, 'games', 'odd.json'), '{"x":1}');
  const pool = createPool({ size: 1 });
  const reg = createRegistry({ dataDir: dir, pool, getSource });
  try { assert.equal(reg.loadAll(), 0); } finally { await reg.close(); await pool.close(); }
});

test('pressing a finished record restored from disk returns a finished snapshot without touching the pool', async () => {
  const dir = tmp();
  const pool = createPool({ size: 1 });
  let reg = createRegistry({ dataDir: dir, pool, getSource });
  await reg.start({ gameId: 'f', channelId: 'c', gistId: 'sok' });
  // fake completion on disk: mark the record finished the way press would
  const file = path.join(dir, 'games', 'f.json');
  const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
  rec.status = 'finished';
  fs.writeFileSync(file, JSON.stringify(rec));
  await reg.close();
  await pool.drop('f');
  reg = createRegistry({ dataDir: dir, pool, getSource });
  try {
    reg.loadAll();
    const r = await reg.press('f', 'right');
    assert.equal(r.applied, false);
    assert.equal(r.snapshot.kind, 'finished');
    assert.equal(pool.has('f'), false);
  } finally { await reg.close(); await pool.close(); }
});

test('a game with a press in flight is not evicted by another game filling the live set', async () => {
  const dir = tmp();
  const pool = createPool({ size: 1 });
  const reg = createRegistry({ dataDir: dir, pool, getSource, maxLive: 1 });
  try {
    await reg.start({ gameId: 'x', channelId: 'c', gistId: 'sok' });
    const pressing = reg.press('x', 'right');          // x is busy while this runs
    await reg.start({ gameId: 'y', channelId: 'c', gistId: 'sok' }); // would evict x under plain LRU
    const r = await pressing;
    assert.equal(r.applied, true);
    assert.deepEqual(r.record.inputs, ['right']);
    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'games', 'x.json'), 'utf8'));
    assert.deepEqual(onDisk.inputs, ['right']);
  } finally { await reg.close(); await pool.close(); }
});
