#!/usr/bin/env node
// Rebuilds community-games.json: the games /play suggests besides the puzzlescript.net gallery.
// community-gists.txt lists their gists, one id a line. Each is fetched from GitHub (and kept in
// data/community-cache, so that a second run fetches only what the first could not), then loaded
// as the bot loads a game: the title and author are the ones the engine reads, and a game the bot
// could not start is left out. The result is committed; run this to change the list.
//
//   GITHUB_TOKEN=... node scripts/build-community-games.js [ids file]
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createPool } = require('../pool');

const HERE = path.join(__dirname, '..');
const IDS = process.argv[2] || path.join(HERE, 'community-gists.txt');
const OUT = path.join(HERE, 'community-games.json');
const CACHE = path.join(HERE, 'data', 'community-cache');
const FETCHES = 6;
const MAX_BYTES = 1_000_000; // as gists.js

class RateLimited extends Error {}

// {source} or {gone: why}. Only an answer that will not change is kept: a gist that is there, or
// one that GitHub says is not.
async function fetchGist(id, token) {
  const file = path.join(CACHE, id + '.json');
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { /* not fetched yet */ }
  const headers = { 'user-agent': 'puzzlescript-discord-bot', accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' };
  if (token) headers.authorization = 'Bearer ' + token;
  const res = await fetch('https://api.github.com/gists/' + id, { headers });
  let entry;
  if (res.status === 404) entry = { gone: 'gist not found' };
  else if (res.status === 403 || res.status === 429) throw new RateLimited('GitHub refused (' + res.status + '): run again later' + (token ? '' : ', or set GITHUB_TOKEN'));
  else if (!res.ok) throw new Error('GitHub error ' + res.status + ' for ' + id);
  else {
    const body = await res.json();
    const script = body && body.files && body.files['script.txt'];
    if (!script) entry = { gone: 'gist has no script.txt' };
    else {
      // a large file comes cut short, with the address of the whole of it
      const source = script.truncated ? await (await fetch(script.raw_url)).text() : script.content;
      entry = typeof source === 'string' ? { source } : { gone: 'gist has no script.txt' };
    }
  }
  fs.writeFileSync(file, JSON.stringify(entry));
  return entry;
}

const tidy = (s) => String(s || '').replace(/\s+/g, ' ').trim();

async function main() {
  const ids = [...new Set(fs.readFileSync(IDS, 'utf8').split(/\s+/).map((s) => s.toLowerCase()).filter((s) => /^[0-9a-f]{4,40}$/.test(s)))];
  fs.mkdirSync(CACHE, { recursive: true });
  const token = process.env.GITHUB_TOKEN || '';
  const pool = createPool({ size: 4 });
  const games = [];
  const left = {}; // why -> ids
  const leave = (id, why) => { (left[why] = left[why] || []).push(id); };
  let next = 0;
  async function work() {
    while (next < ids.length) {
      const id = ids[next++];
      const got = await fetchGist(id, token);
      if (got.gone) { leave(id, got.gone); continue; }
      if (Buffer.byteLength(got.source, 'utf8') > MAX_BYTES) { leave(id, 'game source is too large'); continue; }
      let meta;
      try { meta = await pool.load(id, got.source, 'community', 0); }
      catch (e) { leave(id, e && e.name === 'CompileError' ? 'does not compile' : 'does not load (' + (e && e.name) + ')'); continue; }
      finally { await pool.drop(id); }
      if (meta.flags.realtime) { leave(id, 'realtime'); continue; }
      games.push({ gistId: id, title: tidy(meta.title), author: tidy(meta.author) });
    }
  }
  try {
    await Promise.all(Array.from({ length: FETCHES }, work));
  } finally {
    await pool.close();
  }
  games.sort((a, b) => a.title.toLowerCase().localeCompare(b.title.toLowerCase(), 'en') || a.gistId.localeCompare(b.gistId));
  fs.writeFileSync(OUT, '[\n' + games.map((g) => JSON.stringify(g)).join(',\n') + '\n]\n');
  console.log(games.length + ' of ' + ids.length + ' games listed in ' + path.relative(process.cwd(), OUT));
  for (const why of Object.keys(left).sort()) console.log(left[why].length + ' left out: ' + why);
  fs.writeFileSync(path.join(CACHE, 'left-out.json'), JSON.stringify(left, null, 1));
}

main().catch((e) => { console.error(e instanceof RateLimited ? e.message : e); process.exit(1); });
