// discord-bot/renderer.js
'use strict';
const { encodePNG } = require('./png');

const MAX_SIDE = 800;
const CELL = 5;

function parseHex(c) {
  const m = /^#?([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(String(c).trim());
  if (!m) return [255, 0, 255, 255];
  const n = parseInt(m[1], 16);
  const a = m[2] !== undefined ? parseInt(m[2], 16) : 255;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255, a];
}

function makeImage(width, height, bg) {
  const rgba = new Uint8Array(width * height * 4);
  const [r, g, b, a] = parseHex(bg);
  for (let i = 0; i < rgba.length; i += 4) { rgba[i] = r; rgba[i + 1] = g; rgba[i + 2] = b; rgba[i + 3] = a; }
  return { width, height, rgba };
}

function fillRect(img, x, y, w, h, rgb) {
  for (let yy = y; yy < y + h; yy++) {
    if (yy < 0 || yy >= img.height) continue;
    for (let xx = x; xx < x + w; xx++) {
      if (xx < 0 || xx >= img.width) continue;
      const i = (yy * img.width + xx) * 4;
      img.rgba[i] = rgb[0]; img.rgba[i + 1] = rgb[1]; img.rgba[i + 2] = rgb[2]; img.rgba[i + 3] = 255;
    }
  }
}

function scaleFor(cellsW, cellsH, cellPx) {
  return Math.max(1, Math.floor(MAX_SIDE / (cellPx * Math.max(cellsW, cellsH))));
}

function renderLevelRGBA(s) {
  const { x: vx, y: vy, w: vw, h: vh } = s.viewport;
  const scale = scaleFor(vw, vh, CELL);
  const img = makeImage(vw * CELL * scale, vh * CELL * scale, s.background);
  const colourCache = {};
  const rgbOf = (hex) => (colourCache[hex] || (colourCache[hex] = parseHex(hex)));
  for (let cx = 0; cx < vw; cx++) {
    for (let cy = 0; cy < vh; cy++) {
      const ids = s.cells[(vx + cx) * s.height + (vy + cy)];
      if (!ids) continue;
      for (const id of ids) {
        const sprite = s.sprites[id];
        if (!sprite) continue;
        for (let row = 0; row < CELL; row++) {
          const line = sprite.dat[row];
          if (!line) continue;
          for (let col = 0; col < CELL; col++) {
            const v = line[col];
            if (v === undefined || v < 0) continue;
            const colour = sprite.colors[v];
            if (colour === undefined) continue;
            fillRect(img, (cx * CELL + col) * scale, (cy * CELL + row) * scale, scale, scale, rgbOf(colour));
          }
        }
      }
    }
  }
  return img;
}

function renderSnapshot(s) {
  let img;
  if (s.kind === 'level') img = renderLevelRGBA(s);
  else throw new Error('unsupported snapshot kind ' + s.kind); // text frames arrive in the next task
  return { png: encodePNG(img.width, img.height, img.rgba), width: img.width, height: img.height };
}

module.exports = { renderSnapshot, renderLevelRGBA, parseHex, makeImage, fillRect, scaleFor };
