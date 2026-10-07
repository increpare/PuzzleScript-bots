'use strict';
const { makeImage, fillRect, parseHex, renderLevelRGBA, renderTextRGBA, getGlyphs } = require('../discord-bot/renderer');

const WIDTH = 640, HEIGHT = 360, TILE = 10;
const GAME_X = 10, GAME_Y = 10, GAME_W = 400;
const PANEL_X = 420, PANEL_W = 210;
const LOG_ROWS = 12, NAME_CHARS = 30;

// The default PuzzleScript palette.
const C = { black: '#000000', white: '#ffffff', lightgrey: '#cccccc', grey: '#9d9d9d', darkgrey: '#697175', yellow: '#f7e26b', lightblue: '#b2dcef', pink: '#de65e2' };
const FADE = [C.white, C.lightgrey, C.lightgrey, C.grey, C.grey, C.grey, C.grey, C.darkgrey, C.darkgrey, C.darkgrey, C.darkgrey, C.darkgrey];

// The wall from the classic Sokoban example, for games that have none of their own.
const BRICK = { colors: ['#a46422', '#493c2b'], dat: [[0, 0, 0, 1, 0], [1, 1, 1, 1, 1], [0, 1, 0, 0, 0], [1, 1, 1, 1, 1], [0, 0, 0, 1, 0]] };

const icon = (rows) => rows.map((row) => row.split('').map((ch) => (ch === '0' ? 0 : -1)));
const ICONS = {
  up: icon(['..0..', '.000.', '0.0.0', '..0..', '..0..']),
  down: icon(['..0..', '..0..', '0.0.0', '.000.', '..0..']),
  left: icon(['..0..', '.0...', '00000', '.0...', '..0..']),
  right: icon(['..0..', '...0.', '00000', '...0.', '..0..']),
  action: icon(['0...0', '.0.0.', '..0..', '.0.0.', '0...0']),
  undo: icon(['.0...', '0000.', '.0..0', '....0', '.000.']),
  restart: icon(['0000.', '0..0.', '0000.', '0.0..', '0..0.']),
};
ICONS.continue = ICONS.action;

function drawSprite(img, x, y, sprite, scale) {
  for (let r = 0; r < 5; r++) {
    const row = sprite.dat[r];
    if (!row) continue;
    for (let c = 0; c < 5; c++) {
      const v = row[c];
      if (v === undefined || v < 0) continue;
      const colour = sprite.colors[v];
      if (colour === undefined || String(colour).toLowerCase() === 'transparent') continue;
      fillRect(img, x + c * scale, y + r * scale, scale, scale, parseHex(colour));
    }
  }
}

function drawText(img, x, y, str, colour, scale = 1) {
  const ink = parseHex(colour), font = getGlyphs();
  Array.from(String(str)).forEach((ch, i) => {
    const g = font[ch];
    if (!g) return; // characters the engine font lacks are left blank
    for (let gy = 0; gy < g.length; gy++) for (let gx = 0; gx < 5; gx++) {
      if (g[gy][gx]) fillRect(img, x + (i * 6 + gx) * scale, y + gy * scale, scale, scale, ink);
    }
  });
}

const chars = (str) => Array.from(String(str)).length;

function fit(str, max) {
  const a = Array.from(String(str));
  if (a.length <= max) return a.join('');
  return max <= 0 ? '' : a.slice(0, max - 1).join('') + '…';
}

function blit(img, src, dx, dy) {
  for (let y = 0; y < src.height; y++) {
    const from = y * src.width * 4;
    img.rgba.set(src.rgba.subarray(from, from + src.width * 4), ((dy + y) * img.width + dx) * 4);
  }
}

