'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { SRC_DIR } = require('./engine-src');

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
    gallery.push({ gistId: m[1], title: String(g.title || ''), author: String(g.author || '') });
  }
  cached = { filePath, gallery };
  return gallery;
}

function choice(g) {
  return { name: (g.title + ' — ' + g.author).slice(0, 100), value: g.gistId };
}

function suggest(gallery, query, limit = 25) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return gallery.slice(0, limit).map(choice);
  const byTitle = gallery.filter((g) => g.title.toLowerCase().includes(q));
  const byAuthor = gallery.filter((g) => !g.title.toLowerCase().includes(q) && g.author.toLowerCase().includes(q));
  return byTitle.concat(byAuthor).slice(0, limit).map(choice);
}

module.exports = { loadGallery, suggest };
