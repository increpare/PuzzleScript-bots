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

const FIXTURE = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');

test('moving the player changes the level string', () => {
  const host = createHost();
  host.load(SOKOBAN, 'seed', 0);
  const before = host.levelString();
  assert.equal(host.input('right'), true);
  assert.notEqual(host.levelString(), before);
  assert.equal(host.input('undo'), true);
  assert.equal(host.levelString(), before);
  host.dispose();
});

test('restart returns to the level start', () => {
  const host = createHost();
  host.load(SOKOBAN, 'seed', 0);
  const before = host.levelString();
  host.input('right'); host.input('right'); host.input('up');
  host.input('restart');
  assert.equal(host.levelString(), before);
  host.dispose();
});

test('message levels require continue, then play resumes', () => {
  const host = createHost();
  const meta = host.load(FIXTURE('message-game.txt'), 'seed', 0);
  assert.equal(meta.levelCount, 3);
  assert.equal(host.snapshot().kind, 'message');
  assert.equal(host.snapshot().message, 'welcome to the message game');
  assert.equal(host.input('right'), false, 'directions are ignored on a message');
  assert.equal(host.input('continue'), true);
  assert.equal(host.snapshot().kind, 'level');
  assert.equal(host.snapshot().levelIndex, 1);
  host.dispose();
});

test('in-rule messages show as an overlay and continue clears them', () => {
  const host = createHost();
  host.load(FIXTURE('message-game.txt'), 'seed', 1);
  host.input('right'); // pushes onto the switch, fires message
  const s = host.snapshot();
  assert.equal(s.kind, 'message');
  assert.equal(s.message, 'you pressed it');
  assert.equal(host.input('continue'), true);
  assert.equal(host.snapshot().kind, 'level');
  assert.equal(host.snapshot().levelIndex, 1);
  host.dispose();
});

test('winning the last level reports finished', () => {
  const host = createHost();
  host.load(FIXTURE('message-game.txt'), 'seed', 1);
  host.input('right'); host.input('continue'); host.input('right'); host.input('right');
  // level 1 won -> level 2 is a message -> continue -> past the end
  assert.equal(host.snapshot().kind, 'message');
  host.input('continue');
  assert.equal(host.snapshot().kind, 'finished');
  assert.equal(host.input('right'), false);
  host.dispose();
});

test('noaction games ignore the action input', () => {
  const host = createHost();
  const src = SOKOBAN.replace('homepage www.puzzlescript.net', 'homepage www.puzzlescript.net\nnoaction');
  const meta = host.load(src, 'seed', 0);
  assert.equal(meta.flags.noaction, true);
  assert.equal(host.input('action'), false);
  host.dispose();
});

test('replay is deterministic across level transitions for random games', () => {
  const run = () => {
    const host = createHost();
    host.load(FIXTURE('two-level-random.txt'), 'fixed-seed', 0);
    host.input('right'); // wins level 1, loads level 2 (random coin removal happens per move)
    host.input('left'); host.input('right'); host.input('left');
    const out = host.levelString();
    host.dispose();
    return out;
  };
  assert.equal(run(), run());
});

test('host matches the engine test harness on recorded sessions', () => {
  // Load testdata.js the same way the harness does: it declares a top-level array.
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'tests', 'resources', 'testdata.js'), 'utf8');
  const sandbox = {};
  require('node:vm').runInNewContext(src + '\n;this.__testdata = testdata;', sandbox);
  const testdata = sandbox.__testdata;
  assert.ok(testdata.length > 100);
  let checked = 0;
  for (const [name, dat] of testdata) {
    const [source, inputs, expected, targetLevel, seed] = dat;
    if (/realtime_interval/.test(source)) continue;
    const host = createHost();
    try {
      host.load(source, seed === undefined || seed === null ? 'seed' : seed, targetLevel === undefined ? 0 : targetLevel);
      for (const v of inputs) {
        if (v === 'undo') host.input('undo');
        else if (v === 'restart') host.input('restart');
        else if (v === 'tick') host.tick();
        else host._rawInput(v);
      }
      assert.equal(host.levelString(), expected, 'mismatch in test "' + name + '"');
      checked++;
    } catch (e) {
      if (e instanceof CompileError) continue; // harness compile-error cases are not play sessions
      throw e;
    } finally { host.dispose(); }
  }
  assert.ok(checked > 300, 'expected most sessions to be checked, got ' + checked);
});

test('flickscreen viewport is the page containing the player', () => {
  const host = createHost();
  const src = SOKOBAN.replace('homepage www.puzzlescript.net', 'homepage www.puzzlescript.net\nflickscreen 4x4');
  host.load(src, 'seed', 0);
  const s = host.snapshot();
  assert.equal(s.viewport.w <= 4 && s.viewport.h <= 4, true);
  assert.equal(s.viewport.x % 4, 0);
  assert.equal(s.viewport.y % 4, 0);
  host.dispose();
});
