'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createGalleryRepo } = require('../gallery-github');
const { GalleryError } = require('../gallery-entry');

const API = 'https://api.github.com/repos/increpare/PuzzleScript/';

// Enough of GitHub's Git Data API to make a commit against: a branch, its commits and their trees.
// movedTimes: how many ref updates find that somebody else has committed in the meantime.
function fakeGitHub({ gamesDat = 'one', movedTimes = 0, status = null, protectedBranch = false } = {}) {
  const gh = { head: 'c0', commits: { c0: { tree: 't0', parents: [] } }, trees: { t0: { 'src/games_dat.js': gamesDat } }, blobs: {}, calls: [], n: 0 };
  const answer = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => body });
  gh.fetchImpl = async (url, opts = {}) => {
    assert.ok(url.startsWith(API), url);
    const method = opts.method || 'GET';
    const path = url.slice(API.length);
    const body = opts.body ? JSON.parse(opts.body) : null;
    gh.calls.push({ method, path, body, headers: opts.headers });
    if (status) return answer(status, { message: 'no' });
    let m;
    if (method === 'GET' && path === 'git/ref/heads/master') return answer(200, { object: { sha: gh.head } });
    if (method === 'GET' && (m = /^git\/commits\/(\w+)$/.exec(path))) return answer(200, { sha: m[1], tree: { sha: gh.commits[m[1]].tree } });
    if (method === 'GET' && (m = /^contents\/src\/games_dat\.js\?ref=(\w+)$/.exec(path))) {
      assert.match(opts.headers.accept, /raw/);
      return answer(200, gh.trees[gh.commits[m[1]].tree]['src/games_dat.js']);
    }
    if (method === 'POST' && path === 'git/blobs') { const sha = 'b' + (++gh.n); gh.blobs[sha] = body; return answer(201, { sha }); }
    if (method === 'POST' && path === 'git/trees') {
      const sha = 't' + (++gh.n);
      const tree = Object.assign({}, gh.trees[body.base_tree]);
      for (const e of body.tree) tree[e.path] = e.sha ? gh.blobs[e.sha] : e.content;
      gh.trees[sha] = tree;
      return answer(201, { sha });
    }
    if (method === 'POST' && path === 'git/commits') { const sha = 'c' + (++gh.n); gh.commits[sha] = { tree: body.tree, parents: body.parents, message: body.message }; return answer(201, { sha }); }
    if (method === 'PATCH' && path === 'git/refs/heads/master') {
      if (protectedBranch) return answer(422, { message: 'Changes must be made through a pull request.' });
      if (movedTimes > 0) {
        movedTimes--;
        // somebody else's commit, which changed the list
        const tree = 't' + (++gh.n), sha = 'c' + (++gh.n);
        gh.trees[tree] = Object.assign({}, gh.trees[gh.commits[gh.head].tree], { 'src/games_dat.js': gh.trees[gh.commits[gh.head].tree]['src/games_dat.js'] + '+theirs' });
        gh.commits[sha] = { tree, parents: [gh.head] };
        gh.head = sha;
        return answer(422, { message: 'Update is not a fast forward' });
      }
      assert.deepStrictEqual(gh.commits[body.sha].parents, [gh.head]);
      gh.head = body.sha;
      return answer(200, { object: { sha: body.sha } });
    }
    return answer(404, { message: 'Not Found' });
  };
  return gh;
}

const gif = Buffer.from('GIF89a-picture', 'latin1');
const job = (edit = (text) => text + '+ours') => ({ gifPath: 'src/Gallery/gifs/abc.gif', gif, edit, message: 'gallery: add T by A' });

test('reads the list at the head of master', async () => {
  const gh = fakeGitHub({ gamesDat: 'the list' });
  const repo = createGalleryRepo({ token: 'tok', fetchImpl: gh.fetchImpl });
  assert.strictEqual(await repo.readGamesDat(), 'the list');
});

