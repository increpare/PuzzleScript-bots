// discord-bot/renderer.js
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { encodePNG } = require('./png');

const MAX_SIDE = 800;
const CELL = 5;

const isTransparent = (c) => String(c).trim().toLowerCase() === 'transparent';

function parseHex(c) {
  let str = String(c).trim();
  const short = /^#?([0-9a-f])([0-9a-f])([0-9a-f])([0-9a-f])?$/i.exec(str);
  if (short) str = '#' + short[1] + short[1] + short[2] + short[2] + short[3] + short[3] + (short[4] ? short[4] + short[4] : '');
  const m = /^#?([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(str);
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

function dominantColour(sprite) {
  const v0 = sprite.dat && sprite.dat[2] ? sprite.dat[2][2] : undefined;
  if (v0 !== undefined && v0 >= 0 && sprite.colors[v0] !== undefined && !isTransparent(sprite.colors[v0])) return sprite.colors[v0];
  if (v0 !== undefined && v0 >= 0 && isTransparent(sprite.colors[v0])) return null;
  for (let row = 0; row < CELL; row++) {
    const line = sprite.dat && sprite.dat[row];
    if (!line) continue;
    for (let col = 0; col < CELL; col++) {
      const v = line[col];
      if (v === undefined || v < 0) continue;
      const colour = sprite.colors[v];
      if (colour === undefined || isTransparent(colour)) continue;
      return colour;
    }
  }
  return null;
}

// Very large viewports: one flat square per cell so the output stays within MAX_SIDE.
function renderLevelBlocks(s) {
  const { x: vx, y: vy, w: vw, h: vh } = s.viewport;
  const block = Math.max(1, Math.floor(MAX_SIDE / Math.max(vw, vh)));
  const bg = isTransparent(s.background) ? '#000000' : s.background;
  const img = makeImage(vw * block, vh * block, bg);
  const cache = {};
  for (let cx = 0; cx < vw; cx++) {
    for (let cy = 0; cy < vh; cy++) {
      const ids = s.cells[(vx + cx) * s.height + (vy + cy)];
      if (!ids || !ids.length) continue;
      let top = -Infinity;
      for (const id of ids) if (id > top && s.sprites[id]) top = id;
      if (top === -Infinity) continue;
      if (!(top in cache)) cache[top] = dominantColour(s.sprites[top]);
      if (cache[top] === null) continue;
      fillRect(img, cx * block, cy * block, block, block, parseHex(cache[top]));
    }
  }
  return img;
}

function renderLevelRGBA(s) {
  const { x: vx, y: vy, w: vw, h: vh } = s.viewport;
  if (Math.max(vw, vh) * CELL > MAX_SIDE) return renderLevelBlocks(s);
  const scale = scaleFor(vw, vh, CELL);
  const img = makeImage(vw * CELL * scale, vh * CELL * scale, isTransparent(s.background) ? '#000000' : s.background);
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
            if (colour === undefined || isTransparent(colour)) continue;
            fillRect(img, (cx * CELL + col) * scale, (cy * CELL + row) * scale, scale, scale, rgbOf(colour));
          }
        }
      }
    }
  }
  return img;
}

const TERMINAL_W = 34, TERMINAL_H = 13, GLYPH_W = 5, GLYPH_H = 12, CHAR_W = 6, CHAR_H = 13;

let glyphs = null;
function getGlyphs() {
  if (glyphs === null) {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'js', 'font.js'), 'utf8');
    const sandbox = {};
    vm.runInNewContext(src + '\n;this.__font = font;', sandbox);
    glyphs = {};
    for (const [ch, str] of Object.entries(sandbox.__font)) {
      const rows = str.split('\n').map((r) => r.trim()).filter((r, i) => !(i === 0 && r === ''));
      glyphs[ch] = rows.slice(0, GLYPH_H).map((r) => r.split('').map((c) => c === '1'));
    }
  }
  return glyphs;
}

function wordwrap(str, width) {
  if (!str) return [];
  const regex = '.{1,' + width + '}(\\s|$)|.{' + width + '}|.+$';
  return (str.match(new RegExp(regex, 'g')) || []).map((l) => l.replace(/\s+$/, ''));
}

function layoutText(message) {
  const lines = wordwrap(String(message).trim(), TERMINAL_W).slice(0, TERMINAL_H - 1);
  let offset = 5 - ((lines.length / 2) | 0);
  if (offset < 0) offset = 0;
  const grid = [];
  for (let r = 0; r < TERMINAL_H; r++) grid.push(' '.repeat(TERMINAL_W));
  lines.forEach((line, i) => {
    const row = offset + i;
    if (row >= TERMINAL_H) return;
    const lmargin = ((TERMINAL_W - line.length) / 2) | 0;
    grid[row] = (' '.repeat(lmargin) + line).padEnd(TERMINAL_W).slice(0, TERMINAL_W);
  });
  return grid;
}

function renderTextRGBA(s) {
  const text = s.kind === 'finished' ? 'finished' : s.message || '';
  const grid = layoutText(text);
  const scale = scaleFor(TERMINAL_W, TERMINAL_H, CHAR_W);
  const img = makeImage(TERMINAL_W * CHAR_W * scale, TERMINAL_H * CHAR_H * scale, s.background || '#000000');
  const ink = parseHex(s.textColor || '#ffffff');
  const font = getGlyphs();
  for (let r = 0; r < TERMINAL_H; r++) {
    for (let c = 0; c < TERMINAL_W; c++) {
      const ch = grid[r][c];
      if (ch === ' ' || !font[ch]) continue; // unknown glyphs (CJK) are skipped
      const g = font[ch];
      for (let gy = 0; gy < GLYPH_H; gy++) for (let gx = 0; gx < GLYPH_W; gx++) {
        if (g[gy] && g[gy][gx]) fillRect(img, (c * CHAR_W + gx) * scale, (r * CHAR_H + gy) * scale, scale, scale, ink);
      }
    }
  }
  return img;
}

function renderSnapshot(s) {
  const img = s.kind === 'level' ? renderLevelRGBA(s) : renderTextRGBA(s);
  return { png: encodePNG(img.width, img.height, img.rgba), width: img.width, height: img.height };
}

module.exports = { renderSnapshot, renderLevelRGBA, renderTextRGBA, layoutText, parseHex, makeImage, fillRect, scaleFor };
