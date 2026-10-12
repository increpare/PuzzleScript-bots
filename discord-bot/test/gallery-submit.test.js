'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createGallerySubmitter } = require('../gallery-submit');
const { GalleryError, readRecords, appendRecord, galleryRecord } = require('../gallery-entry');
const { GistError } = require('../gists');

const GIST = 'abcdef0123456789abcdef0123456789';
const LIST = 'let games_gallery = [\n  {\n    "url": "https://www.puzzlescript.net/play.html?p=6841219",\n    "thumb": "6841219.gif",\n    "title": "Microban",\n    "author": "David Skinner"\n  },\n]';
const gif = Buffer.concat([Buffer.from('GIF89a', 'latin1'), Buffer.from('picture')]);
const body = (change = {}) => Object.assign({ gif: gif.toString('base64'), title: 'A Game', author: 'Someone', homepage: 'example.com' }, change);

// A repository that holds one list and takes commits to it. fail: what addGame throws, if anything.
function fakeRepo({ list = LIST, fail = null } = {}) {
  const repo = { list, commits: [] };
  repo.readGamesDat = async () => repo.list;
  repo.addGame = async ({ gifPath, gif, edit, message }) => {
    const edited = edit(repo.list);
    if (fail) throw fail;
    repo.list = edited;
    repo.commits.push({ gifPath, gif, message });
    return { commitUrl: 'https://github.com/increpare/PuzzleScript/commit/c' + repo.commits.length };
  };
  return repo;
}

// A live site and the bot's own copy of the list, in a temporary directory.
function setup(t, { repo = fakeRepo(), site = true, siteList = LIST } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'psbot-gallery-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const siteDir = path.join(dir, 'site');
  if (site) {
    fs.mkdirSync(path.join(siteDir, 'Gallery', 'gifs'), { recursive: true });
    fs.writeFileSync(path.join(siteDir, 'games_dat.js'), siteList);
  }
  const botGamesDat = path.join(dir, 'bot', 'games_dat.js');
  fs.mkdirSync(path.dirname(botGamesDat));
  fs.writeFileSync(botGamesDat, LIST);
  const added = [];
  const submitter = createGallerySubmitter({
    repo, siteDir, botGamesDat,
    getSource: async (id) => { if (id === 'dead') throw new GistError('gist not found'); return 'title Source of ' + id; },
    onAdded: (record) => added.push(record),
    log: () => {},
  });
  const tmpFiles = () => fs.readdirSync(dir, { recursive: true }).filter((f) => String(f).endsWith('.tmp'));
  return { dir, siteDir, botGamesDat, repo, submitter, added, tmpFiles };
}

test('a good submission is committed, put on the site and added to the bot\'s own list', async (t) => {
  const s = setup(t);
  const out = await s.submitter.submit(GIST, body());
  assert.deepStrictEqual(out, {
    ok: true,
    commitUrl: 'https://github.com/increpare/PuzzleScript/commit/c1',
    galleryUrl: 'https://www.puzzlescript.net/Gallery/index.html',
    site: null,
    botCopy: null,
  });
  const record = galleryRecord({ gistId: GIST, title: 'A Game', author: 'Someone', homepage: 'example.com' });
  assert.strictEqual(s.repo.commits.length, 1);
  assert.strictEqual(s.repo.commits[0].gifPath, 'src/Gallery/gifs/' + GIST + '.gif');
  assert.strictEqual(s.repo.commits[0].message, 'gallery: add A Game by Someone');
  assert.deepStrictEqual(s.repo.commits[0].gif, gif);
  assert.strictEqual(s.repo.list, appendRecord(LIST, record));
  assert.deepStrictEqual(fs.readFileSync(path.join(s.siteDir, 'Gallery', 'gifs', GIST + '.gif')), gif);
  assert.strictEqual(fs.readFileSync(path.join(s.siteDir, 'games_dat.js'), 'utf8'), appendRecord(LIST, record));
  assert.strictEqual(fs.readFileSync(s.botGamesDat, 'utf8'), appendRecord(LIST, record));
  assert.deepStrictEqual(s.added, [record]);
  assert.deepStrictEqual(s.tmpFiles(), []);
});

