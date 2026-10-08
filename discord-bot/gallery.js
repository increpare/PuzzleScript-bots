'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { SRC_DIR } = require('./engine-src');

// The games /play suggests: the puzzlescript.net gallery, and after it the community's games.
// {gistId, title, author, starred}: starred marks a gallery game.

let cached = null;

function loadGallery(filePath = path.join(SRC_DIR, 'games_dat.js')) {
  if (cached && cached.filePath === filePath) return cached.gallery;
  const src = fs.readFileSync(filePath, 'utf8');
  const sandbox = {};
  vm.runInNewContext(src + '\n;this.__g = games_gallery;', sandbox);
  const gallery = [];
  for (const g of sandbox.__g) {
    const m = /[?&]p=([0-9a-f]+)/i.exec(String((g && g.url) || ''));
    if (!m) continue;
    gallery.push({ gistId: m[1], title: String(g.title || ''), author: String(g.author || ''), starred: true });
  }
  cached = { filePath, gallery };
  return gallery;
}

// The community's games are listed in a file of their own, made by scripts/build-community-games.js.
function loadCommunity(filePath = path.join(__dirname, 'community-games.json')) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'))
    .map((g) => ({ gistId: String(g.gistId).toLowerCase(), title: String(g.title || ''), author: String(g.author || ''), starred: false }));
}

// A game in both lists is a gallery game.
function loadGames({ gallery = loadGallery(), community = loadCommunity() } = {}) {
  const seen = new Set(gallery.map((g) => g.gistId.toLowerCase()));
  const games = gallery.slice();
  for (const g of community) {
    if (seen.has(g.gistId)) continue;
    seen.add(g.gistId);
    games.push(g);
  }
  return games;
}

function choice(g) {
  return { name: ((g.starred ? '⭐ ' : '') + g.title + (g.author ? ' — ' + g.author : '')).slice(0, 100), value: g.gistId };
}

const isWordChar = (c) => /[\p{L}\p{N}]/u.test(c);

// How well a game matches: 0 the title starts with the query, 1 a word of the title does, 2 the
// title has it somewhere, 3 only the author does, -1 not at all.
function matchRank(g, q) {
  const title = g.title.toLowerCase();
  let at = title.indexOf(q);
  if (at === 0) return 0;
  if (at === -1) return g.author.toLowerCase().includes(q) ? 3 : -1;
  for (; at !== -1; at = title.indexOf(q, at + 1)) {
    if (!isWordChar(title[at - 1])) return 1;
  }
  return 2;
}

// Gallery games come before the others; within each, the better matches first, in the order listed.
function suggest(games, query, limit = 25) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return games.slice(0, limit).map(choice);
  const buckets = [[], [], [], [], [], [], [], []];
  for (const g of games) {
    const rank = matchRank(g, q);
    if (rank !== -1) buckets[(g.starred ? 0 : 4) + rank].push(g);
  }
  return [].concat(...buckets).slice(0, limit).map(choice);
}

module.exports = { loadGallery, loadCommunity, loadGames, suggest };
