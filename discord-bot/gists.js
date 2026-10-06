// discord-bot/gists.js
'use strict';
const fs = require('node:fs');
const path = require('node:path');

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

function createGistStore({ dataDir, token, fetchImpl = globalThis.fetch, now = Date.now, maxBytes = 1_000_000, freshMs = 10 * 60 * 1000 }) {
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
    return { etag: res.headers.get('etag') || null, fetchedAt: now(), content: file.content };
  }

  async function getSource(id) {
    if (!/^[0-9a-f]{4,40}$/i.test(String(id))) throw new GistError('invalid gist id');
    const cached = readCache(id);
    if (cached && now() - cached.fetchedAt < freshMs) return cached.content;
    const fresh = await fetchGist(id, cached ? cached.etag : null);
    if (fresh === null) {
      const entry = Object.assign({}, cached, { fetchedAt: now() });
      writeCache(id, entry);
      return cached.content;
    }
    writeCache(id, fresh);
    return fresh.content;
  }

  return { getSource };
}

module.exports = { parseGistId, createGistStore, GistError };
