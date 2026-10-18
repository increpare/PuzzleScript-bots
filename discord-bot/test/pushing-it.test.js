'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createOps } = require('../worker-ops');
const { createGistStore } = require('../gists');
const { sha256 } = require('../sources');
const { renderSnapshot } = require('../renderer');
const { decodePNG } = require('../png');
const { decodeGIF } = require('../gif');
const { createPushingItHost } = require('../pushing-it-host');
const { createPool } = require('../pool');
const { createRegistry } = require('../games');
const { buildComponents } = require('../presentation');

const GIST = '2fe3172d2b9fe684977d184f1b6226d5';
const SOURCE = fs.readFileSync(path.join(__dirname, '../legacy/pushing-it/script.txt'), 'utf8');
const FIRST_SOLUTION = Array.from('dddrddlddrrruuluuuddrluuuurrrrddrdddduu', (c) => ({ u: 'up', d: 'down', l: 'left', r: 'right' }[c]));
const load = (handle, gameId = 'jack', levelIndex = 0) => handle({ op: 'load', gameId, args: { source: SOURCE, seed: 'seed', levelIndex } });
const snap = (handle, gameId = 'jack') => handle({ op: 'snapshot', gameId, args: {} });
const press = (handle, action, gameId = 'jack') => handle({ op: 'play', gameId, args: { action, animate: true } });

test('the preserved game is Jack Lance’s unmodified published source', () => {
  assert.equal(sha256(SOURCE), 'c7c54bd07ead0d24de38bda35d093e3daf1cb9d50ba724e997d3efdc719db3a0');
});

test('the original gist starts offline from the preserved source', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pushing-it-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const store = createGistStore({ dataDir, token: '', fetchImpl: async () => { throw new Error('offline'); } });
  assert.equal(await store.getSource(GIST), SOURCE);
});

test('workers load the twelve real levels instead of the one-level decoy', () => {
  const handle = createOps();
  const meta = load(handle);
  assert.equal(meta.title, 'Pushing It');
  assert.equal(meta.author, 'Jack Lance');
  assert.equal(meta.levelCount, 12);
  assert.deepEqual(meta.realLevels, Array.from({ length: 12 }, (_, i) => i));
  assert.equal(meta.flags.uneditable, true);
  for (let i = 0; i < 12; i++) {
    load(handle, 'jack', i);
    const s = snap(handle);
    assert.equal(s.kind, 'level');
    assert.equal(s.levelIndex, i);
    assert.equal(s.realLevelCount, 12);
    assert.equal(s.raster.rgba.length, 400 * 300 * 4);
  }
});

test('original movement, undo and restart are rendered through the regular worker path', () => {
  const handle = createOps();
  load(handle);
  const original = renderSnapshot(snap(handle)).png;
  const moved = press(handle, 'down');
  assert.equal(moved.applied, true);
  assert.notDeepEqual(renderSnapshot(moved.snapshot).png, original);
  assert.equal(moved.snapshot.animating, null);
  assert.deepEqual(renderSnapshot(press(handle, 'undo').snapshot).png, original);
  press(handle, 'down');
  const restarted = decodePNG(renderSnapshot(press(handle, 'restart').snapshot).png);
  const image = decodePNG(original);
  // Jack's restart retains the player's facing sprite. Compare the board outside that tile.
  for (let y = 30; y < 60; y++) {
    image.rgba.fill(0, (y * 400 + 65) * 4, (y * 400 + 95) * 4);
    restarted.rgba.fill(0, (y * 400 + 65) * 4, (y * 400 + 95) * 4);
  }
  assert.ok(Buffer.from(restarted.rgba).equals(Buffer.from(image.rgba)), 'restart restores the board');
  assert.deepEqual([image.width, image.height], [400, 300]);
  assert.deepEqual([...image.rgba.slice(0, 4)], [193, 251, 198, 255]);
});

test('piston animations become GIFs with the original forty-millisecond substeps', () => {
  const handle = createOps();
  load(handle);
  for (const action of ['down', 'down', 'down', 'right']) press(handle, action);
  const r = press(handle, 'down');
  assert.equal(r.snapshot.animating, null);
  assert.ok(r.gif, 'the timed piston movement has an animation');
  const gif = decodeGIF(r.gif);
  assert.equal(gif.loop, false);
  assert.ok(gif.frames.length >= 5);
  assert.ok(gif.frames.some((f) => f.delayCs === 4));
});

test('replaying a saved input log reproduces the original game including its timers', () => {
  const handle = createOps();
  load(handle, 'one');
  load(handle, 'two');
  const actions = ['down', 'down', 'down', 'down', 'right', 'undo', 'left'];
  for (const action of actions) press(handle, action, 'one');
  handle({ op: 'apply', gameId: 'two', args: { actions } });
  assert.deepEqual(snap(handle, 'one'), snap(handle, 'two'));
});

test('the original piston code keeps fractional positions and undo restores the complete geometry', () => {
  const host = createPushingItHost();
  host.load(SOURCE, 'seed', 0);
  host.run(['down', 'down', 'down', 'right']);
  const before = JSON.stringify(host._ctx.getstate());
  host.input('down', { capture: true });
  assert.equal(host._ctx.activated, true);
  assert.ok(host._ctx.myall.pusher.some((p) => p.x % 100 === 50 || p.y % 100 === 50));
  assert.ok(host.takeFrames().list.length >= 5);
  host.input('undo');
  assert.equal(JSON.stringify(host._ctx.getstate()), before);
  host.dispose();
});

