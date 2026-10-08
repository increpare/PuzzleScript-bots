'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { createPool } = require('../pool');
const { SRC_DIR } = require('../engine-src');

const SOKOBAN = fs.readFileSync(path.join(SRC_DIR, 'demo', 'sokoban_basic.txt'), 'utf8');

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

test('a typed run goes through a worker and comes back with how many moves were made', async () => {
  const pool = createPool({ size: 1 });
  try {
    await pool.load('a', SOKOBAN, 'seed', 0);
    const r = await pool.run('a', ['up', 'up', 'left'], { animate: true });
    assert.deepEqual([r.made, r.snapshot.kind], [3, 'level']);
    assert.equal(Buffer.from(r.gif).toString('latin1', 0, 6), 'GIF89a');
  } finally { await pool.close(); }
});

test('sounds and sprites are made in a worker without any game, and leave its games alone', async () => {
  const pool = createPool({ size: 1 });
  try {
    await pool.load('a', SOKOBAN, 'seed', 0);
    const sound = await pool.sound(9675111);
    assert.equal(Buffer.from(sound.wav).toString('latin1', 0, 4), 'RIFF');
    const drawn = await pool.sprites('Player\nred');
    assert.deepEqual([drawn.ok, drawn.names], [true, ['Player']]);
    assert.equal((await pool.snapshot('a')).kind, 'level');
  } finally { await pool.close(); }
  await assert.rejects(pool.sound(9675111), (e) => e.name === 'PoolClosedError');
  await assert.rejects(pool.sprites('Player\nred'), (e) => e.name === 'PoolClosedError');
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

test('a worker only reports progress to a pool that asked for it', async () => {
  // A pool from before progress reports existed treats every message as a result, and a bot that is
  // still running one may start workers from newer files on disk. Such a worker must stay quiet.
  const { Worker } = require('node:worker_threads');
  const run = (workerData) => new Promise((resolve, reject) => {
    const w = new Worker(path.join(__dirname, '..', 'worker.js'), workerData === undefined ? {} : { workerData });
    const seen = [];
    w.on('error', reject);
    w.on('message', (m) => { seen.push(m); if (!m.progress) w.terminate().then(() => resolve(seen)); });
    w.postMessage({ id: 1, op: '__steps', gameId: 'x', args: { count: 5, ms: 60 } });
  });
  const quiet = await run(undefined);
  assert.deepEqual(quiet.map((m) => !!m.progress), [false]);
  const chatty = await run({ totalMs: 20000, progress: true });
  assert.ok(chatty.some((m) => m.progress === true));
});

test('a job that reported progress and then went quiet is still stopped', async () => {
  const pool = createPool({ size: 1, inputMs: 300 });
  try {
    await pool.load('a', SOKOBAN, 'seed', 0);
    const t0 = Date.now();
    await assert.rejects(pool._call('a', '__steps', { count: 4, ms: 50, thenSilentMs: 3000 }, 300), (e) => e.name === 'TimeoutError');
    assert.ok(Date.now() - t0 < 2000, 'stopped one per-step limit after its last report, not left to finish');
  } finally { await pool.close(); }
});

// Stands in for worker.js: it stays silent for as long as the job asks ("spin 500" as the source,
// the first input or the action), then answers with the job it was given.
const STUB_WORKER = new URL('data:text/javascript,' + encodeURIComponent(`
  import { parentPort } from 'node:worker_threads';
  parentPort.on('message', ({ id, op, args }) => {
    const ask = args.source !== undefined ? args.source : args.actions ? args.actions[0] : args.action;
    const end = Date.now() + (Number(String(ask || '').replace('spin ', '')) || 0);
    while (Date.now() < end) { /* busy wait */ }
    parentPort.postMessage({ id, ok: true, result: { op, args } });
  });
`));

test('rebuilding a game may stay silent three times as long, loading it and replaying its inputs alike', async () => {
  const pool = createPool({ size: 1, compileMs: 300, inputMs: 300, workerFile: STUB_WORKER });
  try {
    const fresh = await pool.load('warm', 'spin 0', 'seed', 0); // also gives the worker time to start
    assert.equal(fresh.args.rebuild, false);
    const rebuilt = await pool.load('g', 'spin 500', 'seed', 0, { rebuild: true });
    assert.equal(rebuilt.args.rebuild, true);
    assert.equal((await pool.apply('g', ['spin 500'])).op, 'apply');
    await assert.rejects(pool.input('g', 'spin 500'), (e) => e.name === 'TimeoutError', 'a live move is held to the usual limit');
    await pool.load('warm', 'spin 0', 'seed', 0, { rebuild: true }); // the replacement worker starting
    await assert.rejects(pool.load('h', 'spin 500', 'seed', 0), (e) => e.name === 'TimeoutError', 'and so is starting a game');
  } finally { await pool.close(); }
});
