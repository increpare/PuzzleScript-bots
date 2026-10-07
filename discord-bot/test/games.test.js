'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createPool } = require('../pool');
const { createRegistry } = require('../games');
const { SRC_DIR } = require('../engine-src');

const SOKOBAN = fs.readFileSync(path.join(SRC_DIR, 'demo', 'sokoban_basic.txt'), 'utf8');
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

test('records over the size cap are evicted: finished first, then least recently played', async () => {
  const dir = tmp();
  const pool = createPool({ size: 1 });
  let t = 1_000_000;
  // each sokoban record is a few hundred bytes; a 1300-byte cap holds two or three of them
  const reg = createRegistry({ dataDir: dir, pool, getSource, now: () => t, maxRecordBytes: 1300 });
  try {
    for (const id of ['g1', 'g2', 'g3']) { t += 1000; await reg.start({ gameId: id, channelId: 'c', gistId: 'sok' }); }
    reg.markDead('g3', 'test');            // a stopped game is the first to go, even though it is newest
    for (const id of ['g4', 'g5', 'g6']) { t += 1000; await reg.start({ gameId: id, channelId: 'c', gistId: 'sok' }); }
    assert.equal(reg.get('g3'), undefined, 'stopped game evicted first');
    assert.equal(reg.get('g1'), undefined, 'oldest playing game evicted next');
    assert.ok(reg.get('g6'), 'newest game kept');
    assert.ok(reg.storage().recordBytes <= 1300);
    assert.equal(fs.existsSync(path.join(dir, 'games', 'g1.json')), false);
  } finally { await reg.close(); await pool.close(); }
});

test('a game keeps its stored source after the gist changes, and is refused only if that copy is gone', async () => {
  const dir = tmp();
  const pool = createPool({ size: 1 });
  let current = SOKOBAN;
  const src = async () => current;
  let reg = createRegistry({ dataDir: dir, pool, getSource: src });
  await reg.start({ gameId: 'k', channelId: 'c', gistId: 'sok' });
  await reg.press('k', 'right');
  await reg.close();
  await pool.drop('k');
  current = SOKOBAN.replace('Simple Block Pushing Game', 'Edited');
  reg = createRegistry({ dataDir: dir, pool, getSource: src });
  try {
    reg.loadAll();
    const r = await reg.press('k', 'undo');
    assert.equal(r.applied, true, 'replayed against the stored original source');
    // now lose the stored source too: the edited gist no longer matches
    await pool.drop('k');
    for (const f of fs.readdirSync(path.join(dir, 'sources'))) fs.unlinkSync(path.join(dir, 'sources', f));
    await assert.rejects(reg.press('k', 'right'), /source changed/);
    assert.equal(reg.get('k').status, 'dead');
  } finally { await reg.close(); await pool.close(); }
});

