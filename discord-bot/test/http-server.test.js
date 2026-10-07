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

async function start(t, { oauth, api, now = () => 0, indexHtml, workshop, workshopSaves, workshopShare, devSession } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'psbot-http-'));
  const staticDir = path.join(dir, 'site');
  // a second directory, looked in after the first
  const otherDir = path.join(dir, 'other');
  fs.mkdirSync(path.join(staticDir, 'vendor'), { recursive: true });
  fs.mkdirSync(path.join(otherDir, 'demo'), { recursive: true });
  fs.writeFileSync(path.join(staticDir, 'index.html'), '<p>hello</p>');
  fs.writeFileSync(path.join(staticDir, 'vendor', 'lib.js'), 'var x = 1;');
  fs.writeFileSync(path.join(staticDir, 'notes.md'), 'not a served type');
  fs.writeFileSync(path.join(otherDir, 'demo', 'game.txt'), 'title Game');
  fs.writeFileSync(path.join(otherDir, 'index.html'), '<p>the other index</p>');
  fs.mkdirSync(path.join(otherDir, 'vendor'), { recursive: true });
  fs.writeFileSync(path.join(otherDir, 'vendor', 'lib.js'), 'var shadowed = 1;');
  fs.writeFileSync(path.join(dir, 'secret.js'), 'var secret = 1;');
  const signer = createSigner('test key', { now });
  const calls = [];
  const server = createHttpServer({
    staticDirs: [staticDir, otherDir],
    indexHtml,
    workshop,
    workshopSaves,
    workshopShare,
    devSession,
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

test('a file is looked for in each directory in turn, and the first one found is served', async (t) => {
  const { base } = await start(t);
  const game = await fetch(base + '/demo/game.txt');
  assert.equal(game.status, 200);
  assert.match(game.headers.get('content-type'), /^text\/plain/);
  assert.equal(await game.text(), 'title Game');
  assert.equal(await (await fetch(base + '/vendor/lib.js')).text(), 'var x = 1;');
  assert.equal(await (await fetch(base + '/')).text(), '<p>hello</p>');
});

test('the front page can be given as text, in place of any index.html', async (t) => {
  const { base } = await start(t, { indexHtml: '<p>made up</p>' });
  const index = await fetch(base + '/');
  assert.match(index.headers.get('content-type'), /^text\/html/);
  assert.equal(await index.text(), '<p>made up</p>');
  assert.equal((await fetch(base + '/', { method: 'HEAD' })).status, 200);
  assert.equal(await (await fetch(base + '/vendor/lib.js')).text(), 'var x = 1;');
});

test('serves nothing outside the page directory, and no other file types', async (t) => {
  const { base, port } = await start(t);
  assert.equal((await fetch(base + '/missing.js')).status, 404);
  assert.equal((await fetch(base + '/notes.md')).status, 404);
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

// ---- the workshop's shared document ----
const { WorkshopError } = require('../workshop-doc');

function fakeWorkshop() {
  const calls = [];
  const pulls = [];
  return {
    calls, pulls,
    state: () => ({ doc: 'title T', version: 3 }),
    push(version, updates) {
      calls.push(['push', version, updates]);
      if (version === 99) throw new WorkshopError('a change does not fit the document');
      return { accepted: version === 3 };
    },
    pull(version) {
      let resolve;
      const waiting = { version, cancelled: false, promise: new Promise((r) => { resolve = r; }), cancel() { waiting.cancelled = true; resolve({ updates: [] }); }, answer: (r) => resolve(r) };
      pulls.push(waiting);
      return waiting;
    },
  };
}
const jsonPost = (url, session, body) => fetch(url, { method: 'POST', headers: Object.assign({ 'content-type': 'application/json' }, session ? bearer(session) : {}), body: JSON.stringify(body) });

test('workshop: the document, pushing changes and waiting for them all need a session', async (t) => {
  const workshop = fakeWorkshop();
  const { base, signer } = await start(t, { workshop });
  assert.equal((await fetch(base + '/api/workshop')).status, 401);
  assert.equal((await jsonPost(base + '/api/workshop/push', null, { version: 3, updates: [] })).status, 401);
  assert.equal((await fetch(base + '/api/workshop/pull?version=3')).status, 401);
  assert.deepEqual(workshop.calls, []);
  assert.deepEqual(workshop.pulls, []);

  const session = signer.sign({ uid: '42' }, DAY);
  assert.deepEqual(await (await fetch(base + '/api/workshop', { headers: bearer(session) })).json(), { canShare: false, doc: 'title T', version: 3 });
  assert.equal((await jsonPost(base + '/api/workshop/share', session, {})).status, 404); // sharing is not set up
  assert.deepEqual(await (await jsonPost(base + '/api/workshop/push', session, { version: 3, updates: [{ clientID: 'a', changes: [7] }] })).json(), { accepted: true });
  assert.deepEqual(await (await jsonPost(base + '/api/workshop/push', session, { version: 2, updates: [{ clientID: 'a', changes: [7] }] })).json(), { accepted: false });
  assert.deepEqual(workshop.calls[0], ['push', 3, [{ clientID: 'a', changes: [7] }]]);
  const refused = await jsonPost(base + '/api/workshop/push', session, { version: 99, updates: [] });
  assert.equal(refused.status, 400);
  assert.deepEqual(await refused.json(), { error: 'a change does not fit the document' });
});

test('workshop: a pull is held open until there is something to say', async (t) => {
  const workshop = fakeWorkshop();
  const { base, signer } = await start(t, { workshop });
  const session = signer.sign({ uid: '42' }, DAY);
  let answered = null;
  const pending = fetch(base + '/api/workshop/pull?version=3', { headers: bearer(session) }).then((r) => r.json()).then((j) => { answered = j; });
  while (workshop.pulls.length === 0) await new Promise((r) => setTimeout(r, 5));
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(answered, null);
  assert.equal(workshop.pulls[0].version, 3);
  workshop.pulls[0].answer({ updates: [{ clientID: 'b', changes: [7] }] });
  await pending;
  assert.deepEqual(answered, { updates: [{ clientID: 'b', changes: [7] }] });
});

test('workshop: a pull whose asker goes away is cancelled', async (t) => {
  const workshop = fakeWorkshop();
  const { base, signer } = await start(t, { workshop });
  const gone = new AbortController();
  const pending = fetch(base + '/api/workshop/pull?version=3', { headers: bearer(signer.sign({ uid: '42' }, DAY)), signal: gone.signal }).catch(() => 'aborted');
  while (workshop.pulls.length === 0) await new Promise((r) => setTimeout(r, 5));
  gone.abort();
  assert.equal(await pending, 'aborted');
  for (let i = 0; i < 100 && !workshop.pulls[0].cancelled; i++) await new Promise((r) => setTimeout(r, 5));
  assert.equal(workshop.pulls[0].cancelled, true);
});

test('workshop: a whole game can be pushed in one change, though other requests stay small', async (t) => {
  const workshop = fakeWorkshop();
  const { base, signer } = await start(t, { workshop });
  const session = signer.sign({ uid: '42' }, DAY);
  const big = { version: 3, updates: [{ clientID: 'a', changes: [[0, 'x'.repeat(500 * 1024)]] }] };
  assert.equal((await jsonPost(base + '/api/workshop/push', session, big)).status, 200);
  assert.equal((await jsonPost(base + '/api/levels', session, { text: 'x'.repeat(500 * 1024) })).status, 413);
  const tooBig = { version: 3, updates: [{ clientID: 'a', changes: [[0, 'x'.repeat(3 * 1024 * 1024)]] }] };
  assert.equal((await jsonPost(base + '/api/workshop/push', session, tooBig)).status, 413);
});

test('without a workshop there are no workshop routes', async (t) => {
  const { base, signer } = await start(t);
  assert.equal((await fetch(base + '/api/workshop', { headers: bearer(signer.sign({ uid: '42' }, DAY)) })).status, 404);
});

test('a session without Discord is only given out when that has been switched on, for working on the page', async (t) => {
  const off = await start(t);
  assert.equal((await fetch(off.base + '/api/dev-session')).status, 404);
  const on = await start(t, { devSession: true, workshop: fakeWorkshop() });
  const r = await fetch(on.base + '/api/dev-session');
  assert.equal(r.status, 200);
  const { session } = await r.json();
  assert.match(on.signer.verify(session).uid, /^dev-/);
  assert.equal((await fetch(on.base + '/api/workshop', { headers: bearer(session) })).status, 200);
});

test('workshop saves: the list is fetched and added to, and a new save lets waiting editors know', async (t) => {
  const workshop = fakeWorkshop();
  let nudges = 0;
  workshop.nudge = () => { nudges++; };
  let rev = 4;
  const added = [];
  const workshopSaves = {
    rev: () => rev,
    get: () => ({ saves: [], autosaves: [], rev }),
    add(group, entry) {
      if (group === 'nope') throw new WorkshopError('bad save group');
      added.push([group, entry]);
      if (entry.text !== 'same as before') rev++;
      return { saves: [entry], autosaves: [], rev };
    },
  };
  const { base, signer } = await start(t, { workshop, workshopSaves });
  assert.equal((await fetch(base + '/api/workshop/saves')).status, 401);
  const session = signer.sign({ uid: '42' }, DAY);
  assert.deepEqual(await (await fetch(base + '/api/workshop/saves', { headers: bearer(session) })).json(), { saves: [], autosaves: [], rev: 4 });
  const r = await jsonPost(base + '/api/workshop/saves', session, { group: 'saves', entry: { title: 'T', text: 'title T' } });
  assert.deepEqual(await r.json(), { saves: [{ title: 'T', text: 'title T' }], autosaves: [], rev: 5 });
  assert.equal(nudges, 1);
  await jsonPost(base + '/api/workshop/saves', session, { group: 'saves', entry: { title: 'T', text: 'same as before' } });
  assert.equal(nudges, 1); // nothing changed, so nobody is disturbed
  const bad = await jsonPost(base + '/api/workshop/saves', session, { group: 'nope', entry: {} });
  assert.equal(bad.status, 400);
  assert.deepEqual(await bad.json(), { error: 'bad save group' });

  // an answer to a pull says which revision of the save list is current
  let answered = null;
  const pending = fetch(base + '/api/workshop/pull?version=3', { headers: bearer(session) }).then((x) => x.json()).then((j) => { answered = j; });
  while (workshop.pulls.length === 0) await new Promise((x) => setTimeout(x, 5));
  workshop.pulls[0].answer({ updates: [] });
  await pending;
  assert.deepEqual(answered, { savesRev: 5, updates: [] });
});

test('workshop share: offered when it is set up, and done as the signed-in user', async (t) => {
  const asked = [];
  const { base, signer } = await start(t, { workshop: fakeWorkshop(), workshopShare: async (uid) => { asked.push(uid); return { ok: true, playUrl: 'https://www.puzzlescript.net/play.html?p=abc' }; } });
  assert.equal((await jsonPost(base + '/api/workshop/share', null, {})).status, 401);
  const session = signer.sign({ uid: '42' }, DAY);
  assert.equal((await (await fetch(base + '/api/workshop', { headers: bearer(session) })).json()).canShare, true);
  assert.deepEqual(await (await jsonPost(base + '/api/workshop/share', session, {})).json(), { ok: true, playUrl: 'https://www.puzzlescript.net/play.html?p=abc' });
  assert.deepEqual(asked, ['42']);
});
