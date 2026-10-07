'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createGIF, decodeGIF } = require('../gif');

const PALETTE = [[0, 0, 0], [255, 255, 255], [255, 0, 0], [0, 255, 0], [0, 0, 255]];

function solid(w, h, v) { return new Uint8Array(w * h).fill(v); }

test('writes a GIF89a header with the screen size and a global colour table', () => {
  const g = createGIF({ width: 400, height: 300, palette: PALETTE, loop: false });
  g.addFrame({ x: 0, y: 0, w: 400, h: 300, indices: solid(400, 300, 1), delayCs: 10 });
  const buf = g.finish();
  assert.equal(buf.toString('latin1', 0, 6), 'GIF89a');
  assert.equal(buf.readUInt16LE(6), 400);
  assert.equal(buf.readUInt16LE(8), 300);
  assert.equal(buf[10] & 0x80, 0x80, 'global colour table flag');
  assert.equal(2 << (buf[10] & 7), 8, '5 colours need an 8-entry table');
  assert.deepEqual([...buf.subarray(13, 13 + 6)], [0, 0, 0, 255, 255, 255]);
  assert.equal(buf[buf.length - 1], 0x3b, 'trailer');
});

test('frames, positions and delays survive a round trip', () => {
  const g = createGIF({ width: 8, height: 6, palette: PALETTE, loop: false });
  const first = new Uint8Array(48); for (let i = 0; i < 48; i++) first[i] = i % 5;
  g.addFrame({ x: 0, y: 0, w: 8, h: 6, indices: first, delayCs: 2 });
  g.addFrame({ x: 2, y: 1, w: 3, h: 2, indices: Uint8Array.from([4, 4, 4, 3, 3, 3]), delayCs: 15 });
  g.addFrame({ x: 7, y: 5, w: 1, h: 1, indices: Uint8Array.from([2]), delayCs: 100 });
  const d = decodeGIF(g.finish());
  assert.deepEqual([d.width, d.height, d.loop], [8, 6, false]);
  assert.deepEqual(d.palette.slice(0, 5), PALETTE);
  assert.equal(d.frames.length, 3);
  assert.deepEqual(d.frames.map((f) => [f.x, f.y, f.w, f.h, f.delayCs]), [[0, 0, 8, 6, 2], [2, 1, 3, 2, 15], [7, 5, 1, 1, 100]]);
  assert.deepEqual([...d.frames[0].indices], [...first]);
  assert.deepEqual([...d.frames[1].indices], [4, 4, 4, 3, 3, 3]);
  assert.deepEqual([...d.frames[2].indices], [2]);
  assert.ok(d.frames.every((f) => f.disposal === 1), 'frames are drawn over one another');
});

test('a looping GIF carries the loop marker and a play-once GIF does not', () => {
  const make = (loop) => {
    const g = createGIF({ width: 2, height: 2, palette: PALETTE, loop });
    g.addFrame({ x: 0, y: 0, w: 2, h: 2, indices: solid(2, 2, 0), delayCs: 5 });
    g.addFrame({ x: 0, y: 0, w: 2, h: 2, indices: solid(2, 2, 1), delayCs: 5 });
    return g.finish();
  };
  assert.equal(decodeGIF(make(true)).loop, true);
  assert.ok(make(true).includes(Buffer.from('NETSCAPE2.0', 'latin1')));
  assert.equal(decodeGIF(make(false)).loop, false);
  assert.ok(!make(false).includes(Buffer.from('NETSCAPE2.0', 'latin1')));
});

test('a large noisy frame round-trips through code-size growth and dictionary resets', () => {
  const palette = []; for (let i = 0; i < 200; i++) palette.push([i, (i * 7) & 255, (i * 13) & 255]);
  const w = 400, h = 300, px = new Uint8Array(w * h);
  let seed = 12345;
  for (let i = 0; i < px.length; i++) { seed = (seed * 1103515245 + 12345) & 0x7fffffff; px[i] = (seed >> 8) % 200; }
  const g = createGIF({ width: w, height: h, palette, loop: false });
  g.addFrame({ x: 0, y: 0, w, h, indices: px, delayCs: 10 });
  const d = decodeGIF(g.finish());
  assert.equal(d.frames[0].indices.length, px.length);
  assert.ok(Buffer.from(d.frames[0].indices).equals(Buffer.from(px)));
});

