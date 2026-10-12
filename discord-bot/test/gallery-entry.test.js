'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { SRC_DIR } = require('../engine-src');
const { GalleryError, readRecords, gistOf, hasGist, checkSubmission, galleryRecord, appendRecord, MAX_GIF_BYTES } = require('../gallery-entry');

const real = fs.readFileSync(path.join(SRC_DIR, 'games_dat.js'), 'utf8');
const GIST = 'abcdef0123456789abcdef0123456789';
const record = galleryRecord({ gistId: GIST, title: 'A Game', author: 'Someone', homepage: 'https://example.com/a' });
const gifOf = (bytes) => Buffer.concat([Buffer.from('GIF89a', 'latin1'), Buffer.alloc(bytes - 6)]).toString('base64');

test('a record is the game, its picture and who made it', () => {
  assert.deepStrictEqual(record, {
    url: 'https://www.puzzlescript.net/play.html?p=' + GIST,
    thumb: GIST + '.gif',
    title: 'A Game',
    author: 'Someone',
    homepage: 'https://example.com/a',
  });
  assert.strictEqual(gistOf(record), GIST);
  // without a homepage the gallery page links the game itself
  assert.ok(!('homepage' in galleryRecord({ gistId: GIST, title: 'A Game', author: 'Someone', homepage: '' })));
  assert.strictEqual(galleryRecord({ gistId: GIST.toUpperCase(), title: 'T', author: 'A', homepage: '' }).thumb, GIST + '.gif');
});

test('a record is appended to the real list in its own layout', () => {
  const before = readRecords(real);
  const text = appendRecord(real, record);
  const after = readRecords(text);
  assert.strictEqual(after.length, before.length + 1);
  assert.deepStrictEqual(after[after.length - 1], record);
  assert.deepStrictEqual(after.slice(0, -1), before);
  // nothing that was there is touched
  const head = real.slice(0, real.lastIndexOf(']'));
  assert.ok(text.startsWith(head));
  assert.strictEqual(text.slice(head.length), [
    '  {',
    '    "url": "https://www.puzzlescript.net/play.html?p=' + GIST + '",',
    '    "thumb": "' + GIST + '.gif",',
    '    "title": "A Game",',
    '    "author": "Someone",',
    '    "homepage": "https://example.com/a"',
    '  },',
    real.slice(real.lastIndexOf(']')),
  ].join('\n'));
});

test('a list whose last entry has no comma after it is given one', () => {
  const text = appendRecord('let games_gallery = [\n  {\n    "url": "https://www.puzzlescript.net/play.html?p=1234",\n    "title": "One"\n  }\n]\n', record);
  const records = readRecords(text);
  assert.strictEqual(records.length, 2);
  assert.strictEqual(records[0].title, 'One');
  assert.deepStrictEqual(records[1], record);
  assert.ok(text.endsWith('  },\n]\n'));
});

test('an empty list takes its first record', () => {
  assert.deepStrictEqual(readRecords(appendRecord('let games_gallery = [\n]', record)), [record]);
});

test('quotes and backslashes in a title survive', () => {
  const odd = galleryRecord({ gistId: GIST, title: 'The "Best" \\ Game', author: 'O\'Neil', homepage: '' });
  const records = readRecords(appendRecord(real, odd));
  assert.deepStrictEqual(records[records.length - 1], odd);
});

test('a text that is not a list, or already has the game, is refused', () => {
  assert.throws(() => appendRecord('let games_gallery = 5;', record), GalleryError);
  assert.throws(() => appendRecord('', record), GalleryError);
  // something after the list that the edit does not understand
  assert.throws(() => appendRecord(real + '\ngames_gallery.push(1);\n', record), GalleryError);
  const once = appendRecord(real, record);
  assert.throws(() => appendRecord(once, record), /already in the gallery/);
  assert.throws(() => appendRecord(once, galleryRecord({ gistId: GIST.toUpperCase(), title: 'x', author: 'y', homepage: '' })), /already in the gallery/);
});

