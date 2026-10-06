'use strict';
const test = require('node:test');
const assert = require('node:assert');
const zlib = require('node:zlib');
const { encodePNG, decodePNG } = require('../png');

test('encodes a valid PNG that round-trips', () => {
  const w = 3, h = 2;
  const rgba = new Uint8Array([
    255, 0, 0, 255,   0, 255, 0, 255,   0, 0, 255, 255,
    0, 0, 0, 0,       128, 128, 128, 255, 255, 255, 255, 255,
  ]);
  const png = encodePNG(w, h, rgba);
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(png.toString('latin1', 12, 16), 'IHDR');
  assert.equal(png.readUInt32BE(16), w);
  assert.equal(png.readUInt32BE(20), h);
  assert.equal(png.toString('latin1', png.length - 8, png.length - 4), 'IEND');
  const back = decodePNG(png);
  assert.equal(back.width, w);
  assert.equal(back.height, h);
  assert.deepEqual([...back.rgba], [...rgba]);
});

test('chunk CRCs are correct', () => {
  const png = encodePNG(1, 1, new Uint8Array([9, 8, 7, 255]));
  // walk chunks and verify each CRC against zlib.crc32 (node 18 lacks it: use our own)
  const { crc32 } = require('../png');
  let pos = 8;
  while (pos < png.length) {
    const len = png.readUInt32BE(pos);
    const typeAndData = png.subarray(pos + 4, pos + 8 + len);
    const crc = png.readUInt32BE(pos + 8 + len);
    assert.equal(crc, crc32(typeAndData) >>> 0);
    pos += 12 + len;
  }
});