test('one commit adds the picture and the edited list', async () => {
  const gh = fakeGitHub();
  const repo = createGalleryRepo({ token: 'tok', fetchImpl: gh.fetchImpl });
  const made = await repo.addGame(job());
  assert.strictEqual(made.commitUrl, 'https://github.com/increpare/PuzzleScript/commit/' + gh.head);
  const commit = gh.commits[gh.head];
  assert.deepStrictEqual(commit.parents, ['c0']);
  assert.strictEqual(commit.message, 'gallery: add T by A');
  const tree = gh.trees[commit.tree];
  assert.strictEqual(tree['src/games_dat.js'], 'one+ours');
  assert.deepStrictEqual(tree['src/Gallery/gifs/abc.gif'], { content: gif.toString('base64'), encoding: 'base64' });
  // built on the head's own tree, so nothing else in the repository changes
  const treeCall = gh.calls.find((c) => c.path === 'git/trees');
  assert.strictEqual(treeCall.body.base_tree, 't0');
  assert.ok(treeCall.body.tree.every((e) => e.mode === '100644' && e.type === 'blob'));
  assert.strictEqual(gh.calls.filter((c) => c.path === 'git/commits' && c.method === 'POST').length, 1);
  const update = gh.calls.find((c) => c.method === 'PATCH');
  assert.strictEqual(update.body.force, false);
  for (const c of gh.calls) {
    assert.strictEqual(c.headers.authorization, 'Bearer tok');
    assert.strictEqual(c.headers['x-github-api-version'], '2022-11-28');
  }
});

test('when master moves in the meantime it is done again from the new head', async () => {
  const gh = fakeGitHub({ movedTimes: 1 });
  const repo = createGalleryRepo({ token: 'tok', fetchImpl: gh.fetchImpl });
  const seen = [];
  await repo.addGame(job((text) => { seen.push(text); return text + '+ours'; }));
  assert.deepStrictEqual(seen, ['one', 'one+theirs']);
  const commit = gh.commits[gh.head];
  assert.strictEqual(gh.trees[commit.tree]['src/games_dat.js'], 'one+theirs+ours');
  // on their commit, not beside it
  assert.strictEqual(gh.commits[commit.parents[0]].parents[0], 'c0');
});

test('a master that keeps moving is given up on', async () => {
  const gh = fakeGitHub({ movedTimes: 2 });
  const repo = createGalleryRepo({ token: 'tok', fetchImpl: gh.fetchImpl });
  await assert.rejects(repo.addGame(job()), (e) => e instanceof GalleryError && /changing/.test(e.message));
  assert.strictEqual(gh.calls.filter((c) => c.method === 'PATCH').length, 2);
});

test('a branch that refuses the commit for another reason is not tried again', async () => {
  const gh = fakeGitHub({ protectedBranch: true });
  const repo = createGalleryRepo({ token: 'tok', fetchImpl: gh.fetchImpl });
  await assert.rejects(repo.addGame(job()), (e) => e instanceof GalleryError && /pull request/.test(e.message));
  assert.strictEqual(gh.calls.filter((c) => c.method === 'PATCH').length, 1);
  assert.strictEqual(gh.head, 'c0');
});

test('a refused token and an unreachable GitHub are said plainly', async () => {
  for (const status of [401, 403]) {
    const gh = fakeGitHub({ status });
    const repo = createGalleryRepo({ token: 'tok', fetchImpl: gh.fetchImpl });
    await assert.rejects(repo.addGame(job()), (e) => e instanceof GalleryError && /token/.test(e.message));
  }
  const gh = fakeGitHub({ status: 500 });
  await assert.rejects(createGalleryRepo({ token: 'tok', fetchImpl: gh.fetchImpl }).readGamesDat(), (e) => e instanceof GalleryError && /500/.test(e.message));
  const down = createGalleryRepo({ token: 'tok', fetchImpl: async () => { throw new Error('ECONNRESET'); } });
  await assert.rejects(down.addGame(job()), (e) => e instanceof GalleryError && /reached/.test(e.message));
});

test('an edit that refuses stops everything before anything is written', async () => {
  const gh = fakeGitHub();
  const repo = createGalleryRepo({ token: 'tok', fetchImpl: gh.fetchImpl });
  await assert.rejects(repo.addGame(job(() => { throw new GalleryError('that game is already in the gallery'); })), /already in the gallery/);
  assert.ok(gh.calls.every((c) => c.method === 'GET'));
  assert.strictEqual(gh.head, 'c0');
});
