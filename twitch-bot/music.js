'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { shuffled } = require('./rotation');

const BYTES_PER_SECOND = 44100 * 4; // 44.1 kHz, stereo, 16-bit
const HIGH = 2 * BYTES_PER_SECOND, LOW = BYTES_PER_SECOND;
const MAX_FAILURES = 5, RETRY_MS = 30000;

function loadIndex(dataDir) {
  try {
    const index = JSON.parse(fs.readFileSync(path.join(dataDir, 'music-index.json'), 'utf8'));
    return index && Array.isArray(index.tracks) && typeof index.root === 'string' ? index : null;
  } catch (e) { return null; }
}

function defaultDecoder(file) {
  return spawn('ffmpeg', ['-v', 'error', '-nostdin', '-i', file, '-vn', '-f', 's16le', '-ar', '44100', '-ac', '2', 'pipe:1'], { stdio: ['ignore', 'pipe', 'ignore'] });
}

// Shuffled playback as a source of PCM. One track is decoded at a time, a couple of seconds
// ahead of what has been read; the next decoder starts when the previous one has been drained.
function createMusic({ index, spawnDecoder = defaultDecoder, random = Math.random, onTrack = () => {}, log = console.log, setTimer = setTimeout, clearTimer = clearTimeout }) {
  const tracks = index && Array.isArray(index.tracks) ? index.tracks : [];
  let order = [], pos = 0, last = -1;
  let chunks = [], buffered = 0;
  let proc = null, paused = false, current = null, failures = 0, timer = null, stopped = true;

  function nextTrack() {
    if (pos >= order.length) {
      order = shuffled(tracks.map((_, i) => i), random);
      if (order.length > 1 && order[0] === last) { order[0] = order[1]; order[1] = last; }
      pos = 0;
    }
    last = order[pos++];
    return tracks[last];
  }

  function play() {
    timer = null;
    if (stopped || tracks.length === 0) return;
    const track = nextTrack();
    const p = spawnDecoder(path.join(index.root, track.path));
    let produced = 0, done = false;
    proc = p;
    paused = false;
    current = { title: track.title, album: track.album };
    p.stdout.on('data', (chunk) => {
      produced += chunk.length;
      chunks.push(chunk);
      buffered += chunk.length;
      if (buffered >= HIGH && !paused) { paused = true; p.stdout.pause(); }
    });
    const finish = () => {
      if (done) return;
      done = true;
      if (proc !== p) return;
      proc = null;
      if (stopped) return;
      if (produced > 0) failures = 0;
      else { failures++; log('could not decode ' + track.path); }
      if (failures >= MAX_FAILURES) { failures = 0; timer = setTimer(play, RETRY_MS); }
      else play();
    };
    p.on('error', (e) => { log('decoder error: ' + (e && e.message)); finish(); });
    p.on('close', finish);
    onTrack(current);
  }

  return {
    start() {
      if (!stopped) return;
      stopped = false;
      play();
    },
    stop() {
      stopped = true;
      if (timer !== null) { clearTimer(timer); timer = null; }
      if (proc) {
        // A decoder blocked writing to a full pipe ignores SIGTERM, so close the pipe as well.
        const p = proc;
        p.kill();
        p.stdout.destroy();
      }
    },
    // Up to n bytes of audio, always whole sample frames; fewer (or none) when the music has no more yet.
    read(n) {
      const size = Math.min(n - (n % 4), buffered - (buffered % 4));
      if (size <= 0) return Buffer.alloc(0);
      const out = Buffer.allocUnsafe(size);
      let filled = 0;
      while (filled < size) {
        const head = chunks[0];
        const take = Math.min(head.length, size - filled);
        head.copy(out, filled, 0, take);
        filled += take;
        if (take === head.length) chunks.shift(); else chunks[0] = head.subarray(take);
      }
      buffered -= size;
      if (paused && buffered < LOW && proc) { paused = false; proc.stdout.resume(); }
      return out;
    },
    current: () => current,
  };
}

module.exports = { createMusic, loadIndex };
