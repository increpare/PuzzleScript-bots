'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { checkLevelText, levelId, splice } = require('../levels');
const { createHost } = require('../engine-host');
const { SRC_DIR } = require('../engine-src');

const DEMO_DIR = path.join(SRC_DIR, 'demo');

test('a level is tidied: line endings, trailing spaces, blank lines around it', () => {
  assert.deepEqual(checkLevelText('\r\n\r\n ###  \r\n #P#\t\r\n ###\r\n\r\n'), { ok: true, text: '###\n#P#\n###' });
  assert.deepEqual(checkLevelText('#'), { ok: true, text: '#' });
});

test('what is not one rectangular level is refused, with a reason', () => {
  const refused = (text, re) => {
    const r = checkLevelText(text);
    assert.equal(r.ok, false, JSON.stringify(text));
    assert.match(r.error, re);
  };
  refused(undefined, /no level/);
  refused('', /no level/);
  refused(' \n\n ', /no level/);
  refused('###\n\n###', /one level at a time/);
  refused('###\n#(#\n###', /brackets/);
  refused('###\n#)#\n###', /brackets/);
  refused('###\nMessage hi\n###', /message/);
  refused('###\nmessagehi\n###', /message/);
  refused('###\n##\n###', /same length/);
  refused('###\n===\n###', /= signs/);
  refused('#'.repeat(101), /too big/);
  refused(Array(101).fill('#').join('\n'), /too big/);
  refused('#'.repeat(10001), /too long/);
  assert.equal(checkLevelText(Array(100).fill('#'.repeat(99)).join('\n')).ok, true);
});

test('a level has one id per game, whatever its case', () => {
  assert.match(levelId('abc', '#P#'), /^[0-9a-f]{10}$/);
  assert.equal(levelId('abc', '#P#'), levelId('abc', '#p#'));
  assert.notEqual(levelId('abc', '#P#'), levelId('abd', '#P#'));
  assert.notEqual(levelId('abc', '#P#'), levelId('abc', '#P.#'));
});

const GAME = (levels) => ['title T', '', 'OBJECTS', 'Background', 'green', '', 'Player', 'blue', '', 'LEGEND', '. = Background', 'P = Player', '', 'SOUNDS', '', 'COLLISIONLAYERS', 'Background', 'Player', '', 'RULES', '', 'WINCONDITIONS', '', ...levels].join('\n');

test('splice keeps everything up to the LEVELS header and puts the one level after it', () => {
  const src = GAME(['LEVELS', '', '.P.', '', '...', 'P..']);
  const out = splice(src, 'P.');
  assert.equal(out, GAME(['LEVELS', '', 'P.', '']));
  assert.equal(splice(GAME(['=======', 'levels', '=======', '', '.P.']), 'P.'), GAME(['=======', 'levels', '=======', '', 'P.', '']));
  assert.equal(splice(GAME(['  Levels  ', '.P.']), 'P.'), GAME(['  Levels  ', '', 'P.', '']));
  assert.equal(splice(src.replace(/\n/g, '\r\n'), 'P.'), GAME(['LEVELS', '', 'P.', '']));
});

test('splice finds the header outside comments, and does not take message text for one', () => {
  const withComments = GAME(['(', 'LEVELS', 'this (nested) comment mentions levels', ')', '( LEVELS ) LEVELS (the real one)', '', '.P.']);
  assert.equal(splice(withComments, 'P.'), GAME(['(', 'LEVELS', 'this (nested) comment mentions levels', ')', '( LEVELS ) LEVELS (the real one)', '', 'P.', '']));
  // a rule's message with a sad face in it must not open a comment that swallows the header
  const sad = GAME(['LEVELS', '', '.P.']).replace('RULES\n', 'RULES\n[ Player ] -> [ Player ] message oh no :(\n');
  assert.ok(splice(sad, 'P.').endsWith('LEVELS\n\nP.\n'));
  assert.throws(() => splice('title T\n\nOBJECTS\n', 'P.'), (e) => e.name === 'CompileError' && /no LEVELS section/.test(e.message));
  assert.throws(() => splice(GAME(['(', 'LEVELS', ')']), 'P.'), /no LEVELS section/);
});

