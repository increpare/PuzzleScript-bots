// discord-bot/test/renderer.test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { createHost } = require('../engine-host');
const { renderSnapshot, renderLevelRGBA } = require('../renderer');
const { decodePNG } = require('../png');

const SOKOBAN = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'demo', 'sokoban_basic.txt'), 'utf8');

function px(img, x, y) {
  const i = (y * img.width + x) * 4;
  return [img.rgba[i], img.rgba[i + 1], img.rgba[i + 2], img.rgba[i + 3]];
}

test('renders sokoban level 1 with the engine palette', () => {
  const host = createHost();
  host.load(SOKOBAN, 'seed', 0);
  const s = host.snapshot();
  const img = renderLevelRGBA(s);
  const scale = img.width / (s.viewport.w * 5);
  assert.ok(Number.isInteger(scale) && scale >= 1);
  assert.ok(img.width <= 800 && img.height <= 800);
  // Find the wall object and a cell containing it; wall sprite row 0 is "00010" (brown, brown, brown, darkbrown, brown)
  const wallId = Object.keys(s.sprites).map(Number).find((id) => s.sprites[id].colors.includes('#a46422') && s.sprites[id].colors.includes('#493c2b'));
  assert.notEqual(wallId, undefined);
  const cellIndex = s.cells.findIndex((ids) => ids.includes(wallId));
  const cx = (cellIndex / s.height) | 0, cy = cellIndex % s.height;
  const ox = (cx - s.viewport.x) * 5 * scale, oy = (cy - s.viewport.y) * 5 * scale;
  assert.deepEqual(px(img, ox + 0 * scale, oy), [0xa4, 0x64, 0x22, 255]); // brown
  assert.deepEqual(px(img, ox + 3 * scale, oy), [0x49, 0x3c, 0x2b, 255]); // darkbrown
  host.dispose();
});

test('renderSnapshot produces a PNG of the right size', () => {
  const host = createHost();
  host.load(SOKOBAN, 'seed', 0);
  const s = host.snapshot();
  const out = renderSnapshot(s);
  const back = decodePNG(out.png);
  assert.equal(back.width, out.width);
  assert.equal(back.height, out.height);
  assert.equal(back.width % (s.viewport.w * 5), 0);
  host.dispose();
});

test('zoomscreen viewport crops to the window around the player', () => {
  const src = SOKOBAN.replace('homepage www.puzzlescript.net', 'homepage www.puzzlescript.net\nzoomscreen 3x3');
  const host = createHost();
  host.load(src, 'seed', 0);
  const s = host.snapshot();
  assert.deepEqual([s.viewport.w, s.viewport.h], [3, 3]);
  const img = renderLevelRGBA(s);
  assert.equal(img.width / img.height, 1);
  host.dispose();
});

const { renderTextRGBA } = require('../renderer');

test('message frames render text in the text colour on the background', () => {
  const s = { kind: 'message', message: 'hello', background: '#000000', textColor: '#ffffff', levelIndex: 0, levelCount: 1 };
  const img = renderTextRGBA(s);
  assert.equal(img.width, 34 * 6 * 3);
  assert.equal(img.height, 13 * 13 * 3); // 13 rows * 13 px per row * scale 3
  let white = 0, black = 0;
  for (let i = 0; i < img.rgba.length; i += 4) {
    if (img.rgba[i] === 255 && img.rgba[i + 1] === 255 && img.rgba[i + 2] === 255) white++;
    else if (img.rgba[i] === 0 && img.rgba[i + 1] === 0 && img.rgba[i + 2] === 0) black++;
  }
  assert.ok(white > 50, 'expected some ink');
  assert.ok(black > white, 'mostly background');
});

test('the glyph for "h" lands on row 5 (centre) for a one-line message', () => {
  const s = { kind: 'message', message: 'h', background: '#000000', textColor: '#ffffff' };
  const img = renderTextRGBA(s);
  const scale = 3;
  const col = Math.floor((34 - 1) / 2);
  const row = 5;
  // check that at least one ink pixel exists inside that character cell and none in row 0
  let inkInCell = 0, inkRow0 = 0;
  for (let y = 0; y < 13 * scale; y++) for (let x = 0; x < 6 * scale; x++) {
    const i = (((row * 13 * scale) + y) * img.width + (col * 6 * scale + x)) * 4;
    if (img.rgba[i] === 255) inkInCell++;
    const j = ((y) * img.width + (col * 6 * scale + x)) * 4;
    if (img.rgba[j] === 255) inkRow0++;
  }
  assert.ok(inkInCell > 0);
  assert.equal(inkRow0, 0);
});

test('finished frames render', () => {
  const out = renderSnapshot({ kind: 'finished', background: '#101010', textColor: '#ffffff' });
  assert.ok(out.png.length > 100);
});

test('parseHex expands short hex', () => {
  const { parseHex } = require('../renderer');
  assert.deepEqual(parseHex('#f00'), [255, 0, 0, 255]);
});

test('coincounter renders without magenta fallback pixels', () => {
  const host = createHost();
  host.load(fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'demo', 'coincounter.txt'), 'utf8'), 'seed', 0);
  const img = renderLevelRGBA(host.snapshot());
  for (let i = 0; i < img.rgba.length; i += 4) {
    assert.ok(!(img.rgba[i] === 255 && img.rgba[i + 1] === 0 && img.rgba[i + 2] === 255), 'magenta pixel at ' + i / 4);
  }
});

test('huge viewports render in block mode within 800px', () => {
  const n = 400;
  const dat = [0, 1, 2, 3, 4].map(() => [0, 0, 0, 0, 0]);
  const s = {
    kind: 'level', width: n, height: n, viewport: { x: 0, y: 0, w: n, h: n }, background: '#000000',
    sprites: { 0: { dat, colors: ['#123456'] } },
    cells: Array.from({ length: n * n }, () => [0]),
  };
  const img = renderLevelRGBA(s);
  assert.ok(img.width <= 800 && img.height <= 800);
  assert.deepEqual(px(img, img.width >> 1, img.height >> 1), [0x12, 0x34, 0x56, 255]);
});
