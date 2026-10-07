'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const { createEncoder, ffmpegArgs } = require('../encoder');

function pipe() {
  const s = new EventEmitter();
  s.chunks = [];
  s.accept = true;
  s.write = (b) => { s.chunks.push(b); return s.accept; };
  s.end = () => { s.ended = true; };
  s.bytes = () => s.chunks.reduce((n, b) => n + b.length, 0);
  return s;
}

function harness(opts = {}) {
  const clock = { t: 5000 }, procs = [], timers = [], logs = [];
  const spawnFfmpeg = (output) => {
    const p = new EventEmitter();
    p.output = output;
    p.stdin = pipe();
    p.stdio = [p.stdin, null, new EventEmitter(), pipe()];
    p.stderr = p.stdio[2];
    p.kill = (signal) => { p.killed = signal; };
    procs.push(p);
    return p;
  };
  const enc = createEncoder(Object.assign({
    output: 'rtmp://live.twitch.tv/app/SECRETKEY', spawnFfmpeg, now: () => clock.t, log: (m) => logs.push(String(m)), autoTick: false,
    setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimer: () => {},
  }, opts));
  const at = (ms) => { clock.t = 5000 + ms; enc._tick(); };
  return { enc, clock, procs, timers, logs, at };
}

const FRAME_A = Buffer.alloc(16, 1), FRAME_B = Buffer.alloc(16, 2), FRAME_C = Buffer.alloc(16, 3);

test('the ffmpeg command reads both pipes and writes FLV to the output', () => {
  const a = ffmpegArgs('rtmp://example/app/key');
  const has = (...seq) => a.some((_, i) => seq.every((v, k) => a[i + k] === v));
  assert.ok(has('-f', 'rawvideo', '-pix_fmt', 'rgba', '-video_size', '640x360'));
  assert.ok(has('-use_wallclock_as_timestamps', '1', '-i', 'pipe:0'));
  assert.ok(has('-f', 's16le', '-ar', '44100', '-ac', '2', '-i', 'pipe:3'));
  assert.ok(has('-vf', 'scale=1280:720:flags=neighbor'));
  assert.ok(has('-fps_mode', 'vfr'));
  assert.ok(has('-threads', '1'));
  assert.ok(has('-force_key_frames', 'expr:gte(t,n_forced*2-0.1)'));
  assert.ok(has('-c:a', 'aac'));
  assert.ok(has('-f', 'flv'));
  assert.equal(a[a.length - 1], 'rtmp://example/app/key');
});

test('audio is written in step with the clock, padded with silence', () => {
  const tone = Buffer.alloc(1000, 7);
  let asked = [];
  const h = harness({ readAudio: (n) => { asked.push(n); return asked.length === 1 ? tone : Buffer.alloc(0); } });
  h.enc.start();
  h.at(0);
  const audio = h.procs[0].stdio[3];
  assert.equal(asked[0], 6615 * 4, '150 ms of lead at 44.1 kHz');
  assert.equal(audio.bytes(), 6615 * 4);
  assert.equal(audio.chunks[0][0], 7);
  assert.equal(audio.chunks[0][999], 7);
  assert.equal(audio.chunks[0][1000], 0, 'silence where the music ran short');
  h.at(1000);
  assert.equal(audio.bytes(), 50715 * 4);
  h.at(1000);
  assert.equal(audio.bytes(), 50715 * 4, 'nothing more is owed at the same instant');
});

test('nothing is written before the first frame is set', () => {
  const h = harness();
  h.enc.start();
  h.at(0);
  h.at(1000);
  assert.equal(h.procs[0].stdin.chunks.length, 0);
});

test('a frame goes out when set, then again on each heartbeat', () => {
  const h = harness();
  h.enc.setFrame(FRAME_A);
  h.enc.start();
  h.at(0);
  const video = h.procs[0].stdin;
  assert.equal(video.chunks.length, 1);
  h.at(20); h.at(500); h.at(980);
  assert.equal(video.chunks.length, 1);
  h.at(1000);
  assert.equal(video.chunks.length, 2);
  h.at(1020);
  assert.equal(video.chunks.length, 2);
  h.at(2000);
  assert.equal(video.chunks.length, 3);
  assert.deepEqual([...video.chunks[2]], [...FRAME_A]);
});

test('a change is written at once, but never two within 50 ms', () => {
  const h = harness();
  h.enc.setFrame(FRAME_A);
  h.enc.start();
  h.at(0);
  const video = h.procs[0].stdin;
  h.enc.setFrame(FRAME_B);
  h.at(20);
  assert.equal(video.chunks.length, 1, 'too soon after the last frame');
  h.enc.setFrame(FRAME_C);
  h.at(40);
  assert.equal(video.chunks.length, 1);
  h.at(60);
  assert.equal(video.chunks.length, 2);
  assert.deepEqual([...video.chunks[1]], [...FRAME_C], 'only the latest picture is sent');
  h.at(300);
  assert.equal(video.chunks.length, 2);
  h.enc.setFrame(FRAME_A);
  h.at(320);
  assert.equal(video.chunks.length, 3);
});

