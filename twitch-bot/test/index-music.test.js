'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildIndex, ALBUMS } = require('../index-music');

function library() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'twitch-music-'));
  const put = (rel) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), 'x'); };
  put('increpare - Alpha/2 - Second.mp3');
  put('increpare - Alpha/1 - First.mp3');
  put('increpare - Alpha/cover.jpg');
  put('increpare - Alpha/disc two/2-01 Deep_Cut.mp3');
  put('increpare - Beta/broken.mp3');
  put('increpare - Beta/tagged.ogg');
  put('increpare - Other/ignored.mp3');
  return root;
}

test('the default albums are the six the user chose', () => {
  assert.deepEqual(ALBUMS, ['increpare - English Country Tune', 'increpare - Hypnocult', 'increpare - Mirror Stage', 'increpare - Moving Stories', 'increpare - Oiche Mhaith', 'increpare - Oeuvre (Oeuf OST)']);
});

test('indexes audio files in the chosen folders, in a stable order', () => {
  const root = library();
  const probe = (file) => {
    if (file.endsWith('broken.mp3')) throw new Error('bad file');
    return { seconds: 61.4, title: file.endsWith('tagged.ogg') ? 'A Proper Title' : undefined };
  };
  const logged = [];
  const index = buildIndex({ root, albums: ['increpare - Alpha', 'increpare - Beta', 'increpare - Missing'], probe, log: (m) => logged.push(m) });
  assert.equal(index.root, root);
  assert.deepEqual(index.tracks, [
    { path: path.join('increpare - Alpha', '1 - First.mp3'), album: 'Alpha', title: 'First', seconds: 61 },
    { path: path.join('increpare - Alpha', '2 - Second.mp3'), album: 'Alpha', title: 'Second', seconds: 61 },
    { path: path.join('increpare - Alpha', 'disc two', '2-01 Deep_Cut.mp3'), album: 'Alpha', title: 'Deep_Cut', seconds: 61 },
    { path: path.join('increpare - Beta', 'tagged.ogg'), album: 'Beta', title: 'A Proper Title', seconds: 61 },
  ]);
  assert.equal(logged.length, 2, 'the broken file and the missing folder are reported');
});

test('the music files are not modified', () => {
  const root = library();
  const before = fs.statSync(path.join(root, 'increpare - Alpha', '1 - First.mp3')).mtimeMs;
  buildIndex({ root, albums: ['increpare - Alpha'], probe: () => ({ seconds: 10 }) });
  assert.equal(fs.statSync(path.join(root, 'increpare - Alpha', '1 - First.mp3')).mtimeMs, before);
  assert.deepEqual(fs.readdirSync(path.join(root, 'increpare - Alpha')).sort(), ['1 - First.mp3', '2 - Second.mp3', 'cover.jpg', 'disc two']);
});
