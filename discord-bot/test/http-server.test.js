'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { createHttpServer } = require('../http-server');
const { OAuthError } = require('../discord-oauth');

async function start(t, { oauth } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'psbot-http-'));
  const staticDir = path.join(dir, 'site');
  fs.mkdirSync(path.join(staticDir, 'vendor'), { recursive: true });
  fs.writeFileSync(path.join(staticDir, 'index.html'), '<p>hello</p>');
  fs.writeFileSync(path.join(staticDir, 'vendor', 'lib.js'), 'var x = 1;');
  fs.writeFileSync(path.join(staticDir, 'notes.txt'), 'not a served type');
  fs.writeFileSync(path.join(dir, 'secret.js'), 'var secret = 1;');
  const reports = [];
  const server = createHttpServer({
    staticDir,
    oauth: oauth || { exchange: async (code) => ({ accessToken: 'tok-' + code, user: { id: '1', name: 'n' } }) },
    onReport: (r) => reports.push(r),
    log: () => {},
  });
  const port = await server.listen(0);
  t.after(() => server.close());
  return { base: 'http://127.0.0.1:' + port, port, reports };
}

const post = (url, body) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) });

// fetch() tidies ".." out of a URL before sending it, so path traversal is tried with a raw request.
function rawGet(port, rawPath) {
  return new Promise((resolve, reject) => {
    http.request({ host: '127.0.0.1', port, path: rawPath, method: 'GET' }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    }).on('error', reject).end();
  });
}

test('serves the page and its files, with their types', async (t) => {
  const { base } = await start(t);
  const index = await fetch(base + '/');
  assert.equal(index.status, 200);
  assert.match(index.headers.get('content-type'), /^text\/html/);
  assert.equal(await index.text(), '<p>hello</p>');
  const lib = await fetch(base + '/vendor/lib.js');
  assert.match(lib.headers.get('content-type'), /^text\/javascript/);
  assert.equal(await lib.text(), 'var x = 1;');
  const head = await fetch(base + '/vendor/lib.js', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
});

test('serves nothing outside the page directory, and no other file types', async (t) => {
  const { base, port } = await start(t);
  assert.equal((await fetch(base + '/missing.js')).status, 404);
  assert.equal((await fetch(base + '/notes.txt')).status, 404);
  assert.equal((await fetch(base + '/vendor')).status, 404);
  for (const p of ['/../secret.js', '/..%2fsecret.js', '/vendor/..%2f..%2fsecret.js', '/%2e%2e/secret.js', '/vendor/%00.js', '/%zz.js']) {
    const r = await rawGet(port, p);
    assert.equal(r.status, 404, p);
    assert.doesNotMatch(r.body, /secret/, p);
  }
  assert.equal((await post(base + '/vendor/lib.js', {})).status, 405);
});

test('token: a code becomes an access token', async (t) => {
  const { base } = await start(t);
  const r = await post(base + '/api/token', { code: 'abc' });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { access_token: 'tok-abc' });
});

test('token: a refusal at Discord is a 401 with its reason, and bad bodies are refused', async (t) => {
  const { base } = await start(t, { oauth: { exchange: async () => { throw new OAuthError('Discord refused the code (400)'); } } });
  const r = await post(base + '/api/token', { code: 'abc' });
  assert.equal(r.status, 401);
  assert.deepEqual(await r.json(), { error: 'Discord refused the code (400)' });
  assert.equal((await post(base + '/api/token', 'not json')).status, 400);
  assert.equal((await post(base + '/api/token', '[1]')).status, 400);
  assert.equal((await post(base + '/api/token', { code: 'x'.repeat(70 * 1024) })).status, 413);
});

test('a failure that is not about sign-in is a 500 that says nothing', async (t) => {
  const { base } = await start(t, { oauth: { exchange: async () => { throw new Error('secret detail'); } } });
  const r = await post(base + '/api/token', { code: 'abc' });
  assert.equal(r.status, 500);
  assert.deepEqual(await r.json(), { error: 'server error' });
});

test('ping answers with or without the proxy prefix; unknown api paths are 404', async (t) => {
  const { base } = await start(t);
  assert.deepEqual(await (await fetch(base + '/api/ping')).json(), { ok: true, path: '/api/ping' });
  assert.deepEqual(await (await fetch(base + '/.proxy/api/ping')).json(), { ok: true, path: '/.proxy/api/ping' });
  assert.equal((await fetch(base + '/api/nope')).status, 404);
  assert.equal((await fetch(base + '/api/token')).status, 404);
});

test('spike reports are handed on', async (t) => {
  const { base, reports } = await start(t);
  const r = await post(base + '/api/spike-report', { steps: [{ name: 'x', ok: true }] });
  assert.deepEqual(await r.json(), { ok: true });
  assert.deepEqual(reports, [{ steps: [{ name: 'x', ok: true }] }]);
});
