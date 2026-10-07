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
  const clock = { t: 5000 }, procs = [], timers = [], logs = [], plan = [];
  const spawnFfmpeg = (output) => {
    if (plan.length) return plan.shift()(output); // a test queues a function to override the next launch
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
  return { enc, clock, procs, timers, logs, plan, at };
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
  assert.ok(has('-g', '2'), 'at the default 1 fps, a keyframe every two seconds of heartbeat frames');
  assert.ok(!a.includes('-force_key_frames'), 'a time-based rule would depend on ffmpeg\'s start-up delay');
  assert.ok(has('-c:a', 'aac'));
  assert.ok(has('-f', 'flv'));
  assert.equal(a[a.length - 1], 'rtmp://example/app/key');
});

test('the keyframe interval is two seconds worth of heartbeat frames', () => {
  const has = (a, ...seq) => a.some((_, i) => seq.every((v, k) => a[i + k] === v));
  assert.ok(has(ffmpegArgs('x', 1), '-g', '2'));
  assert.ok(has(ffmpegArgs('x', 5), '-g', '10'), '5 heartbeats a second for 2 seconds');
  assert.ok(has(ffmpegArgs('x', 0.5), '-g', '2'), 'a group of pictures is never shorter than 2 frames');
  const launches = [];
  const spawnFfmpeg = (output, minFps) => {
    launches.push([output, minFps]);
    const p = new EventEmitter();
    p.stdin = pipe();
    p.stdio = [p.stdin, null, new EventEmitter(), pipe()];
    p.stderr = p.stdio[2];
    p.kill = () => {};
    return p;
  };
  const enc = createEncoder({ output: 'x', minFps: 5, spawnFfmpeg, log: () => {}, autoTick: false });
  enc.start();
  assert.deepEqual(launches, [['x', 5]]);
});

