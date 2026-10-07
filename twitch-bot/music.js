'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { shuffled } = require('./rotation');

const BYTES_PER_SECOND = 44100 * 4; // 44.1 kHz, stereo, 16-bit
const HIGH = 2 * BYTES_PER_SECOND, LOW = BYTES_PER_SECOND;
const MAX_FAILURES = 5, RETRY_MS = 30000, STALL_MS = 10000;

function loadIndex(dataDir) {
  try {
    const index = JSON.parse(fs.readFileSync(path.join(dataDir, 'music-index.json'), 'utf8'));
    return index && Array.isArray(index.tracks) && typeof index.root === 'string' ? index : null;
  } catch (e) { return null; }
}

function defaultDecoder(file) {
  return spawn('ffmpeg', ['-v', 'error', '-nostdin', '-i', file, '-vn', '-f', 's16le', '-ar', '44100', '-ac', '2', 'pipe:1'], { stdio: ['ignore', 'pipe', 'ignore'] });
}

// Close a decoder down. One blocked writing to a full pipe ignores SIGTERM, so the pipe is closed as
// well; and one that never got a pipe, or whose process has already gone, is not an error here.
function killDecoder(p, signal) {
  try { p.kill(signal); } catch (e) { /* already gone */ }
  try { if (p.stdout) p.stdout.destroy(); } catch (e) { /* already closed */ }
}

// Shuffled playback as a source of PCM. One track is decoded at a time, a couple of seconds
// ahead of what has been read; the next decoder starts when the previous one has been drained.
// A decoder that goes quiet for 10 seconds (a stalled mount, say) is killed, and the next track starts.
function createMusic({ index, spawnDecoder = defaultDecoder, random = Math.random, onTrack = () => {}, log = console.log, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout }) {
  const tracks = index && Array.isArray(index.tracks) ? index.tracks : [];
  let order = [], pos = 0, last = -1;
  let chunks = [], buffered = 0;
  let proc = null, paused = false, current = null, failures = 0, timer = null, stopped = true;
  let lastData = 0, onStall = null;

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
    let p = null, produced = 0, done = false;
    const finish = () => {
      if (done) return;
      done = true;
      if (proc !== p) return;
      proc = null;
      onStall = null;
      if (stopped) return;
      if (produced > 0) failures = 0;
      else { failures++; log('could not decode ' + track.path); }
      if (failures >= MAX_FAILURES) { failures = 0; timer = setTimer(play, RETRY_MS); }
      else play();
    };
    try {
      p = spawnDecoder(path.join(index.root, track.path));
      proc = p;
      paused = false;
      lastData = now();
      // First of all, so that the late error Node reports for a child that never got going is handled.
      p.on('error', (e) => { log('decoder error: ' + (e && e.message)); finish(); });
      p.on('close', finish);
      if (!p.stdout) throw new Error('the decoder started without an output pipe');
      p.stdout.on('data', (chunk) => {
        if (proc !== p) return; // from a decoder that has been given up on
        produced += chunk.length;
        lastData = now();
        chunks.push(chunk);
        buffered += chunk.length;
        if (buffered >= HIGH && !paused) { paused = true; p.stdout.pause(); }
      });
      p.stdout.on('error', (e) => { log('decoder output error: ' + (e && e.message)); killDecoder(p); finish(); });
    } catch (e) {
      // Counts as a failed track, like one that produced nothing. Anything half started is stopped.
      log('could not start the decoder for ' + track.path + ': ' + (e && e.message));
      proc = p;
      if (p) killDecoder(p, 'SIGKILL');
      finish();
      return;
    }
    onStall = () => {
      log('the decoder for ' + track.path + ' has been silent for ' + STALL_MS / 1000 + ' s, skipping the track');
      killDecoder(p, 'SIGKILL');
      finish(); // not left to the close event: a process stuck in the kernel may never send one
    };
    current = { title: track.title, album: track.album };
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
      if (proc) killDecoder(proc);
    },
    // Up to n bytes of audio, always whole sample frames; fewer (or none) when the music has no more yet.
    read(n) {
      // A paused decoder is waiting for this buffer to drain, which is not a stall.
      if (proc && !paused && onStall && now() - lastData >= STALL_MS) onStall();
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
      if (paused && buffered < LOW && proc) { paused = false; lastData = now(); proc.stdout.resume(); }
      return out;
    },
    current: () => current,
  };
}

module.exports = { createMusic, loadIndex };
