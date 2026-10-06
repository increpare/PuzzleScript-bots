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
