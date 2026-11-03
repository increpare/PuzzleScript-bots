'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { galleryFromRecords } = require('./gallery');

const GALLERY_URL = 'https://www.puzzlescript.net/games_dat.js';
const MAX_BYTES = 1_000_000;

function checkedGallery(records) {
  if (!Array.isArray(records) || !records.length || records.some((r) => !r ||
    typeof r.url !== 'string' || typeof r.title !== 'string' || typeof r.author !== 'string' ||
    (r.source !== undefined && typeof r.source !== 'string'))) throw new Error('invalid gallery records');
  const gallery = galleryFromRecords(records);
  if (!gallery.length) throw new Error('the gallery has no playable links');
  return gallery;
}

// The public file declares JSON data with a final trailing comma. Never run downloaded code.
function parseRecords(text) {
  const declaration = /^(?:\s|\/\/[^\r\n]*(?:\r?\n|$))*(?:let|const|var)\s+games_gallery\s*=\s*/.exec(text);
  if (!declaration) throw new Error('invalid gallery declaration');
  return JSON.parse(text.slice(declaration[0].length).trim().replace(/;\s*$/, '').replace(/,\s*\]$/, ']'));
}

function createGallerySync({ dataDir, guildId, releasesChannelId, onRefresh, fetchImpl = globalThis.fetch, log = console.error }) {
  const file = path.join(dataDir, 'gallery.json');
  let queue = Promise.resolve();

  function restore() {
    try {
      if (fs.statSync(file).size > MAX_BYTES) throw new Error('cached gallery is too large');
      onRefresh(checkedGallery(JSON.parse(fs.readFileSync(file, 'utf8'))));
      return true;
    } catch (e) {
      if (e.code !== 'ENOENT') log('gallery cache could not be restored:', e.message);
      return false;
    }
  }

  async function fetchGallery() {
    try {
      const response = await fetchImpl(GALLERY_URL, { signal: AbortSignal.timeout(10_000) });
      if (!response.ok) throw new Error('HTTP ' + response.status);
      if (!response.body) throw new Error('empty gallery response');
      const chunks = [];
      let bytes = 0;
      for await (const chunk of response.body) {
        bytes += chunk.byteLength;
        if (bytes > MAX_BYTES) throw new Error('gallery is too large');
        chunks.push(chunk);
      }
      const records = parseRecords(Buffer.concat(chunks, bytes).toString('utf8'));
      const gallery = checkedGallery(records);
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(file + '.tmp', JSON.stringify(records) + '\n');
      fs.renameSync(file + '.tmp', file);
      onRefresh(gallery);
      log('gallery refreshed:', gallery.length, 'games');
      return true;
    } catch (e) {
      log('gallery refresh failed:', e.message);
      return false;
    }
  }

  // A release arriving during startup's request still needs a request after that one finishes.
  function refresh() {
    const next = queue.then(fetchGallery);
    queue = next.catch(() => {});
    return next;
  }

  function onThread(thread, newlyCreated) {
    if (newlyCreated !== true || !thread || thread.guildId !== guildId || thread.parentId !== releasesChannelId) return Promise.resolve(false);
    return refresh();
  }

  return { restore, refresh, onThread };
}

module.exports = { createGallerySync };
