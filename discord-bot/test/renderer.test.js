// discord-bot/test/renderer.test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { createHost } = require('../engine-host');
const { renderSnapshot, renderLevelRGBA, levelLayout } = require('../renderer');
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
  const { scale, ox0, oy0, mode } = levelLayout(s);
  assert.equal(mode, 'sprite');
  assert.ok(Number.isInteger(scale) && scale >= 1);
  assert.equal(scale, Math.max(1, Math.floor(Math.min(400 / (5 * s.viewport.w), 300 / (5 * s.viewport.h)))));
  assert.equal(ox0, Math.floor((400 - s.viewport.w * 5 * scale) / 2));
  assert.equal(oy0, Math.floor((300 - s.viewport.h * 5 * scale) / 2));
  assert.equal(img.width, 400);
  assert.equal(img.height, 300);
  // Find the wall object and a cell containing it; wall sprite row 0 is "00010" (brown, brown, brown, darkbrown, brown)
  const wallId = Object.keys(s.sprites).map(Number).find((id) => s.sprites[id].colors.includes('#a46422') && s.sprites[id].colors.includes('#493c2b'));
  assert.notEqual(wallId, undefined);
  const cellIndex = s.cells.findIndex((ids) => ids.includes(wallId));
  const cx = (cellIndex / s.height) | 0, cy = cellIndex % s.height;
  const ox = ox0 + (cx - s.viewport.x) * 5 * scale, oy = oy0 + (cy - s.viewport.y) * 5 * scale;
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
  assert.equal(back.width, 400);
  assert.equal(back.height, 300);
  host.dispose();
});

test('zoomscreen viewport crops to the window around the player', () => {
  const src = SOKOBAN.replace('homepage www.puzzlescript.net', 'homepage www.puzzlescript.net\nzoomscreen 3x3');
  const host = createHost();
  host.load(src, 'seed', 0);
  const s = host.snapshot();
  assert.deepEqual([s.viewport.w, s.viewport.h], [3, 3]);
  const img = renderLevelRGBA(s);
  assert.equal(img.width, 400);
  assert.equal(img.height, 300);
  host.dispose();
});

const { renderTextRGBA } = require('../renderer');

test('message frames render text in the text colour on the background', () => {
  const s = { kind: 'message', message: 'hello', background: '#000000', textColor: '#ffffff', levelIndex: 0, levelCount: 1 };
  const img = renderTextRGBA(s);
  assert.equal(img.width, 400);
  assert.equal(img.height, 300);
  let white = 0, black = 0;
  for (let i = 0; i < img.rgba.length; i += 4) {
    if (img.rgba[i] === 255 && img.rgba[i + 1] === 255 && img.rgba[i + 2] === 255) white++;
    else if (img.rgba[i] === 0 && img.rgba[i + 1] === 0 && img.rgba[i + 2] === 0) black++;
  }
  assert.ok(white >= 50, 'expected some ink');
  assert.ok(black > white, 'mostly background');
});

test('the glyph for "h" lands on row 4 (centre) for a one-line message', () => {
  const s = { kind: 'message', message: 'h', background: '#000000', textColor: '#ffffff' };
  const img = renderTextRGBA(s);
  const scale = 2, ox = 2, oy = 7;
  const col = Math.floor((33 - 1) / 2);
  const row = 4;
  // check that at least one ink pixel exists inside that character cell and none in row 0
  let inkInCell = 0, inkRow0 = 0;
  for (let y = 0; y < 13 * scale; y++) for (let x = 0; x < 6 * scale; x++) {
    const i = ((oy + (row * 13 * scale) + y) * img.width + (ox + col * 6 * scale + x)) * 4;
    if (img.rgba[i] === 255) inkInCell++;
    const j = ((oy + y) * img.width + (ox + col * 6 * scale + x)) * 4;
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

test('huge viewports render in block mode within 400x300', () => {
  const n = 400;
  const dat = [0, 1, 2, 3, 4].map(() => [0, 0, 0, 0, 0]);
  const s = {
    kind: 'level', width: n, height: n, viewport: { x: 0, y: 0, w: n, h: n }, background: '#000000',
    sprites: { 0: { dat, colors: ['#123456'] } },
    cells: Array.from({ length: n * n }, () => [0]),
  };
  const img = renderLevelRGBA(s);
  assert.equal(img.width, 400);
  assert.equal(img.height, 300);
  assert.deepEqual(px(img, 200, 150), [0x12, 0x34, 0x56, 255]);
});

test('every frame is exactly 400x300', () => {
  const host = createHost();
  host.load(SOKOBAN, 'seed', 0);
  const frames = [host.snapshot()];
  host.dispose();
  const zhost = createHost();
  zhost.load(SOKOBAN.replace('homepage www.puzzlescript.net', 'homepage www.puzzlescript.net\nzoomscreen 3x3'), 'seed', 0);
  frames.push(zhost.snapshot());
  zhost.dispose();
  frames.push({ kind: 'message', message: 'hello there', background: '#000000', textColor: '#ffffff' });
  frames.push({ kind: 'finished', background: '#101010', textColor: '#ffffff' });
  const n = 400;
  const dat = [0, 1, 2, 3, 4].map(() => [0, 0, 0, 0, 0]);
  frames.push({
    kind: 'level', width: n, height: n, viewport: { x: 0, y: 0, w: n, h: n }, background: '#000000',
    sprites: { 0: { dat, colors: ['#123456'] } }, cells: Array.from({ length: n * n }, () => [0]),
  });
  for (const f of frames) {
    const out = renderSnapshot(f);
    assert.equal(out.width, 400);
    assert.equal(out.height, 300);
    const back = decodePNG(out.png);
    assert.equal(back.width, 400);
    assert.equal(back.height, 300);
  }
});

test('getGlyphs exposes the engine font as 12 rows of 5 booleans', () => {
  const { getGlyphs, GLYPH_W, GLYPH_H, CHAR_W, CHAR_H } = require('../renderer');
  const g = getGlyphs();
  assert.equal(g.A.length, 12);
  assert.equal(g.A[0].length, 5);
  assert.deepEqual(g.A[3], [false, true, true, true, false]);
  assert.deepEqual([GLYPH_W, GLYPH_H, CHAR_W, CHAR_H], [5, 12, 6, 13]);
});
