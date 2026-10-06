// discord-bot/gists.js
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createSourceStore } = require('./sources');

class GistError extends Error {}

function parseGistId(input) {
  const s = String(input || '').trim();
  let m = /^[0-9a-f]{4,40}$/i.exec(s);
  if (m) return s.toLowerCase();
  m = /^https?:\/\/(?:www\.)?puzzlescript\.net\/(?:play|editor)\.html\?(?:p|hack)=([0-9a-f]{4,40})/i.exec(s);
  if (m) return m[1].toLowerCase();
  m = /^https?:\/\/gist\.github\.com\/[^/]+\/([0-9a-f]{4,40})/i.exec(s);
  if (m) return m[1].toLowerCase();
  return null;
}

function createGistStore({ dataDir, token, fetchImpl = globalThis.fetch, now = Date.now, maxBytes = 1_000_000, freshMs = 10 * 60 * 1000, maxCacheBytes = 1_000_000, sources = createSourceStore({ dataDir }) }) {
  const cacheDir = path.join(dataDir, 'gists');
  fs.mkdirSync(cacheDir, { recursive: true });
  const fileFor = (id) => path.join(cacheDir, id + '.json');

  function readCache(id) {
    try { return JSON.parse(fs.readFileSync(fileFor(id), 'utf8')); } catch (e) { return null; }
  }
  function writeCache(id, entry) {
    const tmp = fileFor(id) + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(entry));
    fs.renameSync(tmp, fileFor(id));
    enforceCacheCap(id);
  }

  // The cache is a small index (gist id -> etag, last check, hash of the source in the source store).
  // Anything in it can be fetched again, so over the cap the oldest entries go.
  function enforceCacheCap(keepId) {
    const files = [];
    let total = 0;
    for (const f of fs.readdirSync(cacheDir)) {
      if (!f.endsWith('.json')) continue;
      try {
        const st = fs.statSync(path.join(cacheDir, f));
        files.push({ f, size: st.size, mtime: st.mtimeMs });
        total += st.size;
      } catch (e) { /* raced with a delete */ }
    }
    files.sort((a, b) => a.mtime - b.mtime);
    for (const x of files) {
      if (total <= maxCacheBytes) break;
      if (x.f === keepId + '.json') continue;
      try { fs.unlinkSync(path.join(cacheDir, x.f)); total -= x.size; } catch (e) { /* already gone */ }
    }
  }

  async function fetchGist(id, etag) {
    const headers = {
      'user-agent': 'puzzlescript-discord-bot',
      accept: 'application/vnd.github+json',
      authorization: 'Bearer ' + token,
      'x-github-api-version': '2022-11-28',
    };
    if (etag) headers['if-none-match'] = etag;
    let res;
    try { res = await fetchImpl('https://api.github.com/gists/' + id, { headers }); }
    catch (e) { throw new GistError('could not reach GitHub'); }
    if (res.status === 304) return null;
    if (res.status === 404) throw new GistError('gist not found');
    if (!res.ok) throw new GistError('GitHub error ' + res.status);
    const body = await res.json();
    const file = body && body.files && body.files['script.txt'];
    if (!file || typeof file.content !== 'string') throw new GistError('gist has no script.txt');
    if (Buffer.byteLength(file.content, 'utf8') > maxBytes) throw new GistError('game source is too large');
    return { etag: res.headers.get('etag') || null, fetchedAt: now(), hash: sources.save(file.content), content: file.content };
  }

  async function getSource(id) {
    if (!/^[0-9a-f]{4,40}$/i.test(String(id))) throw new GistError('invalid gist id');
    const cached = readCache(id);
    // the index entry is only useful while the source it points at is still in the store
    const cachedSource = cached && cached.hash ? sources.load(cached.hash) : null;
    if (cachedSource !== null && now() - cached.fetchedAt < freshMs) return cachedSource;
    const fresh = await fetchGist(id, cachedSource !== null ? cached.etag : null);
    if (fresh === null) {
      writeCache(id, { etag: cached.etag, fetchedAt: now(), hash: cached.hash });
      return cachedSource;
    }
    writeCache(id, { etag: fresh.etag, fetchedAt: fresh.fetchedAt, hash: fresh.hash });
    return fresh.content;
  }

  return { getSource };
}

module.exports = { parseGistId, createGistStore, GistError };