test('the source store is capped, least recently used first', async () => {
  const dir = tmp();
  const pool = createPool({ size: 1 });
  let n = 0;
  const src = async () => SOKOBAN.replace('Simple Block Pushing Game', 'Game ' + (n++));
  const reg = createRegistry({ dataDir: dir, pool, getSource: src, maxSourceBytes: Buffer.byteLength(SOKOBAN) * 2 + 100 });
  try {
    for (const id of ['s1', 's2', 's3', 's4']) await reg.start({ gameId: id, channelId: 'c', gistId: 'sok' });
    const files = fs.readdirSync(path.join(dir, 'sources')).filter((f) => f.endsWith('.txt'));
    assert.ok(files.length <= 2, 'kept at most two sources, got ' + files.length);
    assert.ok(files.includes(reg.get('s4').sourceHash + '.txt'), 'the newest source is kept');
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

test('a changed gist source kills the game on next replay', async () => {
  const dir = tmp();
  const pool = createPool({ size: 1 });
  const reg = createRegistry({ dataDir: dir, pool, getSource });
  const file = path.join(dir, 'games', 'sp.json');
  try {
    await reg.start({ gameId: 'sp', channelId: 'c', gistId: 'sok' });
    await reg.close();
    const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.match(rec.sourceHash, /^[0-9a-f]{64}$/);
    rec.sourceHash = 'deadbeef';
    fs.writeFileSync(file, JSON.stringify(rec));
    await pool.drop('sp');
    const reg2 = createRegistry({ dataDir: dir, pool, getSource });
    reg2.loadAll();
    await assert.rejects(reg2.press('sp', 'right'), /source changed/);
    assert.equal(reg2.get('sp').status, 'dead');
    await reg2.close();
  } finally { await pool.close(); }
});

test('press reports the solved level when a move wins it', async () => {
  const dir = tmp();
  const pool = createPool({ size: 1 });
  const two = fs.readFileSync(path.join(__dirname, 'fixtures', 'two-level-random.txt'), 'utf8');
  const reg = createRegistry({ dataDir: dir, pool, getSource: async () => two });
  try {
    await reg.start({ gameId: 'w', channelId: 'c', gistId: 'abcd' });
    const win = await reg.press('w', 'right');
    assert.equal(win.solvedLevel, 0);
    const move = await reg.press('w', 'left');
    assert.equal(move.solvedLevel, null);
    const undo = await reg.press('w', 'undo');
    assert.equal(undo.solvedLevel, null);
  } finally { await reg.close(); await pool.close(); }
});

test('press records who made the last applied move', async () => {
  const dir = tmp();
  const pool = createPool({ size: 1 });
  const reg = createRegistry({ dataDir: dir, pool, getSource });
  try {
    await reg.start({ gameId: 'lm', channelId: 'c', gistId: 'sok' });
    assert.equal((await reg.press('lm', 'right', 'alice')).record.lastMover, 'alice');
    assert.equal((await reg.press('lm', 'continue', 'bob')).record.lastMover, 'alice', 'inapplicable presses do not change it');
  } finally { await reg.close(); await pool.close(); }
});

test('start level numbers count real levels only, and out-of-range is refused', async () => {
  const dir = tmp();
  const pool = createPool({ size: 1 });
  const msg = fs.readFileSync(path.join(__dirname, 'fixtures', 'message-game.txt'), 'utf8');
  const reg = createRegistry({ dataDir: dir, pool, getSource: async () => msg });
  try {
    const { record, snapshot } = await reg.start({ gameId: 'n1', channelId: 'c', gistId: 'abcd', startLevelNumber: 1 });
    assert.equal(record.startLevel, 0);
    assert.equal(snapshot.levelNumber, 1);
    await assert.rejects(reg.start({ gameId: 'n2', channelId: 'c', gistId: 'abcd', startLevelNumber: 2 }), (e) => e.name === 'LevelRangeError' && /only has 1 level$/.test(e.message));
    assert.equal(reg.get('n2'), undefined);
    assert.equal(pool.has('n2'), false);
  } finally { await reg.close(); await pool.close(); }
});

const SLIDE_SRC = fs.readFileSync(path.join(__dirname, 'fixtures', 'again-slide.txt'), 'utf8');
const LOOP_SRC = fs.readFileSync(path.join(__dirname, 'fixtures', 'again-loop.txt'), 'utf8');

// A pool whose next play fails the way a real one does, then behaves normally again.
function failingOnce(pool, kind) {
  let armed = false;
  const wrapped = Object.assign({}, pool, {
    async play(id, action, opts) {
      if (!armed) return pool.play(id, action, opts);
      armed = false;
      if (kind === 'MoveTooLongError') await pool._call(id, 'drop', {}, 1000); // the worker discards the half-played game but stays up
      else await pool.drop(id);                                                 // the worker was stopped, and the pool forgot the game
      throw Object.assign(new Error(kind), { name: kind });
    },
  });
  return { pool: wrapped, failNext: () => { armed = true; } };
}

for (const kind of ['MoveTooLongError', 'TimeoutError']) {
  test('a move refused with ' + kind + ' is not recorded, and the game carries on from where it was', async () => {
    const dir = tmp();
    const real = createPool({ size: 1 });
    const { pool, failNext } = failingOnce(real, kind);
    const reg = createRegistry({ dataDir: dir, pool, getSource });
    try {
      await reg.start({ gameId: 'r', channelId: 'c', gistId: 'sok' });
      const before = (await reg.press('r', 'right')).snapshot;
      failNext();
      await assert.rejects(reg.press('r', 'up'), (e) => e.name === kind);
      const rec = reg.get('r');
      assert.equal(rec.status, 'playing');
      assert.deepEqual(rec.inputs, ['right']);
      const undone = await reg.press('r', 'undo');
      assert.equal(undone.applied, true);
      assert.deepEqual(undone.record.inputs, ['right', 'undo']);
      const again = await reg.press('r', 'right');
      assert.deepEqual(again.snapshot.cells, before.cells, 'rebuilt from the log, so the same move gives the same board');
    } finally { await reg.close(); await real.close(); }
  });
}

test('press returns an animation for a move that ran on, and none for a single turn', async () => {
  const dir = tmp();
  const pool = createPool({ size: 1 });
  const reg = createRegistry({ dataDir: dir, pool, getSource: async () => SLIDE_SRC });
  try {
    await reg.start({ gameId: 'an', channelId: 'c', gistId: 'abcd' });
    const slid = await reg.press('an', 'right');
    assert.equal(Buffer.from(slid.gif).toString('latin1', 0, 6), 'GIF89a');
    const plain = await reg.press('an', 'left');
    assert.equal(plain.gif, null);
  } finally { await reg.close(); await pool.close(); }
});

test('a game left in a looping animation is rebuilt into the same state', async () => {
  const dir = tmp();
  const pool = createPool({ size: 1 });
  let reg = createRegistry({ dataDir: dir, pool, getSource: async () => LOOP_SRC });
  await reg.start({ gameId: 'lp', channelId: 'c', gistId: 'abcd' });
  await reg.press('lp', 'right');
  const boom = await reg.press('lp', 'right');
  assert.equal(boom.snapshot.animating, 'loop');
  const ignored = await reg.press('lp', 'left');
  assert.equal(ignored.applied, false);
  assert.deepEqual(reg.get('lp').inputs, ['right', 'right'], 'an ignored move is not recorded');
  await reg.close();
  await pool.drop('lp');
  reg = createRegistry({ dataDir: dir, pool, getSource: async () => LOOP_SRC });
  try {
    reg.loadAll();
    const still = await reg.press('lp', 'left');
    assert.deepEqual([still.applied, still.snapshot.animating], [false, 'loop']);
    const undone = await reg.press('lp', 'undo');
    assert.deepEqual([undone.applied, undone.snapshot.animating], [true, null]);
  } finally { await reg.close(); await pool.close(); }
});

test('a game brought back from its log is loaded as a rebuild, and a new game is not', async () => {
  const dir = tmp();
  const real = createPool({ size: 1 });
  const loads = [];
  const pool = Object.assign({}, real, { load(id, source, seed, level, opts) { loads.push(!!(opts && opts.rebuild)); return real.load(id, source, seed, level, opts); } });
  const reg = createRegistry({ dataDir: dir, pool, getSource });
  try {
    await reg.start({ gameId: 'rb', channelId: 'c', gistId: 'sok' });
    await reg.press('rb', 'right');
    await real.drop('rb');
    await reg.press('rb', 'right');
    assert.deepEqual(loads, [false, true]);
  } finally { await reg.close(); await real.close(); }
});

test('three refused presses in a row stop the game, and a press that works in between starts the count again', async () => {
  const dir = tmp();
  const real = createPool({ size: 1 });
  const { pool, failNext } = failingOnce(real, 'MoveTooLongError');
  const reg = createRegistry({ dataDir: dir, pool, getSource });
  const refused = async () => { failNext(); await assert.rejects(reg.press('st', 'up'), (e) => e.name === 'MoveTooLongError'); };
  try {
    await reg.start({ gameId: 'st', channelId: 'c', gistId: 'sok' });
    await refused(); await refused();
    assert.equal((await reg.press('st', 'right')).applied, true);
    await refused(); await refused();
    assert.equal(reg.get('st').status, 'playing');
    failNext();
    await assert.rejects(reg.press('st', 'up'), (e) => e.name === 'EngineError' && /kept taking too long/.test(e.message));
    const rec = reg.get('st');
    assert.equal(rec.status, 'dead');
    assert.match(rec.deadReason, /kept taking too long/);
    assert.deepEqual(rec.inputs, ['right']);
    const after = await reg.press('st', 'right');
    assert.deepEqual([after.applied, after.snapshot.kind], [false, 'message']);
  } finally { await reg.close(); await real.close(); }
});

test('a game the pool has lost track of is rebuilt on the next press', async () => {
  const dir = tmp();
  const real = createPool({ size: 1 });
  let lose = false;
  const pool = Object.assign({}, real, {
    async play(id, action, opts) {
      if (!lose) return real.play(id, action, opts);
      lose = false;
      throw Object.assign(new Error('no such game'), { name: 'NoGameError' });
    },
  });
  const reg = createRegistry({ dataDir: dir, pool, getSource });
  try {
    await reg.start({ gameId: 'ng', channelId: 'c', gistId: 'sok' });
    await reg.press('ng', 'right');
    lose = true;
    await assert.rejects(reg.press('ng', 'right'), (e) => e.name === 'EvictedError', 'the player is asked to press again, not told the game is gone');
    assert.equal(real.has('ng'), false, 'the copy that could not be trusted was dropped');
    const r = await reg.press('ng', 'right');
    assert.deepEqual([r.applied, r.record.inputs], [true, ['right', 'right']]);
  } finally { await reg.close(); await real.close(); }
});
