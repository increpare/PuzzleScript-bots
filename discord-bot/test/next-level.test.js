'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHost } = require('../engine-host');
const { createPushingItHost } = require('../pushing-it-host');
const { createPool } = require('../pool');
const { createRegistry } = require('../games');
const { buildComponents, buildEmbed, typedShortfall } = require('../presentation');
const { buildAnimation } = require('../animation');
const { decodeGIF } = require('../gif');
const fixture = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');
const TWO = fixture('two-level-random.txt');
const manual = { manualAdvanceFrom: 0 };

test('a solved level stays visible and only continue can leave it', () => {
  const host = createHost();
  host.load(TWO, 'seed', 0, manual);
  host.input('right', { capture: true });
  const solved = host.snapshot();
  assert.equal(solved.levelIndex, 0);
  assert.equal(solved.kind, 'level');
  assert.equal(solved.won, true);
  for (const action of ['right', 'left', 'undo', 'restart', 'action']) assert.equal(host.input(action), false);
  host.tick();
  assert.deepEqual(host.snapshot(), solved);
  assert.equal(host.input('continue'), true);
  assert.equal(host.snapshot().levelIndex, 1);
  assert.equal(host.snapshot().won, false);
});

test('a winning again chain retains its final frame and waits before a message', () => {
  const source = fixture('again-slide.txt').replace('[ Sliding ] -> [ right Sliding ] again',
    '[ Sliding ] -> [ right Sliding ] again\nright [ Sliding | Wall ] -> [ Puck | Wall ] win') + '\nmessage next screen\n';
  const host = createHost();
  host.load(source, 'seed', 0, manual);
  host.input('right', { capture: true });
  const solved = host.snapshot(), frames = host.takeFrames();
  assert.equal(solved.won, true);
  assert.equal(solved.kind, 'level');
  assert.equal(solved.levelIndex, 0);
  assert.ok(frames.list.length > 2);
  assert.ok(frames.list.every((f) => f.kind === 'level' && f.width === 9));
  const final = frames.list.at(-1);
  for (let i = 0; i < solved.cells.length; i++) {
    const ids = solved.cells[i];
    for (const id of ids) assert.ok(final.objects[i] & (1 << id));
  }
  const gif = decodeGIF(buildAnimation({ base: solved, frames }));
  assert.equal(gif.loop, false);
  assert.ok(gif.frames.length > 2, 'the ending is returned as a playable animation');
  host.input('continue');
  assert.equal(host.snapshot().message, 'next screen');
});

test('the last level waits on its solved board before finishing', () => {
  const host = createHost();
  host.load(TWO.slice(0, TWO.indexOf('\nCCCCCCCCCC')), 'seed', 0, manual);
  host.input('right');
  assert.equal(host.snapshot().won, true);
  assert.equal(host.snapshot().kind, 'level');
  host.input('continue');
  assert.equal(host.snapshot().kind, 'finished');
});

test('typed moves stop on the winning move and replay includes explicit next-level presses', () => {
  const host = createHost(), replayed = createHost();
  host.load(TWO, 'seed', 0, manual);
  replayed.load(TWO, 'seed', 0, manual);
  assert.equal(host.run(['right', 'left', 'undo']), 1);
  assert.equal(host.snapshot().won, true);
  replayed.replay(['right']);
  assert.deepEqual(replayed.snapshot(), host.snapshot());
  host.input('continue'); host.input('left');
  replayed.replay(['continue', 'left']);
  assert.deepEqual(replayed.snapshot(), host.snapshot());
});

test('historical automatic inputs replay before switching to explicit advancement', () => {
  const host = createHost(), legacy = createHost();
  legacy.load(TWO, 'seed', 0);
  legacy.replay(['right', 'left']);
  host.load(TWO, 'seed', 0, { manualAdvanceFrom: 2 });
  host.replay(['right', 'left']);
  assert.deepEqual(host.snapshot(), legacy.snapshot());
  host.input('right');
  assert.equal(host.snapshot().levelIndex, 1);
  assert.equal(host.snapshot().won, true);
});