test('hasGist finds a game whatever the case of its id', () => {
  assert.strictEqual(hasGist(real, '6841219'), true);
  assert.strictEqual(hasGist(real, '25EE2F1C9000620AA7B6F429C958D095'), true);
  assert.strictEqual(hasGist(real, GIST), false);
});

test('a submission is checked and tidied', () => {
  const ok = checkSubmission({ gif: gifOf(64), title: '  A Game ', author: ' Someone', homepage: ' example.com ' });
  assert.strictEqual(ok.title, 'A Game');
  assert.strictEqual(ok.author, 'Someone');
  assert.strictEqual(ok.homepage, 'example.com');
  assert.ok(Buffer.isBuffer(ok.gif));
  assert.strictEqual(ok.gif.length, 64);
  assert.strictEqual(checkSubmission({ gif: gifOf(64), title: 'T', author: 'A' }).homepage, '');
  const old = Buffer.concat([Buffer.from('GIF87a', 'latin1'), Buffer.alloc(10)]).toString('base64');
  assert.strictEqual(checkSubmission({ gif: old, title: 'T', author: 'A', homepage: '' }).gif.length, 16);
  assert.strictEqual(checkSubmission({ gif: gifOf(MAX_GIF_BYTES), title: 'T'.repeat(100), author: 'A'.repeat(100), homepage: 'h'.repeat(200) }).gif.length, MAX_GIF_BYTES);
});

test('a bad submission is refused with something to show', () => {
  const good = { gif: gifOf(64), title: 'T', author: 'A', homepage: '' };
  const bad = (change, pattern) => assert.throws(() => checkSubmission(Object.assign({}, good, change)), (e) => e instanceof GalleryError && pattern.test(e.message));
  bad({ gif: Buffer.from('PNG image, not a GIF').toString('base64') }, /not a GIF/);
  bad({ gif: '' }, /not a GIF/);
  bad({ gif: 5 }, /not a GIF/);
  bad({ gif: gifOf(MAX_GIF_BYTES + 1) }, /too big/);
  bad({ title: '   ' }, /title/);
  bad({ title: 'T'.repeat(101) }, /title/);
  bad({ title: null }, /title/);
  bad({ author: '' }, /author/);
  bad({ author: 'A'.repeat(101) }, /author/);
  bad({ homepage: 'h'.repeat(201) }, /homepage/);
  bad({ homepage: 'two words' }, /homepage/);
  bad({ homepage: 5 }, /homepage/);
  // the gallery page writes the homepage into a link as it is, and a game's own prelude is where it comes from
  bad({ homepage: 'example.com"><script>alert(1)</script>' }, /homepage/);
  bad({ homepage: "example.com/'onmouseover='x" }, /homepage/);
  bad({ homepage: 'javascript:alert(1)' }, /homepage/);
  bad({ homepage: 'example.com/<b>' }, /homepage/);
  for (const fine of ['www.increpare.com', 'https://nebu-soku.itch.io/i-am-two', 'http://example.com:8080/a/b?c=d&e=f#g', 'www.sneezingtiger.com/sokoban/levels/microbanText.html', 'example.com/~user/a_b-c%20d']) {
    assert.strictEqual(checkSubmission(Object.assign({}, good, { homepage: fine })).homepage, fine);
  }
  // a line break would break the one-line layout of a title in a message
  bad({ title: 'two\nlines' }, /title/);
});

test('the link to the submission page carries its token where no server sees it', () => {
  const { galleryLink, GALLERY_LINK_MS } = require('../gallery-entry');
  assert.strictEqual(galleryLink('https://games.increpare.com/puzzlescriptbot/app/', 'abc.def'), 'https://games.increpare.com/puzzlescriptbot/app/gallery/#t=abc.def');
  assert.strictEqual(GALLERY_LINK_MS, 6 * 60 * 60 * 1000);
});
