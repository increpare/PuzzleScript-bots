'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { createPool } = require('../pool');

const SOKOBAN = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'demo', 'sokoban_basic.txt'), 'utf8');

test('load, input and snapshot through a worker', async () => {
  const pool = createPool({ size: 1 });
  try {
    const meta = await pool.load('g1', SOKOBAN, 'seed', 0);
    assert.equal(meta.title, 'Simple Block Pushing Game');
    const before = await pool.snapshot('g1');
    assert.equal(before.kind, 'level');
    assert.equal(await pool.input('g1', 'right'), true);
    const after = await pool.snapshot('g1');
    assert.notDeepEqual(after.cells, before.cells);
    assert.equal(pool.has('g1'), true);
    await pool.drop('g1');
    assert.equal(pool.has('g1'), false);
  } finally { await pool.close(); }
});

test('compile errors reject with CompileError name', async () => {
  const pool = createPool({ size: 1 });
  try {
    await assert.rejects(pool.load('bad', 'title nope\n\n=======\nRULES\n=======\n[ Foo ] -> [ ]\n', 'seed', 0), (e) => e.name === 'CompileError');
    assert.equal(pool.has('bad'), false);
  } finally { await pool.close(); }
});

test('a call over its deadline kills the worker and evicts its games', async () => {
  const evicted = [];
  const pool = createPool({ size: 1, inputMs: 200, onEvicted: (ids) => evicted.push(...ids) });
  try {
    await pool.load('a', SOKOBAN, 'seed', 0);
    await pool.load('b', SOKOBAN, 'seed', 0);
    await assert.rejects(pool._call('a', '__spin', { ms: 2000 }, 200), (e) => e.name === 'TimeoutError');
    assert.equal(pool.has('a'), false);
    assert.equal(pool.has('b'), false);
    assert.deepEqual(evicted.sort(), ['b']);
    // pool still works after replacement
    const meta = await pool.load('c', SOKOBAN, 'seed', 0);
    assert.equal(meta.levelCount >= 1, true);
  } finally { await pool.close(); }
});

test('a call queued behind a long call is not charged for the wait', async () => {
  const pool = createPool({ size: 1, inputMs: 300 });
  try {
    await pool.load('a', SOKOBAN, 'seed', 0);
    await pool.load('b', SOKOBAN, 'seed', 0);
    const slow = pool._call('a', '__spin', { ms: 600 }, 1000); // within its own budget
    const fast = pool.snapshot('b'); // queued behind slow; its 300 ms budget must start when it is sent
    await slow;
    const s = await fast;
    assert.equal(s.kind, 'level');
    assert.equal(pool.has('a'), true);
    assert.equal(pool.has('b'), true);
  } finally { await pool.close(); }
});

test('close rejects in-flight calls promptly', async () => {
  const pool = createPool({ size: 1, inputMs: 5000 });
  await pool.load('a', SOKOBAN, 'seed', 0);
  const inflight = pool._call('a', '__spin', { ms: 3000 }, 5000);
  const rejected = assert.rejects(inflight, (e) => e.name === 'PoolClosedError'); // attach handler before close
  const t0 = Date.now();
  await pool.close();
  await rejected;
  assert.ok(Date.now() - t0 < 1000, 'close did not wait for the spin');
});

test('tiles returns the frame sprites through a worker', async () => {
  const pool = createPool({ size: 1 });
  try {
    await pool.load('g1', SOKOBAN, 'seed', 0);
    const t = await pool.tiles('g1');
    assert.deepEqual(t.wall.colors, ['#a46422', '#493c2b']);
    assert.equal(t.player.dat.length, 5);
    assert.throws(() => pool.tiles('nope'), (e) => e.name === 'NoGameError');
  } finally { await pool.close(); }
});

const SLIDE = fs.readFileSync(path.join(__dirname, 'fixtures', 'again-slide.txt'), 'utf8');

test('a long job made of quick steps outlives the per-step limit', async () => {
  const pool = createPool({ size: 1, inputMs: 400 });
  try {
    await pool.load('a', SOKOBAN, 'seed', 0);
    const t0 = Date.now();
    await pool._call('a', '__steps', { count: 16, ms: 50 }, 400); // 800 ms of work, never 400 ms without progress
    assert.ok(Date.now() - t0 >= 700);
    assert.equal(pool.has('a'), true, 'the game was not evicted');
  } finally { await pool.close(); }
});

test('play makes a move and returns the new picture, with an animation when the move ran on', async () => {
  const pool = createPool({ size: 1 });
  try {
    await pool.load('s', SLIDE, 'seed', 0);
    const r = await pool.play('s', 'right', { animate: true });
    assert.equal(r.applied, true);
    assert.equal(r.snapshot.kind, 'level');
    assert.equal(Buffer.from(r.gif).toString('latin1', 0, 6), 'GIF89a');
    const plain = await pool.play('s', 'left', { animate: true });
    assert.equal(plain.applied, true);
    assert.equal(plain.gif, null, 'a single turn has no animation');
    const ignored = await pool.play('s', 'continue', { animate: true });
    assert.deepEqual([ignored.applied, ignored.gif], [false, null]);
  } finally { await pool.close(); }
});

test('play without animate returns no animation', async () => {
  const pool = createPool({ size: 1 });
  try {
    await pool.load('s', SLIDE, 'seed', 0);
    const r = await pool.play('s', 'right');
    assert.deepEqual([r.applied, r.gif], [true, null]);
  } finally { await pool.close(); }
});

test('a move over the time budget is refused without killing the worker, and its half-played game is discarded', async () => {
  const evicted = [];
  const pool = createPool({ size: 1, totalMs: -1, onEvicted: (ids) => evicted.push(...ids) });
  try {
    await pool.load('slow', SLIDE, 'seed', 0);
    await pool.load('other', SOKOBAN, 'seed', 0);
    await assert.rejects(pool.play('slow', 'right'), (e) => e.name === 'MoveTooLongError');
    assert.equal((await pool.snapshot('other')).kind, 'level', 'the other game on the worker is untouched');
    assert.deepEqual(evicted, []);
    await assert.rejects(pool.play('slow', 'left'), (e) => e.name === 'NoGameError');
  } finally { await pool.close(); }
});
