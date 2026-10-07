'use strict';
const { createGIF } = require('./gif');
const { renderLevelRGBA, renderTextRGBA, parseHex, FRAME_W, FRAME_H } = require('./renderer');

// Browsers play a frame shorter than this at a tenth of a second instead.
const MIN_DELAY_CS = 2;

const isTransparent = (c) => String(c).trim().toLowerCase() === 'transparent';

// The engine keeps a level as one bit per object per cell; the renderer wants a list of object ids per cell.
function cellsOf(objects, stride, objectCount) {
  const n = objects.length / stride;
  const cells = new Array(n);
  for (let i = 0; i < n; i++) {
    const ids = [];
    for (let k = 0; k < objectCount; k++) if (objects[i * stride + (k >> 5)] & (1 << (k & 31))) ids.push(k);
    cells[i] = ids;
  }
  return cells;
}

// Turn the frames captured for one move (engine-host takeFrames) into a GIF.
// base is the snapshot the game was left in, which is what the still picture would show.
// A chain that ended plays once and rests on that state; a loop plays for ever.
// Returns null when it cannot be done within the limits, and the caller shows the still instead.
function buildAnimation({ base, frames, onProgress = null, budgetMs = 5000, now = Date.now, maxBytes = 4_000_000 }) {
  // One palette for the whole animation: every colour any frame can contain.
  const palette = [];
  const indexOf = new Map();
  const add = (colour) => {
    if (colour === undefined || colour === null) return;
    const [r, g, b] = parseHex(colour);
    const key = (r << 16) | (g << 8) | b;
    if (!indexOf.has(key)) { indexOf.set(key, palette.length); palette.push([r, g, b]); }
  };
  add('#000000'); // what a transparent background is drawn as
  add('#ffffff'); // the default text colour
  add('#ff00ff'); // what the renderer draws for a colour it cannot read
  for (const c of [frames.background, frames.textColor, base.background, base.textColor]) if (!isTransparent(c)) add(c);
  for (const id of Object.keys(frames.sprites)) for (const c of frames.sprites[id].colors) if (!isTransparent(c)) add(c);
  if (palette.length > 256) return null;

  const size = FRAME_W * FRAME_H;
  const toIndices = (img) => {
    const out = new Uint8Array(size);
    let lastKey = -1, last = 0;
    for (let i = 0; i < size; i++) {
      const key = (img.rgba[i * 4] << 16) | (img.rgba[i * 4 + 1] << 8) | img.rgba[i * 4 + 2];
      if (key !== lastKey) { lastKey = key; const v = indexOf.get(key); last = v === undefined ? 0 : v; }
      out[i] = last;
    }
    return out;
  };
  const drawFrame = (f) => (f.kind === 'level'
    ? renderLevelRGBA({ kind: 'level', width: f.width, height: f.height, viewport: f.viewport, cells: cellsOf(f.objects, frames.stride, frames.objectCount), sprites: frames.sprites, background: frames.background })
    : renderTextRGBA({ kind: f.kind, message: f.message, background: frames.background, textColor: frames.textColor }));
  const drawBase = () => (base.kind === 'level' ? renderLevelRGBA(base) : renderTextRGBA(base));

  const gif = createGIF({ width: FRAME_W, height: FRAME_H, palette, loop: frames.loop });
  const canvas = new Uint8Array(size);
  // The frame not yet written: it stays back so that its delay can grow if the next picture is the same.
  let held = null;
  const put = (indices, delayCs) => {
    if (held === null) {
      canvas.set(indices);
      held = { x: 0, y: 0, w: FRAME_W, h: FRAME_H, indices, delayCs };
      return;
    }
    let x0 = FRAME_W, y0 = FRAME_H, x1 = -1, y1 = -1;
    for (let y = 0, i = 0; y < FRAME_H; y++) {
      for (let x = 0; x < FRAME_W; x++, i++) {
        if (indices[i] === canvas[i]) continue;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        y1 = y;
      }
    }
    if (x1 < 0) { held.delayCs += delayCs; return; }
    gif.addFrame(held);
    const w = x1 - x0 + 1, h = y1 - y0 + 1;
    const patch = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      const row = indices.subarray((y0 + y) * FRAME_W + x0, (y0 + y) * FRAME_W + x0 + w);
      patch.set(row, y * w);
      canvas.set(row, (y0 + y) * FRAME_W + x0);
    }
    held = { x: x0, y: y0, w, h, indices: patch, delayCs };
  };

  const intervalCs = Math.max(MIN_DELAY_CS, Math.round(frames.intervalMs / 10));
  const deadline = now() + budgetMs;
  const final = frames.loop ? null : toIndices(drawBase());
  // A client that shows a GIF as a still shows its first frame, so a chain that ends opens on the
  // final state for one blink before the turns play.
  if (final) put(final, MIN_DELAY_CS);
  for (const f of frames.list) {
    put(toIndices(drawFrame(f)), intervalCs * f.repeat);
    if (onProgress) onProgress();
    if (now() > deadline) return null;
  }
  if (final) {
    put(final, 0);
    if (held.delayCs === 0) held.delayCs = intervalCs;
  }
  gif.addFrame(held);
  const out = gif.finish();
  return out.length > maxBytes ? null : out;
}

module.exports = { buildAnimation, cellsOf };