test('a bad field, or a game already in the list, commits nothing', async (t) => {
  const s = setup(t);
  assert.deepStrictEqual(await s.submitter.submit(GIST, body({ title: '' })), { ok: false, error: 'the title must be 1 to 100 characters on one line' });
  assert.deepStrictEqual(await s.submitter.submit('6841219', body()), { ok: false, error: 'that game is already in the gallery' });
  assert.strictEqual(s.repo.commits.length, 0);
  assert.strictEqual(fs.readFileSync(path.join(s.siteDir, 'games_dat.js'), 'utf8'), LIST);
  assert.strictEqual(fs.readFileSync(s.botGamesDat, 'utf8'), LIST);
  assert.deepStrictEqual(fs.readdirSync(path.join(s.siteDir, 'Gallery', 'gifs')), []);
  assert.deepStrictEqual(s.added, []);
});

test('a commit that fails leaves the site and the bot\'s list alone', async (t) => {
  const s = setup(t, { repo: fakeRepo({ fail: new GalleryError('GitHub could not be reached') }) });
  assert.deepStrictEqual(await s.submitter.submit(GIST, body()), { ok: false, error: 'GitHub could not be reached' });
  assert.strictEqual(fs.readFileSync(path.join(s.siteDir, 'games_dat.js'), 'utf8'), LIST);
  assert.strictEqual(fs.readFileSync(s.botGamesDat, 'utf8'), LIST);
  assert.deepStrictEqual(fs.readdirSync(path.join(s.siteDir, 'Gallery', 'gifs')), []);
  // anything that is not about the submission is a fault, and is not swallowed
  const broken = setup(t, { repo: fakeRepo({ fail: new TypeError('a bug') }) });
  await assert.rejects(broken.submitter.submit(GIST, body()), TypeError);
});

test('a site that cannot be written is reported, and the rest still happens', async (t) => {
  const s = setup(t, { site: false });
  const out = await s.submitter.submit(GIST, body());
  assert.strictEqual(out.ok, true);
  assert.match(out.site, /ENOENT|no such file/);
  assert.strictEqual(out.botCopy, null);
  assert.strictEqual(readRecords(fs.readFileSync(s.botGamesDat, 'utf8')).length, 2);
  assert.strictEqual(s.added.length, 1);
});

test('a site list that already has the game is left as it is, and said to be', async (t) => {
  const record = galleryRecord({ gistId: GIST, title: 'Earlier', author: 'Hand', homepage: '' });
  const siteList = appendRecord(LIST, record);
  const s = setup(t, { siteList });
  const out = await s.submitter.submit(GIST, body());
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.site, 'that game is already in the gallery');
  assert.strictEqual(fs.readFileSync(path.join(s.siteDir, 'games_dat.js'), 'utf8'), siteList);
});

test('a site list that differs from master keeps its differences', async (t) => {
  const siteList = LIST.replace('Microban', 'Microban (live)');
  const s = setup(t, { siteList });
  await s.submitter.submit(GIST, body());
  const records = readRecords(fs.readFileSync(path.join(s.siteDir, 'games_dat.js'), 'utf8'));
  assert.deepStrictEqual(records.map((r) => r.title), ['Microban (live)', 'A Game']);
});

test('submissions are taken one at a time', async (t) => {
  const repo = fakeRepo();
  const order = [];
  const add = repo.addGame;
  repo.addGame = async (job) => { order.push('start ' + job.message); await new Promise((r) => setTimeout(r, 20)); const out = await add(job); order.push('end ' + job.message); return out; };
  const s = setup(t, { repo });
  const other = '1111111111111111';
  const [a, b] = await Promise.all([s.submitter.submit(GIST, body({ title: 'One' })), s.submitter.submit(other, body({ title: 'Two' }))]);
  assert.ok(a.ok && b.ok);
  assert.deepStrictEqual(order, ['start gallery: add One by Someone', 'end gallery: add One by Someone', 'start gallery: add Two by Someone', 'end gallery: add Two by Someone']);
  assert.strictEqual(readRecords(fs.readFileSync(s.botGamesDat, 'utf8')).length, 3);
});

test('game() gives the source and says whether it is in the gallery already', async (t) => {
  const s = setup(t);
  assert.deepStrictEqual(await s.submitter.game(GIST), { gistId: GIST, source: 'title Source of ' + GIST, inGallery: false });
  assert.strictEqual((await s.submitter.game('6841219')).inGallery, true);
  await assert.rejects(s.submitter.game('dead'), (e) => e instanceof GalleryError && /gist not found/.test(e.message));
});
