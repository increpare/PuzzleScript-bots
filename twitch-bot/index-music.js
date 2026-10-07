'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { loadPaths } = require('./config');

const ALBUMS = [
  'increpare - English Country Tune',
  'increpare - Hypnocult',
  'increpare - Mirror Stage',
  'increpare - Moving Stories',
  'increpare - Oiche Mhaith',
  'increpare - Oeuvre (Oeuf OST)',
];
const AUDIO = /\.(mp3|ogg|flac|wav|m4a)$/i;

function probeFile(file) {
  const out = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:format_tags=title', '-of', 'json', file], { encoding: 'utf8' });
  const format = JSON.parse(out).format || {};
  const tags = format.tags || {};
  return { seconds: Number(format.duration), title: tags.title || tags.TITLE };
}

function audioFiles(dir) {
  const found = [];
  for (const name of fs.readdirSync(dir).sort()) {
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) found.push(...audioFiles(full));
    else if (AUDIO.test(name)) found.push(full);
  }
  return found;
}

// A list of the tracks to play. The music itself is only read, never copied or changed.
function buildIndex({ root, albums = ALBUMS, probe = probeFile, log = () => {} }) {
  const tracks = [];
  for (const folder of albums) {
    let files;
    try { files = audioFiles(path.join(root, folder)); } catch (e) { log('missing album folder: ' + folder); continue; }
    for (const file of files) {
      let info = null;
      try { info = probe(file); } catch (e) { /* reported below */ }
      if (!info || !(info.seconds > 0)) { log('unreadable track: ' + file); continue; }
      tracks.push({
        path: path.relative(root, file),
        album: folder.replace(/^increpare - /, ''),
        title: info.title || path.basename(file).replace(AUDIO, '').replace(/^[\d\s.-]+/, ''),
        seconds: Math.round(info.seconds),
      });
    }
  }
  return { root, tracks };
}

// Writes the index, unless it has no tracks: that means the music folder is empty or not mounted,
// and an index of nothing would silence the stream and replace a good one.
function saveIndex({ index, musicDir, dataDir }) {
  if (index.tracks.length === 0) {
    return { file: null, message: 'no tracks found in ' + musicDir + ' (is the music folder there and mounted?); the index was not written' };
  }
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, 'music-index.json');
  fs.writeFileSync(file, JSON.stringify(index));
  const hours = index.tracks.reduce((sum, t) => sum + t.seconds, 0) / 3600;
  return { file, message: 'indexed ' + index.tracks.length + ' tracks, ' + hours.toFixed(1) + ' hours -> ' + file };
}

if (require.main === module) {
  const { musicDir, dataDir } = loadPaths();
  const index = buildIndex({ root: musicDir, log: console.log });
  const result = saveIndex({ index, musicDir, dataDir });
  if (!result.file) {
    console.error(result.message);
    process.exit(1);
  }
  console.log(result.message);
}

module.exports = { buildIndex, saveIndex, ALBUMS };