test('a minFps below 1 is raised to 1, so the heartbeat and the keyframe interval agree', () => {
  const launches = [], procs = [];
  let clock = 5000;
  const spawnFfmpeg = (output, minFps) => {
    launches.push(minFps);
    const p = new EventEmitter();
    p.stdin = pipe();
    p.stdio = [p.stdin, null, new EventEmitter(), pipe()];
    p.stderr = p.stdio[2];
    p.kill = () => {};
    procs.push(p);
    return p;
  };
  const enc = createEncoder({ output: 'x', minFps: 0.5, spawnFfmpeg, now: () => clock, log: () => {}, autoTick: false });
  enc.setFrame(FRAME_A);
  enc.start();
  const at = (ms) => { clock = 5000 + ms; enc._tick(); };
  at(0); at(500); at(980);
  assert.equal(procs[0].stdin.chunks.length, 1);
  at(1000);
  assert.equal(procs[0].stdin.chunks.length, 2, 'a heartbeat after 1 second, not 2');
  at(2000);
  assert.equal(procs[0].stdin.chunks.length, 3);
  assert.deepEqual(launches, [1]);
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

test('an address split across two stderr chunks is redacted and logged as one line', () => {
  const h = harness();
  h.enc.start();
  const err = h.procs[0].stderr;
  err.emit('data', Buffer.from('Failed to open rtmp://live.twitch.tv/app/SEC'));
  assert.equal(h.logs.length, 0, 'half a line is not logged yet');
  err.emit('data', Buffer.from('RETKEY: Connection refused\n'));
  assert.deepEqual(h.logs, ['ffmpeg: Failed to open <output>: Connection refused']);
});

test('a line that holds only the bare key is redacted', () => {
  const h = harness({ secrets: ['SECRETKEY', ''] });
  h.enc.start();
  h.procs[0].stderr.emit('data', Buffer.from('bad stream name SECRETKEY, try again\n'));
  h.procs[0].stderr.emit('data', Buffer.from('Failed to open rtmp://live.twitch.tv/app/SECRETKEY\n'));
  h.procs[0].emit('error', new Error('could not use SECRETKEY'));
  assert.deepEqual(h.logs.slice(0, 2), ['ffmpeg: bad stream name <secret>, try again', 'ffmpeg: Failed to open <output>']);
  assert.ok(h.logs.some((l) => l.includes('could not use <secret>')), 'the exit reason too');
  for (const line of h.logs) assert.ok(!line.includes('SECRETKEY'), line);
});

test('a key broken across chunks, with no address around it, is redacted', () => {
  const h = harness({ secrets: ['SECRETKEY'] });
  h.enc.start();
  h.procs[0].stderr.emit('data', Buffer.from('bad stream name SECR'));
  h.procs[0].stderr.emit('data', Buffer.from('ETKEY\n'));
  assert.deepEqual(h.logs, ['ffmpeg: bad stream name <secret>']);
});

test('ffmpeg output is logged a line at a time, and the last partial line when it exits', () => {
  const h = harness();
  h.enc.start();
  const err = h.procs[0].stderr;
  err.emit('data', Buffer.from('first line\nsecond line\n\n  \nthird, no newline yet'));
  assert.deepEqual(h.logs, ['ffmpeg: first line', 'ffmpeg: second line'], 'blank lines are skipped and the partial line waits');
  err.emit('data', Buffer.from(' ... now done\r\nfourth'));
  assert.deepEqual(h.logs.slice(2), ['ffmpeg: third, no newline yet ... now done']);
  h.procs[0].emit('exit', 1, null);
  assert.equal(h.logs[3], 'ffmpeg: fourth', 'whatever remains is logged when the process finishes');
  assert.ok(h.logs[4].startsWith('ffmpeg stopped'));
  assert.equal(h.logs.length, 5);
  h.timers[0].fn();
  h.procs[1].stderr.emit('data', Buffer.from('new process\n'));
  assert.equal(h.logs[5], 'ffmpeg: new process', 'the next process starts with no leftover text');
});

test('a partial line that never ends is flushed redacted, without splitting a key at the cut', () => {
  const h = harness({ secrets: ['SECRETKEY'] });
  h.enc.start();
  const err = h.procs[0].stderr;
  err.emit('data', Buffer.from('x'.repeat(4000)));
  assert.equal(h.logs.length, 0);
  err.emit('data', Buffer.from('y'.repeat(2000) + 'SECRE'));
  assert.ok(h.logs.length >= 1, 'a line past 4096 characters is flushed');
  err.emit('data', Buffer.from('TKEY and more\n'));
  for (const line of h.logs) assert.ok(!line.includes('SECRE'), line.slice(-60));
  assert.ok(h.logs[h.logs.length - 1].includes('<secret> and more'));
  const text = h.logs.map((l) => l.replace(/^ffmpeg: /, '')).join('');
  assert.equal(text.replace(/[^xy]/g, '').length, 6000, 'nothing but the key was lost');
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

test('an unchanged frame goes out only on the heartbeat, even though every write reports a full pipe', () => {
  // A real pipe returns false for a 921,600-byte frame, so every write is followed by a drain.
  const h = harness();
  h.enc.setFrame(FRAME_A);
  h.enc.start();
  const video = h.procs[0].stdin;
  video.accept = false;
  h.at(0);
  video.emit('drain');
  for (let ms = 20; ms <= 900; ms += 20) h.at(ms);
  assert.equal(video.chunks.length, 1, 'the drain does not make the same picture go out again');
  h.at(1000);
  assert.equal(video.chunks.length, 2, 'the heartbeat');
  video.emit('drain');
  h.enc.setFrame(FRAME_B);
  h.at(1020); h.at(1040);
  assert.equal(video.chunks.length, 2, 'a change after the drain still waits out the 50 ms gap');
  h.at(1060);
  assert.equal(video.chunks.length, 3);
  assert.deepEqual([...video.chunks[2]], [...FRAME_B]);
  video.emit('drain');
  for (let ms = 1080; ms <= 1980; ms += 20) h.at(ms);
  assert.equal(video.chunks.length, 3);
  h.at(2000);
  assert.equal(video.chunks.length, 4, 'the next heartbeat');
});

test('a spawn that throws is retried with the same backoff as an exit', () => {
  const h = harness();
  h.plan.push(() => { throw new Error('spawn EAGAIN for rtmp://live.twitch.tv/app/SECRETKEY'); });
  h.plan.push(() => { throw new Error('spawn EAGAIN'); });
  h.enc.setFrame(FRAME_A);
  assert.doesNotThrow(() => h.enc.start());
  assert.equal(h.procs.length, 0);
  assert.deepEqual(h.timers.map((t) => t.ms), [2000]);
  assert.ok(h.logs.some((l) => l.includes('EAGAIN') && l.includes('<output>')), h.logs.join('\n'));
  for (const line of h.logs) assert.ok(!line.includes('SECRETKEY'), line);
  assert.doesNotThrow(() => h.at(500), 'a tick with no process is harmless');
  h.clock.t = 5000 + 2000;
  h.timers[0].fn();
  assert.deepEqual(h.timers.map((t) => t.ms), [2000, 4000], 'a failed launch doubles the delay too');
  h.clock.t = 5000 + 6000;
  h.timers[1].fn();
  assert.equal(h.procs.length, 1);
  h.enc._tick();
  assert.equal(h.procs[0].stdio[3].bytes(), 6615 * 4, 'audio flows once a launch succeeds');
  assert.deepEqual([...h.procs[0].stdin.chunks[0]], [...FRAME_A]);
  assert.equal(h.timers.length, 2);
});

test('a child that comes back without its pipes is a failed launch, restarted once', () => {
  const h = harness();
  h.plan.push(() => { // what Node returns under file-descriptor exhaustion: no streams, an error event to follow
    const p = new EventEmitter();
    p.stdio = [];
    p.kill = (signal) => { p.killed = signal; };
    h.procs.push(p);
    return p;
  });
  assert.doesNotThrow(() => h.enc.start());
  assert.equal(h.procs.length, 1);
  assert.deepEqual(h.timers.map((t) => t.ms), [2000]);
  assert.equal(h.procs[0].killed, 'SIGKILL', 'a half-started child is not left running');
  assert.doesNotThrow(() => h.at(0), 'a tick with no usable process is harmless');
  h.procs[0].emit('error', new Error('spawn ffmpeg EMFILE'));
  h.procs[0].emit('exit', null, null);
  assert.equal(h.timers.length, 1, 'the late error and exit do not schedule a second restart');
  h.clock.t = 5000 + 2000;
  h.timers[0].fn();
  assert.equal(h.procs.length, 2);
  h.enc._tick();
  assert.equal(h.procs[1].stdio[3].bytes(), 6615 * 4);
});
