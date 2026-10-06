// discord-bot/test/gists.test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseGistId, createGistStore, GistError } = require('../gists');

test('parseGistId accepts the supported forms', () => {
  const id = '2fe3172d2b9fe684977d184f1b6226d5';
  assert.equal(parseGistId(id), id);
  assert.equal(parseGistId('  ' + id + '\n'), id);
  assert.equal(parseGistId('https://www.puzzlescript.net/play.html?p=' + id), id);
  assert.equal(parseGistId('http://puzzlescript.net/editor.html?hack=' + id), id);
  assert.equal(parseGistId('https://gist.github.com/increpare/' + id), id);
  assert.equal(parseGistId('6841165'), '6841165');
  assert.equal(parseGistId('not a gist'), null);
  assert.equal(parseGistId('https://example.com/?p=' + id), null);
});

function fakeFetch(responses) {
  const calls = [];
  const impl = async (url, opts) => {
    calls.push({ url, opts });
    const r = responses.shift();
    if (!r) throw new Error('unexpected fetch');
    return {
      status: r.status,
      ok: r.status >= 200 && r.status < 300,
      headers: { get: (k) => (r.headers || {})[k.toLowerCase()] },
      json: async () => r.body,
    };
  };
  return { impl, calls };
}

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'psbot-')); }

test('fetches, caches, and serves fresh from cache without a request', async () => {
  const dir = tmpDir();
  let t = 1000;
  const { impl, calls } = fakeFetch([
    { status: 200, headers: { etag: '"abc"' }, body: { files: { 'script.txt': { content: 'title x' } } } },
  ]);
  const store = createGistStore({ dataDir: dir, token: 'tok', fetchImpl: impl, now: () => t });
  assert.equal(await store.getSource('abc123'), 'title x');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].opts.headers.authorization, 'Bearer tok');
  t += 60 * 1000;
  assert.equal(await store.getSource('abc123'), 'title x');
  assert.equal(calls.length, 1, 'served from cache');
});

test('revalidates stale cache with the etag and keeps content on 304', async () => {
  const dir = tmpDir();
  let t = 1000;
  const { impl, calls } = fakeFetch([
    { status: 200, headers: { etag: '"abc"' }, body: { files: { 'script.txt': { content: 'v1' } } } },
    { status: 304 },
    { status: 200, headers: { etag: '"def"' }, body: { files: { 'script.txt': { content: 'v2' } } } },
  ]);
  const store = createGistStore({ dataDir: dir, token: 'tok', fetchImpl: impl, now: () => t });
  await store.getSource('ab01');
  t += 11 * 60 * 1000;
  assert.equal(await store.getSource('ab01'), 'v1');
  assert.equal(calls[1].opts.headers['if-none-match'], '"abc"');
  t += 11 * 60 * 1000;
  assert.equal(await store.getSource('ab01'), 'v2');
});

test('errors are user-facing', async () => {
  const dir = tmpDir();
  const { impl } = fakeFetch([
    { status: 404, body: {} },
    { status: 200, headers: {}, body: { files: {} } },
    { status: 200, headers: {}, body: { files: { 'script.txt': { content: 'x'.repeat(1_000_001) } } } },
  ]);
  const store = createGistStore({ dataDir: dir, token: 'tok', fetchImpl: impl });
  await assert.rejects(store.getSource('aaaa'), (e) => e instanceof GistError && /not found/.test(e.message));
  await assert.rejects(store.getSource('bbbb'), (e) => e instanceof GistError && /script\.txt/.test(e.message));
  await assert.rejects(store.getSource('cccc'), (e) => e instanceof GistError && /too large/.test(e.message));
});

test('the download cache is capped, oldest entries evicted first', async () => {
  const dir = tmpDir();
  const big = 'x'.repeat(1000);
  const body = () => ({ status: 200, headers: {}, body: { files: { 'script.txt': { content: big } } } });
  const { impl } = fakeFetch([body(), body(), body(), body()]);
  const store = createGistStore({ dataDir: dir, token: 'tok', fetchImpl: impl, maxCacheBytes: 2500 });
  for (const id of ['aaa1', 'aaa2', 'aaa3', 'aaa4']) { await store.getSource(id); await new Promise((r) => setTimeout(r, 15)); }
  const files = fs.readdirSync(path.join(dir, 'gists')).filter((f) => f.endsWith('.json'));
  assert.ok(files.length <= 2, 'kept ' + files.length);
  assert.ok(files.includes('aaa4.json'), 'newest kept');
  assert.ok(!files.includes('aaa1.json'), 'oldest evicted');
});