test('pending timers pause deterministically and continue; undo cancels them', () => {
  const host = createPushingItHost({ stepCap: 1 });
  host.load(SOURCE, 'seed', 0);
  host.run(['down', 'down', 'down', 'right']);
  const before = JSON.stringify(host._ctx.getstate());
  host.input('down');
  assert.equal(host.snapshot().animating, 'more');
  assert.equal(host.input('left'), false);
  host.input('undo');
  assert.equal(host.snapshot().animating, null);
  assert.equal(JSON.stringify(host._ctx.getstate()), before);
  host.input('down');
  let steps = 0;
  while (host.snapshot().animating && steps++ < 30) assert.equal(host.input('continue'), true);
  assert.equal(host.snapshot().animating, null);
  assert.equal(host._ctx.activated, true);
  host.dispose();
});

test('callbacks have a move deadline and worker failure discards the partial game', () => {
  let time = 0, running = false;
  const handle = createOps({ totalMs: 10, now: () => running ? (time += 6) : 0 });
  load(handle);
  for (const action of ['down', 'down', 'down', 'right']) press(handle, action);
  running = true;
  assert.throws(() => press(handle, 'down'), { name: 'MoveTooLongError' });
  assert.throws(() => snap(handle), { name: 'NoGameError' });
});

test('only the verified source can be passed to the custom JavaScript host', () => {
  const host = createPushingItHost();
  assert.throws(() => host.load(SOURCE.replace('Jack Lance', 'someone else'), 'seed', 0), { name: 'CompileError' });
  host.dispose();
});

test('separate custom games keep their geometry and timers to themselves', () => {
  const handle = createOps();
  load(handle, 'one');
  load(handle, 'two');
  const before = renderSnapshot(snap(handle, 'two')).png;
  handle({ op: 'run', gameId: 'one', args: { actions: ['down', 'down', 'down', 'right', 'down'], animate: true } });
  assert.ok(renderSnapshot(snap(handle, 'two')).png.equals(before));
});

test('original win callbacks advance levels and the twelfth win finishes the game', () => {
  const host = createPushingItHost();
  host.load(SOURCE, 'seed', 0);
  // Put the box on the target, then let the original draw/win logic handle the transition.
  const solve = () => {
    const c = host._ctx;
    c.myall.box[0].x = c.myall.target[0].x;
    c.myall.box[0].y = c.myall.target[0].y;
    host.input('action');
  };
  solve();
  assert.equal(host.snapshot().levelIndex, 1);
  assert.equal(host.snapshot().kind, 'level');
  const c = host._ctx;
  c.mylevel = 11;
  c.undostack = [];
  c.loadmylevel();
  c.draw();
  solve();
  assert.equal(host.snapshot().kind, 'finished');
  assert.equal(host.input('down'), false);
  host.dispose();
});

test('a real first-level solution advances, and typed moves stop at that win', () => {
  const handle = createOps();
  load(handle);
  const result = handle({ op: 'run', gameId: 'jack', args: { actions: [...FIRST_SOLUTION, 'right'], animate: true } });
  assert.equal(result.made, FIRST_SOLUTION.length);
  assert.equal(result.snapshot.levelIndex, 1);
  assert.equal(result.snapshot.kind, 'level');
});

test('a persisted custom game rebuilds in a real worker after eviction and restart', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pushing-it-worker-'));
  const pool = createPool({ size: 1 });
  const store = createGistStore({ dataDir, token: '', fetchImpl: async () => { throw new Error('offline'); } });
  let reg = createRegistry({ dataDir, pool, getSource: store.getSource });
  t.after(async () => { await reg.close(); await pool.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  const first = await reg.start({ gameId: 'jack', channelId: 'c', gistId: GIST, startLevelNumber: 10 });
  assert.equal(first.snapshot.levelIndex, 9);
  assert.equal(first.record.meta.levelCount, 12);
  await reg.run('jack', ['down', 'right', 'down'], 'Ada');
  const before = (await pool.snapshot('jack')).raster.rgba;
  await reg.close();
  await pool.drop('jack');
  reg = createRegistry({ dataDir, pool, getSource: store.getSource });
  assert.equal(reg.loadAll(), 1);
  const resumed = await reg.press('jack', 'action', 'Ada');
  assert.ok(Buffer.from(resumed.snapshot.raster.rgba).equals(Buffer.from(before)));
  assert.deepEqual(resumed.record.inputs, ['down', 'right', 'down', 'action']);
});

test('pre-support records get the real metadata before a stale editor button can be handled', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pushing-it-upgrade-'));
  fs.mkdirSync(path.join(dataDir, 'games'));
  const record = { gameId: 'old', gistId: GIST, sourceHash: sha256(SOURCE), seed: 'old', startLevel: 0, inputs: [], status: 'playing', meta: { title: 'Pushing It', author: 'Jack Lance', levelCount: 1, realLevels: [0], flags: {} } };
  fs.writeFileSync(path.join(dataDir, 'games/old.json'), JSON.stringify(record));
  const reg = createRegistry({ dataDir, pool: {}, getSource: async () => SOURCE });
  t.after(async () => { await reg.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  assert.equal(reg.loadAll(), 1);
  const meta = reg.get('old').meta;
  assert.equal(meta.levelCount, 12);
  assert.equal(meta.flags.uneditable, true);
  const ids = buildComponents({ kind: 'level' }, meta, { tweak: true }).flatMap((row) => row.toJSON().components.map((button) => button.custom_id));
  assert.ok(!ids.includes('ps:tweak'));
});
