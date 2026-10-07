'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { createHost } = require('../../discord-bot/engine-host');
const { renderLevelRGBA } = require('../../discord-bot/renderer');
const { composeFrame, WIDTH, HEIGHT } = require('../frame');

const SOKOBAN = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'demo', 'sokoban_basic.txt'), 'utf8');
const host = createHost();
const META = host.load(SOKOBAN, 'seed', 0);
const SNAP = host.snapshot();
const TILES = host.frameTiles();

const px = (img, x, y) => { const i = (y * img.width + x) * 4; return [img.rgba[i], img.rgba[i + 1], img.rgba[i + 2]]; };
const view = (over) => Object.assign({ snapshot: SNAP, tiles: TILES, meta: META, moves: [], votes: { count: 0, needed: 1 }, music: null }, over);
const same = (a, b) => Buffer.compare(Buffer.from(a.rgba), Buffer.from(b.rgba)) === 0;
// true if a and b differ somewhere, and only inside the rectangle
function differsOnlyIn(a, b, x0, y0, x1, y1) {
  let inside = false;
  for (let y = 0; y < a.height; y++) for (let x = 0; x < a.width; x++) {
    const i = (y * a.width + x) * 4;
    if (a.rgba[i] === b.rgba[i] && a.rgba[i + 1] === b.rgba[i + 1] && a.rgba[i + 2] === b.rgba[i + 2]) continue;
    if (x < x0 || x >= x1 || y < y0 || y >= y1) return false;
    inside = true;
  }
  return inside;
}
const count = (img, rgb, x0, y0, x1, y1) => {
  let n = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const p = px(img, x, y); if (p[0] === rgb[0] && p[1] === rgb[1] && p[2] === rgb[2]) n++; }
  return n;
};

test('the frame is 640x360 and fully opaque', () => {
  const img = composeFrame(view());
  assert.equal(WIDTH, 640);
  assert.equal(HEIGHT, 360);
  assert.equal(img.width, 640);
  assert.equal(img.height, 360);
  assert.equal(img.rgba.length, 640 * 360 * 4);
  for (let i = 3; i < img.rgba.length; i += 4) assert.equal(img.rgba[i], 255);
});

test('without a wall the border is the classic brick', () => {
  const img = composeFrame(view({ tiles: null }));
  assert.deepEqual(px(img, 0, 0), [164, 100, 34]);
  assert.deepEqual(px(img, 6, 0), [73, 60, 43]);
  assert.deepEqual(px(img, 635, 355), px(img, 5, 5));
  assert.deepEqual(px(img, 415, 315), px(img, 5, 5));
});

test('the border uses the game wall over the game background', () => {
  const wall = { colors: ['#ff0000'], dat: [[-1, 0, 0, 0, 0], [0, 0, 0, 0, 0], [0, 0, 0, 0, 0], [0, 0, 0, 0, 0], [0, 0, 0, 0, 0]] };
  const background = { colors: ['#00ff00'], dat: [[0, 0, 0, 0, 0], [0, 0, 0, 0, 0], [0, 0, 0, 0, 0], [0, 0, 0, 0, 0], [0, 0, 0, 0, 0]] };
  const img = composeFrame(view({ tiles: { wall, background, player: null } }));
  assert.deepEqual(px(img, 0, 0), [0, 255, 0]);
  assert.deepEqual(px(img, 2, 0), [255, 0, 0]);
  assert.deepEqual(px(img, 630, 100), [0, 255, 0]);
  assert.deepEqual(px(img, 412, 200), [255, 0, 0]);
  assert.deepEqual(px(img, 200, 312), [255, 0, 0]);
  const noBackground = composeFrame(view({ tiles: { wall, background: null, player: null } }));
  assert.deepEqual(px(noBackground, 0, 0), [0, 0, 0]);
});

test('the game window is the rendered level at (10, 10)', () => {
  const img = composeFrame(view());
  const level = renderLevelRGBA(SNAP);
  for (const [x, y] of [[0, 0], [200, 150], [399, 299], [123, 77], [250, 160]]) assert.deepEqual(px(img, 10 + x, 10 + y), px(level, x, y));
});

test('the heading is drawn in pink and white', () => {
  const img = composeFrame(view());
  assert.ok(count(img, [222, 101, 226], 420, 16, 630, 40) > 100);
  assert.ok(count(img, [255, 255, 255], 420, 42, 630, 66) > 100);
});

test('the title strip shows title, author, level and music', () => {
  const base = composeFrame(view());
  assert.ok(count(base, [255, 255, 255], 10, 320, 410, 334) > 20, 'title');
  assert.ok(count(base, [247, 226, 107], 10, 320, 410, 334) > 20, 'level counter');
  const withMusic = composeFrame(view({ music: { title: 'Reaction', album: 'English Country Tune' } }));
  assert.ok(differsOnlyIn(base, withMusic, 10, 335, 410, 350));
});