test('palettes of one colour and of 256 colours are both valid', () => {
  for (const n of [1, 256]) {
    const palette = []; for (let i = 0; i < n; i++) palette.push([i, i, i]);
    const g = createGIF({ width: 4, height: 4, palette, loop: false });
    const px = new Uint8Array(16); for (let i = 0; i < 16; i++) px[i] = (i * 17) % n;
    g.addFrame({ x: 0, y: 0, w: 4, h: 4, indices: px, delayCs: 3 });
    const d = decodeGIF(g.finish());
    assert.deepEqual([...d.frames[0].indices], [...px]);
    assert.ok(d.palette.length >= n);
  }
  assert.throws(() => createGIF({ width: 1, height: 1, palette: new Array(257).fill([0, 0, 0]), loop: false }), /256/);
});

// A reader that keeps to the letter of the format: every code is read at the width a decoder has
// reached by then, the end code included, and nothing but padding may follow it.
function strictCodes(buf) {
  let pos = 13 + 3 * (2 << (buf[10] & 7));
  while (buf[pos] !== 0x2c) pos += buf[pos + 1] === 0xf9 ? 8 : (() => { throw new Error('unexpected block'); })();
  pos += 10;
  const minCodeSize = buf[pos++];
  const parts = [];
  while (buf[pos] !== 0) { parts.push(buf.subarray(pos + 1, pos + 1 + buf[pos])); pos += 1 + buf[pos]; }
  const data = Buffer.concat(parts);
  const clear = 1 << minCodeSize, eoi = clear + 1;
  let codeSize = minCodeSize + 1, next = eoi + 1, first = true, bit = 0;
  for (;;) {
    if (bit + codeSize > data.length * 8) return { ok: false, why: 'ran out of data before the end code' };
    let code = 0;
    for (let i = 0; i < codeSize; i++, bit++) code |= ((data[bit >> 3] >> (bit & 7)) & 1) << i;
    if (code === eoi) break;
    if (code === clear) { codeSize = minCodeSize + 1; next = eoi + 1; first = true; continue; }
    if (first) first = false; else if (next < 4096) next++;
    if (next === (1 << codeSize) && codeSize < 12) codeSize++;
  }
  if (data.length * 8 - bit >= 8) return { ok: false, why: 'whole bytes left after the end code' };
  return { ok: true };
}

test('the end code is written at the width a strict reader expects, whatever the length of the data', () => {
  for (const colours of [2, 3, 5, 16, 200]) {
    const palette = []; for (let i = 0; i < colours; i++) palette.push([i, i, i]);
    let seed = 7;
    for (let len = 1; len <= 1500; len++) {
      const px = new Uint8Array(len);
      for (let i = 0; i < len; i++) { seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff; px[i] = (seed >> 8) % colours; }
      const g = createGIF({ width: len, height: 1, palette, loop: false });
      g.addFrame({ x: 0, y: 0, w: len, h: 1, indices: px, delayCs: 1 });
      const buf = g.finish();
      const strict = strictCodes(buf);
      assert.ok(strict.ok, colours + ' colours, ' + len + ' pixels: ' + strict.why);
      assert.ok(Buffer.from(decodeGIF(buf).frames[0].indices).equals(Buffer.from(px)), colours + ' colours, ' + len + ' pixels');
    }
  }
});

test('palettes of two and three colours get a table of the right size and round-trip', () => {
  for (const [n, entries] of [[2, 2], [3, 4]]) {
    const palette = [[0, 0, 0], [255, 255, 255], [255, 0, 0]].slice(0, n);
    const g = createGIF({ width: 6, height: 2, palette, loop: false });
    const px = Uint8Array.from([0, 1, 0, 1, 1, 0, 1, 1, 0, 0, 1, 0].map((v, i) => (n === 3 && i % 5 === 0 ? 2 : v)));
    g.addFrame({ x: 0, y: 0, w: 6, h: 2, indices: px, delayCs: 3 });
    const buf = g.finish();
    assert.equal(2 << (buf[10] & 7), entries);
    const d = decodeGIF(buf);
    assert.deepEqual(d.palette.slice(0, n), palette);
    assert.deepEqual([...d.frames[0].indices], [...px]);
  }
});