test('minFps sets the heartbeat', () => {
  const h = harness({ minFps: 5 });
  h.enc.setFrame(FRAME_A);
  h.enc.start();
  for (let ms = 0; ms <= 1000; ms += 20) h.at(ms);
  assert.equal(h.procs[0].stdin.chunks.length, 6);
});

test('a missed heartbeat is not made up later', () => {
  const h = harness();
  h.enc.setFrame(FRAME_A);
  h.enc.start();
  h.at(0);
  h.at(5300);
  h.at(5320);
  assert.equal(h.procs[0].stdin.chunks.length, 2);
  h.at(6000);
  assert.equal(h.procs[0].stdin.chunks.length, 3);
});

test('while the video pipe is backed up, frames are dropped, then the current one is sent', () => {
  const h = harness();
  h.enc.setFrame(FRAME_A);
  h.enc.start();
  const video = h.procs[0].stdin;
  video.accept = false;
  h.at(0);
  assert.equal(video.chunks.length, 1);
  h.enc.setFrame(FRAME_B);
  h.at(1000); h.at(2000);
  assert.equal(video.chunks.length, 1);
  video.accept = true;
  video.emit('drain');
  h.at(2020);
  assert.equal(video.chunks.length, 2);
  assert.deepEqual([...video.chunks[1]], [...FRAME_B]);
});

test('audio waits for a backed-up pipe and then catches up exactly', () => {
  const h = harness();
  h.enc.start();
  const audio = h.procs[0].stdio[3];
  audio.accept = false;
  h.at(0);
  h.at(2000);
  assert.equal(audio.bytes(), 6615 * 4);
  audio.accept = true;
  audio.emit('drain');
  h.at(3000);
  assert.equal(audio.bytes(), Math.floor(3150 * 44100 / 1000) * 4);
});

test('an audio pipe stuck for 10 seconds gets ffmpeg killed', () => {
  const h = harness();
  h.enc.start();
  h.procs[0].stdio[3].accept = false;
  h.at(0);
  h.at(9999);
  assert.equal(h.procs[0].killed, undefined);
  h.at(10000);
  assert.equal(h.procs[0].killed, 'SIGKILL');
});

test('ffmpeg is restarted with a doubling delay, and the clocks start again', () => {
  const h = harness();
  h.enc.setFrame(FRAME_A);
  h.enc.start();
  h.at(0);
  h.at(3000);
  h.procs[0].emit('exit', 1, null);
  assert.equal(h.timers[0].ms, 2000);
  h.at(4000);
  assert.equal(h.procs.length, 1);
  h.clock.t = 5000 + 5000;
  h.timers[0].fn();
  assert.equal(h.procs.length, 2);
  h.enc._tick();
  assert.equal(h.procs[1].stdio[3].bytes(), 6615 * 4, 'the audio clock restarted');
  assert.equal(h.procs[1].stdin.chunks.length, 1, 'the current picture is sent again');
  h.procs[1].emit('exit', 1, null);
  assert.equal(h.timers[1].ms, 4000);
});

test('the restart delay is capped at a minute and resets after a healthy minute', () => {
  const h = harness();
  h.enc.start();
  for (let i = 0; i < 7; i++) { h.procs[i].emit('exit', 1, null); h.timers[i].fn(); }
  assert.deepEqual(h.timers.map((t) => t.ms), [2000, 4000, 8000, 16000, 32000, 60000, 60000]);
  h.clock.t += 60000;
  h.procs[7].emit('exit', 1, null);
  assert.equal(h.timers[7].ms, 2000);
});

test('a spawn error also leads to a restart, once', () => {
  const h = harness();
  h.enc.start();
  h.procs[0].emit('error', new Error('spawn ffmpeg ENOENT'));
  h.procs[0].emit('exit', null, null);
  assert.equal(h.timers.length, 1);
});

test('the stream key never reaches the log', () => {
  const h = harness();
  h.enc.start();
  h.procs[0].stderr.emit('data', Buffer.from('Failed to open rtmp://live.twitch.tv/app/SECRETKEY: refused\n'));
  h.procs[0].emit('exit', 1, null);
  assert.ok(h.logs.length >= 2);
  for (const line of h.logs) assert.ok(!line.includes('SECRETKEY'), line);
  assert.ok(h.logs.some((l) => l.includes('<output>')));
});

test('stop ends both pipes, waits for ffmpeg, and does not restart it', async () => {
  const h = harness();
  h.enc.start();
  const p = h.procs[0];
  const stopped = h.enc.stop();
  assert.equal(p.stdin.ended, true);
  assert.equal(p.stdio[3].ended, true);
  p.emit('exit', 0, null);
  await stopped;
  assert.equal(h.timers.length, 0);
  h.enc._tick();
  assert.equal(h.procs.length, 1);
});