test('the level counter follows levelNumber and realLevelCount, falling back to the raw level index', () => {
  const at = (extra) => composeFrame(view({ snapshot: Object.assign({}, SNAP, { levelIndex: 1, levelCount: 4 }, extra) }));
  const numbered = at({ levelNumber: 1, realLevelCount: 3 });
  const other = at({ levelNumber: 2, realLevelCount: 3 });
  assert.ok(differsOnlyIn(numbered, other, 10, 320, 410, 334), 'a different levelNumber draws a different counter');
  assert.ok(differsOnlyIn(numbered, at({ levelNumber: 1, realLevelCount: 9 }), 10, 320, 410, 334), 'a different realLevelCount draws a different counter');
  const legacy = Object.assign({}, SNAP, { levelIndex: 1, levelCount: 4 });
  delete legacy.levelNumber;
  delete legacy.realLevelCount;
  const legacyImg = composeFrame(view({ snapshot: legacy }));
  assert.ok(same(legacyImg, at({ levelNumber: 2, realLevelCount: 4 })), 'without the fields it counts levelIndex + 1 of levelCount');
  assert.ok(differsOnlyIn(legacyImg, numbered, 10, 320, 410, 334), 'the numbered counter is not the raw one');
  assert.ok(same(legacyImg, at({ levelNumber: 0, realLevelCount: 0 })), 'zero counts fall back as well');
});

test('moves appear in the side panel and nowhere else', () => {
  const base = composeFrame(view());
  const one = composeFrame(view({ moves: [{ action: 'up', user: 'pip' }] }));
  assert.ok(differsOnlyIn(base, one, 420, 122, 630, 135));
  const two = composeFrame(view({ moves: [{ action: 'left', user: 'mo' }, { action: 'up', user: 'pip' }] }));
  assert.ok(differsOnlyIn(one, two, 420, 122, 630, 148));
});

test('every action has an icon and long names are cut to fit', () => {
  const moves = ['up', 'down', 'left', 'right', 'action', 'undo', 'restart', 'continue'].map((action) => ({ action, user: 'x'.repeat(60) }));
  const img = composeFrame(view({ moves }));
  assert.ok(differsOnlyIn(composeFrame(view()), img, 420, 122, 630, 226));
});

test('the command list follows the game flags and the skip votes', () => {
  const base = composeFrame(view());
  const noUndo = composeFrame(view({ meta: Object.assign({}, META, { flags: Object.assign({}, META.flags, { noundo: true }) }) }));
  assert.ok(differsOnlyIn(base, noUndo, 420, 284, 630, 350));
  const voted = composeFrame(view({ votes: { count: 1, needed: 3 } }));
  assert.ok(differsOnlyIn(base, voted, 420, 284, 630, 350));
});

test('the player strip is drawn only when the game has a player sprite', () => {
  const withPlayer = composeFrame(view());
  const without = composeFrame(view({ tiles: Object.assign({}, TILES, { player: null }) }));
  assert.ok(differsOnlyIn(withPlayer, without, 455, 76, 595, 96));
});

test('message, finished and back-soon screens compose without a game', () => {
  const message = { kind: 'message', message: 'hello there', levelIndex: 0, levelCount: 3, background: '#000000', textColor: '#ffffff' };
  assert.ok(count(composeFrame(view({ snapshot: message })), [255, 255, 255], 10, 10, 410, 310) > 50);
  const finished = { kind: 'finished', message: null, levelIndex: 3, levelCount: 3, background: '#000000', textColor: '#ffffff' };
  assert.doesNotThrow(() => composeFrame(view({ snapshot: finished })));
  const backSoon = { kind: 'message', message: 'back soon', levelIndex: 0, levelCount: 0, background: '#000000', textColor: '#ffffff' };
  const img = composeFrame({ snapshot: backSoon, tiles: null, meta: null, moves: [], votes: { count: 0, needed: 1 }, music: null });
  assert.equal(count(img, [247, 226, 107], 10, 320, 410, 334), 0, 'no level counter without levels');
});

test('the same view always gives the same picture', () => {
  assert.ok(same(composeFrame(view()), composeFrame(view())));
});

test('a message says how to continue, in the window and in the command list', () => {
  const message = { kind: 'message', message: 'hello there', levelIndex: 0, levelCount: 3, background: '#000000', textColor: '#ffffff' };
  const prompting = composeFrame(view({ snapshot: message }));
  // the last text row of the game window (y 277 to 301) carries the hint, in the message's own colour
  assert.ok(count(prompting, [255, 255, 255], 10, 277, 410, 301) > 100, 'hint under the message');
  // with no game on screen ("back soon") there is nothing to continue
  const idle = composeFrame(view({ snapshot: message, meta: null, tiles: null }));
  assert.equal(count(idle, [255, 255, 255], 10, 277, 410, 301), 0);
  // the command list offers go instead of moves that would do nothing
  const level = composeFrame(view());
  const listPixels = (img) => count(img, [204, 204, 204], 420, 297, 630, 350);
  assert.ok(listPixels(prompting) > 0);
  assert.ok(listPixels(prompting) < listPixels(level) / 3, 'one short word instead of three lines of commands');
});
