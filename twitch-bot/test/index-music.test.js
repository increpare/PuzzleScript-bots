'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildIndex, saveIndex, ALBUMS } = require('../index-music');

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

test('an index with tracks is written to the data folder', () => {
  const dataDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'twitch-save-')), 'data');
  const index = { root: '/music', tracks: [{ path: 'a/1.mp3', album: 'A', title: 'One', seconds: 3600 }, { path: 'a/2.mp3', album: 'A', title: 'Two', seconds: 3600 }] };
  const result = saveIndex({ index, musicDir: '/music', dataDir });
  assert.equal(result.file, path.join(dataDir, 'music-index.json'));
  assert.deepEqual(JSON.parse(fs.readFileSync(result.file, 'utf8')), index);
  assert.match(result.message, /indexed 2 tracks, 2\.0 hours/);
});

test('an index with no tracks is not written, and the message names the music folder', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'twitch-save-'));
  const result = saveIndex({ index: { root: '/mnt/media/increpare', tracks: [] }, musicDir: '/mnt/media/increpare', dataDir });
  assert.equal(result.file, null);
  assert.ok(result.message.includes('/mnt/media/increpare'), result.message);
  assert.deepEqual(fs.readdirSync(dataDir), [], 'nothing was written');
  const missing = path.join(dataDir, 'not-yet-made');
  assert.equal(saveIndex({ index: { root: '/m', tracks: [] }, musicDir: '/m', dataDir: missing }).file, null);
  assert.equal(fs.existsSync(missing), false, 'not even the data folder was created');
});

test('an empty run does not replace a good index', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'twitch-save-'));
  const good = { root: '/music', tracks: [{ path: 'a.mp3', album: 'A', title: 'One', seconds: 60 }] };
  saveIndex({ index: good, musicDir: '/music', dataDir });
  saveIndex({ index: { root: '/music', tracks: [] }, musicDir: '/music', dataDir });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dataDir, 'music-index.json'), 'utf8')), good);
});