test('historical opening animations retain automatic wins while new openings can wait', () => {
  const source = fixture('again-slide.txt')
    .replace('author test', 'author test\nrun_rules_on_level_start')
    .replace('K = Puck', 'K = Sliding')
    .replace('[ Sliding ] -> [ right Sliding ] again', '[ Sliding ] -> [ right Sliding ] again\nright [ Sliding | Wall ] -> [ Puck | Wall ] win')
    + '\nmessage next screen\n';
  for (const boundary of [0, 2]) {
    const host = createHost();
    host.load(source, 'seed', 0, { manualAdvanceFrom: boundary, legacyStartup: true });
    assert.equal(host.snapshot().kind, 'message');
    assert.equal(host.snapshot().levelIndex, 1);
  }
  const fresh = createHost();
  fresh.load(source, 'seed', 0, manual);
  assert.equal(fresh.snapshot().kind, 'level');
  assert.equal(fresh.snapshot().won, true);
});

test('the solved board offers a labeled next-level button and names its solver', () => {
  const snapshot = { kind: 'level', won: true, levelNumber: 1, realLevelCount: 2 };
  const rows = buildComponents(snapshot, { flags: {} }, { tweak: true }).map((r) => r.toJSON());
  assert.equal(rows.length, 1);
  assert.equal(rows[0].components.length, 1);
  assert.equal(rows[0].components[0].custom_id, 'ps:continue');
  assert.equal(rows[0].components[0].label, 'Next level');
  const paused = buildComponents({ ...snapshot, animating: 'more' }, { flags: {} })[0].toJSON().components;
  assert.equal(paused.length, 1);
  assert.equal(paused[0].label, 'Continue animation');
  const embed = buildEmbed({ record: { status: 'playing', lastMover: 'Ada' }, snapshot, attachmentName: 'ending.gif' }).toJSON();
  assert.match(embed.footer.text, /Level 1 of 2.*Solved by Ada/);
  assert.equal(embed.image.url, 'attachment://ending.gif');
  assert.match(typedShortfall({ made: 0, asked: 3, snapshot, solved: false }), /the level was solved there/);
});

