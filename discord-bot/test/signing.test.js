'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createSigner, signingKey } = require('../signing');

test('a signed payload comes back, until it expires', () => {
  let t = 1000;
  const signer = createSigner('key', { now: () => t });
  const token = signer.sign({ uid: '42', n: 1 }, 5000);
  assert.match(token, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  assert.deepEqual(signer.verify(token), { uid: '42', n: 1 });
  t = 5999;
  assert.deepEqual(signer.verify(token), { uid: '42', n: 1 });
  t = 6000;
  assert.equal(signer.verify(token), null);
});

test('anything altered, signed with another key, or not a token at all is refused', () => {
  const signer = createSigner('key', { now: () => 0 });
  const token = signer.sign({ uid: '42' }, 5000);
  for (let i = 0; i < token.length; i++) {
    if (token[i] === '.') continue;
    const altered = token.slice(0, i) + (token[i] === 'A' ? 'B' : 'A') + token.slice(i + 1);
    assert.equal(signer.verify(altered), null, 'position ' + i);
  }
  assert.equal(createSigner('other key', { now: () => 0 }).verify(token), null);
  for (const junk of ['', 'abc', '.', 'a.b', 'a.b.c', undefined, null, 42, token + '.x', token.split('.')[0]]) assert.equal(signer.verify(junk), null, String(junk));
  // a payload moved onto another payload's signature
  const other = signer.sign({ uid: '43' }, 5000);
  assert.equal(signer.verify(other.split('.')[0] + '.' + token.split('.')[1]), null);
});

test('the signing key is derived from the bot token, and is not the token', () => {
  const key = signingKey('bot-token');
  assert.equal(key.length, 32);
  assert.deepEqual(key, signingKey('bot-token'));
  assert.notDeepEqual(key, signingKey('another-token'));
  assert.equal(key.includes(Buffer.from('bot-token')), false);
});