// One picture of the stream, 640x360; ffmpeg doubles it. The screen is laid out like a
// PuzzleScript level: walls divide it into the game, a title strip and a side panel.
function composeFrame({ snapshot, tiles, meta, moves = [], votes = { count: 0, needed: 1 }, music = null }) {
  const img = makeImage(WIDTH, HEIGHT, C.black);
  const t = tiles || {};

  const wall = (tx, ty) => {
    if (!t.wall) { drawSprite(img, tx * TILE, ty * TILE, BRICK, 2); return; }
    if (t.background) drawSprite(img, tx * TILE, ty * TILE, t.background, 2);
    drawSprite(img, tx * TILE, ty * TILE, t.wall, 2);
  };
  for (let tx = 0; tx < 64; tx++) { wall(tx, 0); wall(tx, 35); if (tx <= 41) wall(tx, 31); }
  for (let ty = 1; ty < 35; ty++) { wall(0, ty); wall(63, ty); if (ty !== 31) wall(41, ty); }

  blit(img, snapshot.kind === 'level' ? renderLevelRGBA(snapshot) : renderTextRGBA(snapshot), GAME_X, GAME_Y);

  // title strip
  const levelText = snapshot.kind !== 'finished' && snapshot.levelCount > 0
    ? 'level ' + (Math.min(snapshot.levelIndex, snapshot.levelCount - 1) + 1) + ' of ' + snapshot.levelCount : '';
  if (levelText) drawText(img, GAME_X + GAME_W - 6 - chars(levelText) * 6, 322, levelText, C.yellow);
  if (meta) {
    const room = Math.floor((GAME_W - 12 - (levelText ? chars(levelText) * 6 + 12 : 0)) / 6);
    const title = fit(meta.title || 'untitled', room);
    drawText(img, GAME_X + 6, 322, title, C.white);
    const rest = room - chars(title);
    if (meta.author && rest >= 8) drawText(img, GAME_X + 6 + chars(title) * 6, 322, fit(' by ' + meta.author, rest), C.grey);
  }
  if (music) drawText(img, GAME_X + 6, 335, fit('music: ' + music.title + ' - ' + music.album, 64), C.darkgrey);

  // side panel
  const centred = (str, scale) => PANEL_X + Math.floor((PANEL_W - chars(str) * 6 * scale) / 2);
  drawText(img, centred('TWITCH PLAYS', 2), 16, 'TWITCH PLAYS', C.pink, 2);
  drawText(img, centred('PUZZLESCRIPT', 2), 42, 'PUZZLESCRIPT', C.white, 2);
  if (t.player) {
    const sx = PANEL_X + (PANEL_W - 7 * 20) / 2;
    if (t.background) for (let i = 0; i < 7; i++) drawSprite(img, sx + i * 20, 76, t.background, 4);
    drawSprite(img, sx + 20, 76, t.player, 4);
  }
  drawText(img, PANEL_X + 8, 106, 'last moves', C.lightblue);
  moves.slice(0, LOG_ROWS).forEach((m, i) => {
    const y = 122 + i * 13;
    drawSprite(img, PANEL_X + 8, y + 2, { colors: [FADE[i]], dat: ICONS[m.action] || ICONS.action }, 2);
    drawText(img, PANEL_X + 24, y, fit(m.user, NAME_CHARS), FADE[i]);
  });

  const flags = (meta && meta.flags) || {};
  const words = ['action', 'undo', 'restart'].filter((w) => !flags['no' + w]);
  const help = ['up down left right'];
  if (words.length) help.push(words.join(' '));
  help.push('or just: u d l r' + (flags.noaction ? '' : ' a') + (flags.noundo ? '' : ' z'));
  help.push(votes.count > 0 ? '!skip next game (' + votes.count + '/' + votes.needed + ')' : '!skip votes next game');
  drawText(img, PANEL_X + 8, 284, 'type in chat:', C.lightblue);
  const top = 349 - help.length * 13;
  help.forEach((line, i) => drawText(img, PANEL_X + 8, top + i * 13, line, i === help.length - 1 ? C.grey : C.lightgrey));

  return img;
}

module.exports = { composeFrame, WIDTH, HEIGHT };
