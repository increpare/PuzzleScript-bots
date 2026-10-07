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
  const made = [], timers = [], started = [], plan = [], logs = [], clock = { t: 1000000 };
  const spawnDecoder = (file) => {
    if (plan.length) return plan.shift()(file); // a test queues a function to override the next spawn
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
    index, spawnDecoder, random, onTrack: (t) => started.push(t), log: (m) => logs.push(String(m)), now: () => clock.t,
    setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimer: () => {},
  });
  // play one decoder to the end, producing some audio
  const finish = (p, bytes = 8) => { p.stdout.emit('data', Buffer.alloc(bytes, 1)); p.emit('close'); };
  return { music, made, timers, started, finish, plan, logs, clock };
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

// What Node hands back under file-descriptor exhaustion: a child with no streams, and an error event to follow.
const noStdout = (h) => () => {
  const p = new EventEmitter();
  p.kill = () => { p.killed = true; };
  h.made.push(p);
  return p;
};
const boom = () => { throw new Error('spawn EAGAIN'); };

test('a spawn that throws is a failed track: the next one is tried and nothing escapes', () => {
  const h = harness(INDEX(3));
  h.plan.push(boom);
  assert.doesNotThrow(() => h.music.start());
  assert.equal(h.made.length, 1, 'the second track was tried');
  assert.equal(h.started.length, 1, 'only the track that started is announced');
  assert.equal(h.timers.length, 0);
  assert.ok(h.logs.some((l) => l.includes('EAGAIN')), h.logs.join('\n'));
  h.finish(h.made[0]);
  assert.equal(h.made.length, 2, 'and playback goes on');
});

test('five spawns in a row that throw wait 30 seconds', () => {
  const h = harness(INDEX(3));
  for (let i = 0; i < 5; i++) h.plan.push(boom);
  assert.doesNotThrow(() => h.music.start());
  assert.equal(h.made.length, 0);
  assert.deepEqual(h.timers.map((t) => t.ms), [30000]);
  assert.doesNotThrow(() => h.timers[0].fn());
  assert.equal(h.made.length, 1, 'then it tries again');
});

test('failures of different kinds add up to the same five', () => {
  const h = harness(INDEX(3));
  h.plan.push(boom, boom);
  h.music.start();
  assert.equal(h.made.length, 1);
  h.made[0].emit('close'); // yields nothing
  h.made[1].emit('close');
  assert.equal(h.timers.length, 0, 'four failures so far');
  h.made[2].emit('close');
  assert.equal(h.made.length, 3);
  assert.equal(h.timers.length, 1, 'two throws and three empty tracks make five');
  assert.equal(h.timers[0].ms, 30000);
});

test('a child with no stdout is a failed track, and the half-started child is killed', () => {
  const h = harness(INDEX(3));
  h.plan.push(noStdout(h));
  assert.doesNotThrow(() => h.music.start());
  assert.equal(h.made[0].killed, true);
  assert.equal(h.made.length, 2, 'the next track was tried');
  assert.doesNotThrow(() => h.made[0].emit('error', new Error('spawn ffmpeg EMFILE')), 'its late error is harmless');
  assert.doesNotThrow(() => h.made[0].emit('close'));
  assert.equal(h.made.length, 2, 'and does not count a second time');
  const h5 = harness(INDEX(3));
  for (let i = 0; i < 5; i++) h5.plan.push(noStdout(h5));
  assert.doesNotThrow(() => h5.music.start());
  assert.deepEqual(h5.timers.map((t) => t.ms), [30000]);
});

test('stop copes with a decoder whose stdout has gone', () => {
  const h = harness(INDEX(3));
  h.music.start();
  h.made[0].stdout = null;
  assert.doesNotThrow(() => h.music.stop());
  assert.equal(h.made[0].killed, true);
});

