'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createMusic, loadIndex } = require('../music');

const SECOND = 176400;
const INDEX = (n) => ({ root: '/music', tracks: Array.from({ length: n }, (_, i) => ({ path: 'album/t' + i + '.mp3', album: 'Album', title: 'Track ' + i, seconds: 60 })) });

function harness(index, random = Math.random) {
  const made = [], timers = [], started = [];
  const spawnDecoder = (file) => {
    const p = new EventEmitter();
    p.file = file;
    p.stdout = new EventEmitter();
    p.stdout.paused = false;
    p.stdout.pause = () => { p.stdout.paused = true; };
    p.stdout.resume = () => { p.stdout.paused = false; };
    p.stdout.destroy = () => { p.stdout.destroyed = true; };
    p.kill = () => { p.killed = true; p.emit('close'); };
    made.push(p);
    return p;
  };
  const music = createMusic({
    index, spawnDecoder, random, onTrack: (t) => started.push(t), log: () => {},
    setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimer: () => {},
  });
  // play one decoder to the end, producing some audio
  const finish = (p, bytes = 8) => { p.stdout.emit('data', Buffer.alloc(bytes, 1)); p.emit('close'); };
  return { music, made, timers, started, finish };
}

test('loadIndex reads the index or returns null', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'twitch-music-'));
  assert.equal(loadIndex(dir), null);
  fs.writeFileSync(path.join(dir, 'music-index.json'), JSON.stringify(INDEX(2)));
  assert.equal(loadIndex(dir).tracks.length, 2);
  fs.writeFileSync(path.join(dir, 'music-index.json'), '{"tracks": 5}');
  assert.equal(loadIndex(dir), null);
});

test('with no index it stays silent', () => {
  const h = harness(null);
  h.music.start();
  assert.equal(h.made.length, 0);
  assert.equal(h.music.read(400).length, 0);
  assert.equal(h.music.current(), null);
});

test('start decodes a track and announces it', () => {
  const h = harness(INDEX(3));
  assert.equal(h.music.current(), null);
  h.music.start();
  assert.equal(h.made.length, 1);
  assert.match(h.made[0].file, /^\/music\/album\/t\d\.mp3$/);
  assert.deepEqual(h.started.length, 1);
  assert.deepEqual(h.music.current(), h.started[0]);
  assert.equal(h.started[0].album, 'Album');
});

test('every track plays once before any repeats', () => {
  const h = harness(INDEX(4));
  h.music.start();
  for (let i = 0; i < 3; i++) h.finish(h.made[i]);
  assert.deepEqual(h.made.map((p) => p.file).sort(), ['/music/album/t0.mp3', '/music/album/t1.mp3', '/music/album/t2.mp3', '/music/album/t3.mp3']);
});

test('a reshuffle never plays the same track twice in a row', () => {
  // with two tracks: 0.99 keeps the order [0, 1]; 0 would then give [1, 0], repeating track 1
  const seq = [0.99, 0, 0, 0];
  let i = 0;
  const h = harness(INDEX(2), () => seq[i++ % seq.length]);
  h.music.start();
  for (let k = 0; k < 5; k++) h.finish(h.made[k]);
  const files = h.made.map((p) => p.file);
  for (let k = 1; k < files.length; k++) assert.notEqual(files[k], files[k - 1]);
});

test('read returns whole sample frames in order, across chunks and tracks', () => {
  const h = harness(INDEX(2));
  h.music.start();
  h.made[0].stdout.emit('data', Buffer.from([1, 2, 3, 4, 5, 6]));
  h.made[0].stdout.emit('data', Buffer.from([7, 8, 9, 10, 11, 12]));
  assert.deepEqual([...h.music.read(8)], [1, 2, 3, 4, 5, 6, 7, 8]);
  h.made[0].emit('close');
  h.made[1].stdout.emit('data', Buffer.from([13, 14]));
  assert.deepEqual([...h.music.read(1000)], [9, 10, 11, 12]);
  assert.equal(h.music.read(1000).length, 0, 'two bytes are not a whole frame yet');
  h.made[1].stdout.emit('data', Buffer.from([15, 16]));
  assert.deepEqual([...h.music.read(1000)], [13, 14, 15, 16]);
  assert.equal(h.music.read(0).length, 0);
});

test('the decoder is paused at 2 seconds buffered and resumed under 1', () => {
  const h = harness(INDEX(2));
  h.music.start();
  const out = h.made[0].stdout;
  out.emit('data', Buffer.alloc(2 * SECOND - 4));
  assert.equal(out.paused, false);
  out.emit('data', Buffer.alloc(4));
  assert.equal(out.paused, true);
  h.music.read(SECOND);
  assert.equal(out.paused, true);
  h.music.read(4);
  assert.equal(out.paused, false);
});

test('a track that yields nothing is skipped, and 5 in a row wait 30 seconds', () => {
  const h = harness(INDEX(3));
  h.music.start();
  for (let i = 0; i < 4; i++) h.made[i].emit('close');
  assert.equal(h.made.length, 5);
  assert.equal(h.timers.length, 0);
  h.made[4].emit('close');
  assert.equal(h.made.length, 5);
  assert.equal(h.timers[0].ms, 30000);
  h.timers[0].fn();
  assert.equal(h.made.length, 6);
});

test('a decoder that cannot start counts as a failed track', () => {
  const h = harness(INDEX(3));
  h.music.start();
  h.made[0].emit('error', new Error('spawn ffmpeg ENOENT'));
  h.made[0].emit('close');
  assert.equal(h.made.length, 2);
});

test('stop kills the decoder, closes its pipe, and nothing else starts', () => {
  const h = harness(INDEX(3));
  h.music.start();
  h.music.stop();
  assert.equal(h.made[0].killed, true);
  assert.equal(h.made[0].stdout.destroyed, true, 'a decoder blocked on a full pipe ignores SIGTERM; closing the pipe ends it');
  assert.equal(h.made.length, 1);
});
