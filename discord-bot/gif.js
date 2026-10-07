'use strict';

// A small GIF89a writer for animations with one shared palette.
// Each frame is a rectangle of palette indices drawn over the frames before it,
// so a frame only needs to cover what changed.

function tableBits(count) {
  let bits = 1;
  while ((1 << bits) < count) bits++;
  return bits; // table holds 2^bits entries, 2 at the least
}

// GIF's variant of LZW: variable-width codes, least significant bit first, in sub-blocks of at most 255 bytes.
function lzw(minCodeSize, indices) {
  const out = [];
  let block = [];
  let acc = 0, accBits = 0;
  const flushBlock = () => { if (block.length) { out.push(block.length, ...block); block = []; } };
  const clear = 1 << minCodeSize, eoi = clear + 1;
  let codeSize = minCodeSize + 1, next = eoi + 1;
  const emit = (code) => {
    acc |= code << accBits;
    accBits += codeSize;
    while (accBits >= 8) {
      block.push(acc & 0xff);
      if (block.length === 255) flushBlock();
      acc >>>= 8;
      accBits -= 8;
    }
  };
  const dict = new Map();
  emit(clear);
  let prefix = indices[0];
  for (let i = 1; i < indices.length; i++) {
    const k = indices[i];
    const key = (prefix << 8) | k;
    const found = dict.get(key);
    if (found !== undefined) { prefix = found; continue; }
    emit(prefix);
    if (next < 4096) {
      dict.set(key, next++);
      if (next > (1 << codeSize) && codeSize < 12) codeSize++;
    } else {
      emit(clear);
      dict.clear();
      next = eoi + 1;
      codeSize = minCodeSize + 1;
    }
    prefix = k;
  }
  emit(prefix);
  // A reader adds a table entry for this last code too, and may widen its codes before the end code.
  if (next < 4096 && ++next > (1 << codeSize) && codeSize < 12) codeSize++;
  emit(eoi);
  if (accBits > 0) { block.push(acc & 0xff); if (block.length === 255) flushBlock(); }
  flushBlock();
  out.push(0); // block terminator
  return Buffer.from(out);
}

function createGIF({ width, height, palette, loop }) {
  if (palette.length > 256) throw new Error('a GIF palette holds at most 256 colours');
  const bits = tableBits(Math.max(2, palette.length));
  const minCodeSize = Math.max(2, bits);
  const chunks = [];
  const head = Buffer.alloc(13);
  head.write('GIF89a', 0, 'latin1');
  head.writeUInt16LE(width, 6);
  head.writeUInt16LE(height, 8);
  head[10] = 0x80 | (7 << 4) | (bits - 1); // global colour table, 8 bits per channel
  head[11] = 0; // background colour index
  head[12] = 0; // no pixel aspect ratio
  const table = Buffer.alloc(3 * (1 << bits));
  palette.forEach(([r, g, b], i) => { table[i * 3] = r; table[i * 3 + 1] = g; table[i * 3 + 2] = b; });
  chunks.push(head, table);
  // Without this block a viewer plays the frames once and stops on the last one.
  if (loop) chunks.push(Buffer.from([0x21, 0xff, 0x0b, ...Buffer.from('NETSCAPE2.0', 'latin1'), 0x03, 0x01, 0x00, 0x00, 0x00]));

  return {
    addFrame({ x, y, w, h, indices, delayCs }) {
      if (indices.length !== w * h) throw new Error('frame size mismatch');
      const d = Math.max(0, Math.min(65535, delayCs | 0));
      const gce = Buffer.from([0x21, 0xf9, 0x04, 1 << 2 /* leave the frame in place */, d & 0xff, d >> 8, 0, 0]);
      const desc = Buffer.alloc(10);
      desc[0] = 0x2c;
      desc.writeUInt16LE(x, 1); desc.writeUInt16LE(y, 3); desc.writeUInt16LE(w, 5); desc.writeUInt16LE(h, 7);
      desc[9] = 0; // no local colour table, not interlaced
      chunks.push(gce, desc, Buffer.from([minCodeSize]), lzw(minCodeSize, indices));
    },
    finish() { return Buffer.concat([...chunks, Buffer.from([0x3b])]); },
  };
}

// Reads back what createGIF writes. Used by the tests; not a general GIF reader.
function decodeGIF(buf) {
  const width = buf.readUInt16LE(6), height = buf.readUInt16LE(8);
  const bits = (buf[10] & 7) + 1;
  let pos = 13;
  const palette = [];
  for (let i = 0; i < (1 << bits); i++) palette.push([buf[pos + i * 3], buf[pos + i * 3 + 1], buf[pos + i * 3 + 2]]);
  pos += 3 * (1 << bits);
  let loop = false, delayCs = 0, disposal = 0;
  const frames = [];
  const readSubBlocks = () => {
    const parts = [];
    while (buf[pos] !== 0) { parts.push(buf.subarray(pos + 1, pos + 1 + buf[pos])); pos += 1 + buf[pos]; }
    pos++;
    return Buffer.concat(parts);
  };
  while (pos < buf.length && buf[pos] !== 0x3b) {
    if (buf[pos] === 0x21 && buf[pos + 1] === 0xf9) {
      disposal = (buf[pos + 3] >> 2) & 7;
      delayCs = buf.readUInt16LE(pos + 4);
      pos += 8;
    } else if (buf[pos] === 0x21) {
      const isLoop = buf[pos + 1] === 0xff && buf.toString('latin1', pos + 3, pos + 14) === 'NETSCAPE2.0';
      pos += 2;
      readSubBlocks();
      if (isLoop) loop = true;
    } else if (buf[pos] === 0x2c) {
      const x = buf.readUInt16LE(pos + 1), y = buf.readUInt16LE(pos + 3), w = buf.readUInt16LE(pos + 5), h = buf.readUInt16LE(pos + 7);
      pos += 10;
      const minCodeSize = buf[pos++];
      const data = readSubBlocks();
      frames.push({ x, y, w, h, delayCs, disposal, indices: unlzw(minCodeSize, data, w * h) });
    } else throw new Error('unexpected GIF block 0x' + buf[pos].toString(16));
  }
  return { width, height, palette, loop, frames };
}

function unlzw(minCodeSize, data, count) {
  const out = new Uint8Array(count);
  let n = 0;
  const clear = 1 << minCodeSize, eoi = clear + 1;
  let codeSize, next, dict, prev;
  const reset = () => {
    codeSize = minCodeSize + 1; next = eoi + 1; prev = null;
    dict = []; for (let i = 0; i < clear; i++) dict[i] = [i];
  };
  reset();
  let acc = 0, accBits = 0, pos = 0;
  for (;;) {
    while (accBits < codeSize) { if (pos >= data.length) return out; acc |= data[pos++] << accBits; accBits += 8; }
    const code = acc & ((1 << codeSize) - 1);
    acc >>>= codeSize; accBits -= codeSize;
    if (code === clear) { reset(); continue; }
    if (code === eoi) return out;
    let entry;
    if (prev === null) entry = dict[code];
    else if (code < next && dict[code]) { entry = dict[code]; if (next < 4096) dict[next++] = dict[prev].concat(entry[0]); }
    else { entry = dict[prev].concat(dict[prev][0]); if (next < 4096) dict[next++] = entry; }
    for (const v of entry) out[n++] = v;
    prev = code;
    if (next === (1 << codeSize) && codeSize < 12) codeSize++;
  }
}

module.exports = { createGIF, decodeGIF };
