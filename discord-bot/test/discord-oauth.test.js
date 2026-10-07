'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createOAuth, OAuthError } = require('../discord-oauth');

function fakeFetch(responses) {
  const calls = [];
  const impl = async (url, opts) => {
    calls.push({ url, opts });
    const r = responses.shift();
    if (!r) throw new Error('unexpected fetch');
    if (r.throws) throw new Error('network down');
    return { status: r.status, ok: r.status >= 200 && r.status < 300, json: async () => r.body };
  };
  return { impl, calls };
}

test('a code is exchanged for a token and the user it belongs to', async () => {
  const f = fakeFetch([
    { status: 200, body: { access_token: 'tok' } },
    { status: 200, body: { id: 42, username: 'ada', global_name: 'Ada L' } },
  ]);
  const oauth = createOAuth({ clientId: 'app', clientSecret: 'shh', fetchImpl: f.impl });
  assert.deepEqual(await oauth.exchange('the-code'), { accessToken: 'tok', user: { id: '42', name: 'Ada L' } });
  assert.equal(f.calls[0].url, 'https://discord.com/api/oauth2/token');
  assert.equal(f.calls[0].opts.method, 'POST');
  const sent = new URLSearchParams(f.calls[0].opts.body);
  assert.equal(sent.get('client_id'), 'app');
  assert.equal(sent.get('client_secret'), 'shh');
  assert.equal(sent.get('grant_type'), 'authorization_code');
  assert.equal(sent.get('code'), 'the-code');
  assert.equal(f.calls[1].url, 'https://discord.com/api/users/@me');
  assert.equal(f.calls[1].opts.headers.authorization, 'Bearer tok');
});

test('a user with no display name is known by their username', async () => {
  const f = fakeFetch([{ status: 200, body: { access_token: 'tok' } }, { status: 200, body: { id: '7', username: 'bob', global_name: null } }]);
  const out = await createOAuth({ clientId: 'a', clientSecret: 's', fetchImpl: f.impl }).exchange('c');
  assert.equal(out.user.name, 'bob');
});

test('bad codes and failures at Discord are OAuthErrors, and a bad code is never sent', async () => {
  const none = fakeFetch([]);
  const o = createOAuth({ clientId: 'a', clientSecret: 's', fetchImpl: none.impl });
  await assert.rejects(o.exchange(''), OAuthError);
  await assert.rejects(o.exchange(undefined), OAuthError);
  await assert.rejects(o.exchange('x'.repeat(201)), OAuthError);
  assert.equal(none.calls.length, 0);
  const cases = [
    [{ status: 400, body: { error: 'invalid_grant' } }],
    [{ throws: true }],
    [{ status: 200, body: {} }],
    [{ status: 200, body: { access_token: 'tok' } }, { status: 401, body: {} }],
    [{ status: 200, body: { access_token: 'tok' } }, { throws: true }],
  ];
  for (const responses of cases) {
    const f = fakeFetch(responses);
    await assert.rejects(createOAuth({ clientId: 'a', clientSecret: 's', fetchImpl: f.impl }).exchange('c'), OAuthError);
  }
});