test('an error on the decoder output ends the track instead of crashing', () => {
  const h = harness(INDEX(3));
  h.music.start();
  h.made[0].stdout.emit('data', Buffer.alloc(8, 1));
  assert.doesNotThrow(() => h.made[0].stdout.emit('error', new Error('read EIO')));
  assert.ok(h.logs.some((l) => l.includes('EIO')), h.logs.join('\n'));
  assert.equal(h.made.length, 2, 'the next track starts');
  assert.equal(h.made[0].stdout.destroyed, true, 'the broken pipe is closed');
  h.made[0].emit('close');
  assert.equal(h.made.length, 2, 'the close that follows does not start another');
  h.made[0].stdout.emit('data', Buffer.alloc(8, 9));
  assert.equal(h.music.read(1000).length, 8, 'nothing more is taken from the old decoder');
});

test('a decoder that goes silent for 10 seconds is killed and the next track starts', () => {
  const h = harness(INDEX(3));
  h.music.start();
  h.made[0].stdout.emit('data', Buffer.alloc(8, 1));
  h.clock.t += 9999;
  h.music.read(4);
  assert.equal(h.made[0].killed, undefined);
  h.clock.t += 1;
  h.music.read(4);
  assert.equal(h.made[0].killed, true);
  assert.equal(h.made[0].stdout.destroyed, true, 'its pipe is closed as well');
  assert.equal(h.made.length, 2, 'the next track is playing');
  assert.equal(h.timers.length, 0);
  assert.ok(h.logs.some((l) => /stall|hung|silent/i.test(l)), h.logs.join('\n'));
  assert.deepEqual(h.music.current(), h.started[1]);
});

test('a decoder that never produced anything counts as failed, and one that hangs for ever ends in the 30 second wait', () => {
  const h = harness(INDEX(3));
  h.music.start();
  for (let i = 0; i < 5; i++) { h.clock.t += 10000; h.music.read(4); }
  assert.equal(h.made.length, 5);
  assert.equal(h.timers.length, 1);
  assert.equal(h.timers[0].ms, 30000);
  h.clock.t += 60000;
  h.music.read(4);
  assert.equal(h.made.length, 5, 'nothing is running, so nothing is killed');
});

test('a hung decoder that does not die on its signal is still moved on from', () => {
  const h = harness(INDEX(3));
  h.music.start();
  h.made[0].kill = () => { h.made[0].killed = true; }; // stuck in the kernel: no close event follows
  h.clock.t += 10000;
  h.music.read(4);
  assert.equal(h.made[0].killed, true);
  assert.equal(h.made.length, 2);
  h.clock.t += 1;
  h.made[0].emit('close');
  assert.equal(h.made.length, 2, 'when it finally closes nothing more starts');
});

test('a decoder paused with a full buffer is not stalled, however long it stays paused', () => {
  const h = harness(INDEX(3));
  h.music.start();
  const out = h.made[0].stdout;
  out.emit('data', Buffer.alloc(2 * SECOND));
  assert.equal(out.paused, true);
  for (let i = 0; i < 60; i++) { h.clock.t += 1000; h.music.read(4); }
  assert.equal(h.made[0].killed, undefined, 'a minute paused');
  assert.equal(out.paused, true);
  h.music.read(SECOND); // down below one second: resumed
  assert.equal(out.paused, false);
  h.clock.t += 9999;
  h.music.read(4);
  assert.equal(h.made[0].killed, undefined, 'the silence is counted from the resume');
  h.clock.t += 1;
  h.music.read(4);
  assert.equal(h.made[0].killed, true, 'a decoder that was resumed and says nothing is stalled');
});

test('a decoder that keeps producing data is never killed', () => {
  const h = harness(INDEX(3));
  h.music.start();
  for (let s = 0; s < 120; s++) {
    h.clock.t += 1000;
    if (s % 8 === 0) h.made[0].stdout.emit('data', Buffer.alloc(400, 1)); // slowly, but never 10 seconds apart
    h.music.read(4);
  }
  assert.equal(h.made[0].killed, undefined);
  assert.equal(h.made.length, 1);
});
