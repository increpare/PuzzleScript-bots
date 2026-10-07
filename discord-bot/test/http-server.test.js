'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { createHttpServer } = require('../http-server');
const { OAuthError } = require('../discord-oauth');
const { createSigner } = require('../signing');

const DAY = 24 * 60 * 60 * 1000;

async function start(t, { oauth, api, now = () => 0 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'psbot-http-'));
  const staticDir = path.join(dir, 'site');
  fs.mkdirSync(path.join(staticDir, 'vendor'), { recursive: true });
  fs.writeFileSync(path.join(staticDir, 'index.html'), '<p>hello</p>');
  fs.writeFileSync(path.join(staticDir, 'vendor', 'lib.js'), 'var x = 1;');
  fs.writeFileSync(path.join(staticDir, 'notes.txt'), 'not a served type');
  fs.writeFileSync(path.join(dir, 'secret.js'), 'var secret = 1;');
  const signer = createSigner('test key', { now });
  const calls = [];
  const server = createHttpServer({
    staticDir,
    oauth: oauth || { exchange: async (code) => ({ accessToken: 'tok-' + code, user: { id: '42', name: 'n' } }) },
    signer,
    api: api || {
      tweak: async (uid) => { calls.push(['tweak', uid]); return uid === '42' ? { title: 'T', levelText: '#p#', ticket: 'tk' } : null; },
      submit: async (uid, body) => { calls.push(['submit', uid, body]); return { ok: true, url: 'https://discord.com/channels/1/2/3' }; },
    },
    log: () => {},
  });
  const port = await server.listen(0);
  t.after(() => server.close());
  return { base: 'http://127.0.0.1:' + port, port, signer, calls };
}

const bearer = (session) => ({ authorization: 'Bearer ' + session });

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

test('token: a code becomes an access token and a session for that user', async (t) => {
  const { base, signer } = await start(t);
  const r = await post(base + '/api/token', { code: 'abc' });
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.access_token, 'tok-abc');
  assert.deepEqual(signer.verify(body.session), { uid: '42' });
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

test('unknown api paths and wrong methods are 404', async (t) => {
  const { base } = await start(t);
  assert.equal((await fetch(base + '/api/nope')).status, 404);
  assert.equal((await fetch(base + '/api/token')).status, 404);
  assert.equal((await fetch(base + '/api/ping')).status, 404);
  assert.equal((await post(base + '/api/tweak', {})).status, 404);
  assert.equal((await fetch(base + '/api/levels')).status, 404);
});

test('tweak: what the signed-in user is about to edit, or 404 when there is nothing', async (t) => {
  const { base, signer, calls } = await start(t);
  const r = await fetch(base + '/api/tweak', { headers: bearer(signer.sign({ uid: '42' }, DAY)) });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { title: 'T', levelText: '#p#', ticket: 'tk' });
  const none = await fetch(base + '/api/tweak', { headers: bearer(signer.sign({ uid: '7' }, DAY)) });
  assert.equal(none.status, 404);
  assert.deepEqual(await none.json(), { error: 'nothing to edit' });
  assert.deepEqual(calls, [['tweak', '42'], ['tweak', '7']]);
});

test('levels: a level is handed on with the session\'s user, and the answer is passed back', async (t) => {
  const { base, signer, calls } = await start(t);
  const r = await fetch(base + '/api/levels', { method: 'POST', headers: Object.assign({ 'content-type': 'application/json' }, bearer(signer.sign({ uid: '42' }, DAY))), body: JSON.stringify({ ticket: 'tk', text: '#p#' }) });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true, url: 'https://discord.com/channels/1/2/3' });
  assert.deepEqual(calls, [['submit', '42', { ticket: 'tk', text: '#p#' }]]);
});

test('without a session that is valid, signed here and unexpired, the api answers 401 and does nothing', async (t) => {
  let clock = 0;
  const { base, signer, calls } = await start(t, { now: () => clock });
  const good = signer.sign({ uid: '42' }, DAY);
  const forged = createSigner('another key', { now: () => clock }).sign({ uid: '42' }, DAY);
  const noUid = signer.sign({ name: 'x' }, DAY);
  for (const headers of [{}, { authorization: 'Bearer ' }, { authorization: good }, bearer(good.slice(0, -2) + 'AA'), bearer(forged), bearer(noUid)]) {
    const r = await fetch(base + '/api/tweak', { headers });
    assert.equal(r.status, 401, JSON.stringify(headers));
    assert.deepEqual(await r.json(), { error: 'sign in again' });
    assert.equal((await fetch(base + '/api/levels', { method: 'POST', headers: Object.assign({ 'content-type': 'application/json' }, headers), body: '{}' })).status, 401);
  }
  clock = DAY;
  assert.equal((await fetch(base + '/api/tweak', { headers: bearer(good) })).status, 401);
  assert.deepEqual(calls, []);
});