test('Discord persists the solved board, credits the winner, and gives no credit to Next level', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-next-level-'));
  const pool = createPool({ size: 1 });
  let reg = createRegistry({ dataDir, pool, getSource: async () => TWO });
  t.after(async () => { await reg.close(); await pool.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  await reg.start({ gameId: 'next', channelId: 'c', gistId: 'g' });
  const win = await reg.run('next', ['right', 'left'], 'Ada');
  assert.equal(win.made, 1);
  assert.equal(win.solvedLevel, 0);
  assert.equal(win.snapshot.won, true);
  await reg.close(); await pool.drop('next');
  reg = createRegistry({ dataDir, pool, getSource: async () => TWO });
  reg.loadAll();
  const blocked = await reg.press('next', 'left', 'Bob');
  assert.equal(blocked.applied, false);
  assert.equal(blocked.snapshot.won, true);
  const next = await reg.press('next', 'continue', 'Bob');
  assert.equal(next.solvedLevel, null);
  assert.equal(next.snapshot.levelIndex, 1);
  assert.equal(next.record.lastMover, 'Ada');
  assert.deepEqual(next.record.inputs, ['right', 'continue']);
});

test('Discord upgrades an old input log without replaying its wins as new pauses', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-old-next-level-'));
  const pool = createPool({ size: 1 });
  let reg = createRegistry({ dataDir, pool, getSource: async () => TWO });
  t.after(async () => { await reg.close(); await pool.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  await reg.start({ gameId: 'old', channelId: 'c', gistId: 'g' });
  await reg.close(); await pool.drop('old');
  const file = path.join(dataDir, 'games', 'old.json');
  const old = JSON.parse(fs.readFileSync(file, 'utf8'));
  delete old.manualAdvanceFrom;
  old.inputs = ['right', 'left'];
  old.cur = { kind: 'level', levelIndex: 1 };
  fs.writeFileSync(file, JSON.stringify(old));
  reg = createRegistry({ dataDir, pool, getSource: async () => TWO });
  reg.loadAll();
  const win = await reg.press('old', 'right', 'Ada');
  assert.equal(win.snapshot.levelIndex, 1);
  assert.equal(win.snapshot.won, true);
  assert.equal(win.solvedLevel, 1);
  assert.equal(win.record.manualAdvanceFrom, 2);
  await pool.drop('old');
  const next = await reg.press('old', 'continue', 'Bob');
  assert.equal(next.snapshot.kind, 'finished');
  assert.equal(next.solvedLevel, null);
  assert.equal(next.record.lastMover, 'Ada');
});

test('a real Pushing It solution stops on its ending and replays to the same raster', () => {
  const source = fs.readFileSync(path.join(__dirname, '../legacy/pushing-it/script.txt'), 'utf8');
  const moves = Array.from('dddrddlddrrruuluuuddrluuuurrrrddrdddduu', (c) => ({ u: 'up', d: 'down', l: 'left', r: 'right' }[c]));
  const host = createPushingItHost(), restored = createPushingItHost();
  try {
    host.load(source, 'seed', 0, manual);
    restored.load(source, 'seed', 0, manual);
    assert.equal(host.run([...moves, 'right']), moves.length);
    assert.equal(host.snapshot().won, true);
    assert.equal(host.snapshot().levelIndex, 0);
    restored.replay(moves);
    assert.ok(Buffer.from(host.snapshot().raster.rgba).equals(Buffer.from(restored.snapshot().raster.rgba)));
    host.input('continue'); restored.replay(['continue']);
    assert.equal(host.snapshot().levelIndex, 1);
    assert.ok(Buffer.from(host.snapshot().raster.rgba).equals(Buffer.from(restored.snapshot().raster.rgba)));
  } finally { host.dispose(); restored.dispose(); }
});

test('Pushing It retains its solved raster until the next-level press, including the final level', () => {
  const source = fs.readFileSync(path.join(__dirname, '../legacy/pushing-it/script.txt'), 'utf8');
  for (const index of [0, 11]) {
    const host = createPushingItHost();
    host.load(source, 'seed', index, manual);
    const c = host._ctx;
    c.myall.box[0].x = c.myall.target[0].x;
    c.myall.box[0].y = c.myall.target[0].y;
    host.input('action', { capture: true });
    assert.equal(host.snapshot().levelIndex, index);
    assert.equal(host.snapshot().won, true);
    assert.equal(host.snapshot().kind, 'level');
    assert.equal(host.snapshot().animating, null);
    assert.ok(host.snapshot().raster);
    assert.equal(host.input('down'), false);
    host.input('continue');
    assert.equal(host.snapshot().kind, index === 11 ? 'finished' : 'level');
    if (index === 0) assert.equal(host.snapshot().levelIndex, 1);
    host.dispose();
  }
});

test('Pushing It finishes pending animation timers before Next level can advance', () => {
  const source = fs.readFileSync(path.join(__dirname, '../legacy/pushing-it/script.txt'), 'utf8');
  const host = createPushingItHost({ stepCap: 1 });
  try {
    host.load(source, 'seed', 0, manual);
    const c = host._ctx;
    c.myall.box[0].x = c.myall.target[0].x;
    c.myall.box[0].y = c.myall.target[0].y;
    let ran = 0;
    for (let n = 1; n <= 3; n++) c.setTimeout(() => { ran++; c.draw(); }, n * 40);
    host.input('continue');
    assert.equal(host.snapshot().won, true);
    assert.equal(host.snapshot().animating, 'more');
    assert.equal(host.snapshot().levelIndex, 0);
    host.input('continue'); host.input('continue');
    assert.equal(ran, 3);
    assert.equal(host.snapshot().animating, null);
    assert.equal(host.snapshot().levelIndex, 0);
    host.input('continue');
    assert.equal(host.snapshot().levelIndex, 1);
  } finally { host.dispose(); }
});