test('every demo game still compiles, to that one level, with its own first level spliced in', () => {
  const host = createHost();
  let checked = 0;
  for (const name of fs.readdirSync(DEMO_DIR).filter((f) => f.endsWith('.txt')).sort()) {
    const src = fs.readFileSync(path.join(DEMO_DIR, name), 'utf8');
    let meta;
    try { meta = host.load(src, 'seed', 0); } catch (e) { continue; } // a demo that does not compile as it is
    if (meta.realLevels.length === 0) continue;
    const index = meta.realLevels[0];
    try { host.load(src, 'seed', index); } catch (e) { continue; } // a demo whose first level does not start as it is
    let text;
    try { text = host.levelText(index); } catch (e) { continue; } // a cell no single glyph stands for
    const written = Array.from(host._ps.state.levels[index].objects);
    const one = host.load(splice(src, text), 'seed', 0);
    assert.equal(one.levelCount, 1, name);
    assert.deepEqual(Array.from(host._ps.state.levels[0].objects), written, name);
    assert.equal(checkLevelText(text).ok, true, name);
    checked++;
  }
  assert.ok(checked >= 90, 'only ' + checked + ' demos were checked');
});

const os = require('node:os');
const { createLevelStore } = require('../levels');

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'psbot-levels-'));
const sample = (over = {}) => Object.assign({ id: 'aaaaaaaaaa', gistId: 'abc', baseSourceHash: 'f'.repeat(64), text: '#P#', authorId: '42', authorName: 'Ada' }, over);

test('a stored level comes back, from this store and from a new one on the same directory', () => {
  const dir = tmpDir();
  const store = createLevelStore({ dataDir: dir, now: () => 1000 });
  const saved = store.add(sample());
  assert.deepEqual(saved, { id: 'aaaaaaaaaa', gistId: 'abc', baseSourceHash: 'f'.repeat(64), text: '#P#', authorId: '42', authorName: 'Ada', createdAt: 1000, channelId: null, threadId: null, messageId: null, solvedBy: [] });
  assert.deepEqual(store.get('aaaaaaaaaa'), saved);
  assert.deepEqual(createLevelStore({ dataDir: dir }).get('aaaaaaaaaa'), saved);
  assert.equal(store.get('bbbbbbbbbb'), null);
  for (const bad of ['../../etc', 'AAAAAAAAAA', 'aaaa', '', undefined]) assert.equal(store.get(bad), null);
});

test('adding a level that is already there changes nothing', () => {
  const store = createLevelStore({ dataDir: tmpDir(), now: () => 1000 });
  store.add(sample());
  const again = store.add(sample({ authorId: '99', authorName: 'Bob' }));
  assert.equal(again.authorName, 'Ada');
  assert.equal(store.get('aaaaaaaaaa').authorId, '42');
});

test('where a level was posted, and who solved it, are kept', () => {
  const dir = tmpDir();
  const store = createLevelStore({ dataDir: dir });
  store.add(sample());
  store.setPost('aaaaaaaaaa', { channelId: 'c', threadId: 't', messageId: 'm' });
  store.addSolver('aaaaaaaaaa', { id: '1', name: 'Bob' });
  store.addSolver('aaaaaaaaaa', { id: '1', name: 'Bob again' });
  const rec = store.addSolver('aaaaaaaaaa', { id: '2', name: 'x'.repeat(200) });
  assert.deepEqual(rec.solvedBy.map((s) => s.id), ['1', '2']);
  assert.equal(rec.solvedBy[0].name, 'Bob');
  assert.equal(rec.solvedBy[1].name.length, 80);
  const reread = createLevelStore({ dataDir: dir }).get('aaaaaaaaaa');
  assert.equal(reread.threadId, 't');
  assert.equal(reread.messageId, 'm');
  assert.equal(reread.solvedBy.length, 2);
  assert.equal(store.addSolver('bbbbbbbbbb', { id: '1', name: 'Bob' }), null);
  assert.equal(store.setPost('bbbbbbbbbb', { channelId: 'c', threadId: 't', messageId: 'm' }), null);
});

test('no more than fifty solvers are listed', () => {
  const store = createLevelStore({ dataDir: tmpDir() });
  store.add(sample());
  for (let i = 0; i < 60; i++) store.addSolver('aaaaaaaaaa', { id: String(i), name: 'n' + i });
  assert.equal(store.get('aaaaaaaaaa').solvedBy.length, 50);
});

test('a full store refuses new levels and keeps the old ones', () => {
  const dir = tmpDir();
  const store = createLevelStore({ dataDir: dir, maxBytes: 700 });
  store.add(sample({ id: '1111111111' }));
  store.add(sample({ id: '2222222222' }));
  assert.throws(() => store.add(sample({ id: '3333333333', text: '#'.repeat(300) })), (e) => e.name === 'LevelStoreFullError');
  assert.ok(store.get('1111111111'));
  assert.equal(store.get('3333333333'), null);
  // a new store on the same directory counts what is already there
  assert.throws(() => createLevelStore({ dataDir: dir, maxBytes: 700 }).add(sample({ id: '4444444444', text: '#'.repeat(300) })), (e) => e.name === 'LevelStoreFullError');
});
