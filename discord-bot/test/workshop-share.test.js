'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createSharer, titleOf } = require('../workshop-share');

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
const GAME = 'title My Game\nauthor Me\n\n========\nOBJECTS\n';

test('a game\'s title is read from its source', () => {
  assert.equal(titleOf(GAME), 'My Game');
  assert.equal(titleOf('(a comment)\n  TITLE   Spaced Out  \nauthor x'), 'Spaced Out');
  assert.equal(titleOf('author x\nOBJECTS'), null);
  assert.equal(titleOf(''), null);
});

test('sharing makes a public gist shaped as the editor\'s own share makes it, and gives back its links', async () => {
  const f = fakeFetch([{ status: 201, body: { id: 'abc123def456' } }]);
  const sharer = createSharer({ token: 'tok', fetchImpl: f.impl });
  assert.deepEqual(await sharer.share('u1', GAME), {
    ok: true, id: 'abc123def456', title: 'My Game',
    playUrl: 'https://www.puzzlescript.net/play.html?p=abc123def456',
    editUrl: 'https://www.puzzlescript.net/editor.html?hack=abc123def456',
  });
  assert.equal(f.calls[0].url, 'https://api.github.com/gists');
  assert.equal(f.calls[0].opts.method, 'POST');
  assert.equal(f.calls[0].opts.headers.authorization, 'Bearer tok');
  assert.deepEqual(JSON.parse(f.calls[0].opts.body), {
    description: 'My Game (PuzzleScript Script)',
    public: true,
    files: {
      'readme.txt': { content: 'Play this game by pasting the script in http://www.puzzlescript.net/editor.html' },
      'script.txt': { content: GAME },
    },
  });
});

test('a game with no title is shared as untitled', async () => {
  const f = fakeFetch([{ status: 201, body: { id: 'abc123' } }]);
  const r = await createSharer({ token: 'tok', fetchImpl: f.impl }).share('u1', 'OBJECTS\n');
  assert.equal(r.title, 'Untitled');
  assert.equal(JSON.parse(f.calls[0].opts.body).description, 'Untitled PuzzleScript Script');
});

test('nothing is sent for an empty document, and GitHub\'s refusals are reported plainly', async () => {
  const none = fakeFetch([]);
  assert.deepEqual(await createSharer({ token: 'tok', fetchImpl: none.impl }).share('u1', '  \n'), { ok: false, error: 'there is nothing to share yet' });
  assert.equal(none.calls.length, 0);
  const cases = [
    [{ status: 401, body: {} }, /GitHub did not accept the bot's token/],
    [{ status: 403, body: {} }, /GitHub did not accept the bot's token/],
    [{ status: 500, body: {} }, /GitHub answered with an error \(500\)/],
    [{ throws: true }, /GitHub could not be reached/],
    [{ status: 201, body: {} }, /GitHub answered with an error/],
    [{ status: 201, body: { id: 'not hex!' } }, /GitHub answered with an error/],
  ];
  for (const [response, re] of cases) {
    const r = await createSharer({ token: 'tok', fetchImpl: fakeFetch([response]).impl }).share('u1', GAME);
    assert.equal(r.ok, false);
    assert.match(r.error, re);
  }
});

test('sharing is limited per person and overall, by the hour, counting only what was shared', async () => {
  let clock = 0;
  const ok = () => ({ status: 201, body: { id: 'abc123' } });
  const f = fakeFetch([ok(), { status: 500, body: {} }, ok(), ok(), ok(), ok()]);
  const sharer = createSharer({ token: 'tok', fetchImpl: f.impl, now: () => clock, perUserHour: 2, perHour: 3 });
  assert.equal((await sharer.share('u1', GAME)).ok, true);
  assert.equal((await sharer.share('u1', GAME)).ok, false); // GitHub's error: does not count
  assert.equal((await sharer.share('u1', GAME)).ok, true);
  const third = await sharer.share('u1', GAME);
  assert.deepEqual(third, { ok: false, error: 'you have shared 2 games in the last hour; try again later' });
  assert.equal((await sharer.share('u2', GAME)).ok, true);
  assert.deepEqual(await sharer.share('u3', GAME), { ok: false, error: 'the workshop has shared 3 games in the last hour; try again later' });
  clock = 60 * 60 * 1000;
  assert.equal((await sharer.share('u1', GAME)).ok, true);
});
