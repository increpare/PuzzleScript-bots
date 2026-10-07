'use strict';
const { spawn } = require('node:child_process');

const RATE = 44100, TICK_MS = 20, LEAD_MS = 150, MIN_GAP_MS = 50, STALL_MS = 10000;
const FIRST_BACKOFF = 2000, MAX_BACKOFF = 60000, HEALTHY_MS = 60000, KILL_AFTER_MS = 3000;

// Measured on the Pi: an unchanged frame costs as much to encode as a changed one, so the saving
// is in sending few frames; one x264 thread is cheaper than the default at these frame rates.
function ffmpegArgs(output) {
  return [
    '-hide_banner', '-nostdin', '-loglevel', 'warning',
    '-thread_queue_size', '64', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-video_size', '640x360', '-framerate', '30',
    '-use_wallclock_as_timestamps', '1', '-i', 'pipe:0',
    '-thread_queue_size', '512', '-f', 's16le', '-ar', '44100', '-ac', '2', '-i', 'pipe:3',
    '-vf', 'scale=1280:720:flags=neighbor', '-fps_mode', 'vfr',
    '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency', '-threads', '1', '-pix_fmt', 'yuv420p',
    '-crf', '23', '-maxrate', '2500k', '-bufsize', '5000k', '-g', '600', '-force_key_frames', 'expr:gte(t,n_forced*2-0.1)',
    '-c:a', 'aac', '-b:a', '160k',
    '-flush_packets', '1', '-f', 'flv', '-y', output,
  ];
}

function defaultSpawn(output) {
  return spawn('ffmpeg', ffmpegArgs(output), { stdio: ['pipe', 'ignore', 'pipe', 'pipe'] });
}

const monotonicMs = () => Number(process.hrtime.bigint() / 1000000n);

// Owns the ffmpeg process and is the stream's only clock. Video frames are stamped by ffmpeg as
// they arrive, so one is written only when the picture changes, plus a heartbeat. Audio is written
// by sample count: exactly as many samples as real time has advanced, so the two never drift apart.
function createEncoder({ output, minFps = 1, readAudio = () => Buffer.alloc(0), spawnFfmpeg = defaultSpawn, now = monotonicMs, log = console.log, setTimer = setTimeout, clearTimer = clearTimeout, autoTick = true }) {
  const beatMs = 1000 / minFps;
  const redact = (text) => String(text).split(output).join('<output>');
  let frame = null, dirty = false;
  let proc = null, t0 = 0, sentSamples = 0, lastWrite = -Infinity, nextBeat = 0;
  let videoBlocked = false, audioBlocked = false, blockedSince = 0;
  let backoff = FIRST_BACKOFF, restartTimer = null, interval = null, stopped = true;

  function launch() {
    restartTimer = null;
    if (stopped) return;
    const p = spawnFfmpeg(output);
    proc = p;
    t0 = now(); sentSamples = 0; lastWrite = -Infinity; nextBeat = 0;
    videoBlocked = false; audioBlocked = false;
    dirty = true;
    p.stdin.on('error', () => {});    // a dying ffmpeg closes its pipes; the exit handler deals with it
    p.stdio[3].on('error', () => {});
    if (p.stderr) p.stderr.on('data', (d) => log('ffmpeg: ' + redact(d).trim()));
    let done = false;
    const finish = (why) => {
      if (done) return;
      done = true;
      if (proc !== p) return;
      const ran = now() - t0;
      proc = null;
      if (stopped) return;
      if (ran >= HEALTHY_MS) backoff = FIRST_BACKOFF;
      log('ffmpeg stopped (' + redact(why) + '), restarting in ' + backoff + ' ms');
      restartTimer = setTimer(launch, backoff);
      backoff = Math.min(backoff * 2, MAX_BACKOFF);
    };
    p.on('error', (e) => finish(e && e.message));
    p.on('exit', (code, signal) => finish(signal || 'code ' + code));
  }

  function tick() {
    const p = proc;
    if (!p) return;
    const t = now() - t0;

    if (audioBlocked) {
      if (now() - blockedSince >= STALL_MS) { log('ffmpeg is not reading, restarting it'); p.kill('SIGKILL'); return; }
    } else {
      const owed = Math.floor((t + LEAD_MS) * RATE / 1000) - sentSamples;
      if (owed > 0) {
        const want = owed * 4;
        let buf = readAudio(want);
        if (buf.length < want) buf = Buffer.concat([buf, Buffer.alloc(want - buf.length)]); // silence
        sentSamples += owed;
        if (!p.stdio[3].write(buf)) {
          audioBlocked = true;
          blockedSince = now();
          p.stdio[3].once('drain', () => { if (proc === p) audioBlocked = false; });
        }
      }
    }

    const beat = t >= nextBeat;
    while (nextBeat <= t) nextBeat += beatMs; // a missed heartbeat is skipped, not made up
    if (frame && !videoBlocked && (beat || (dirty && t - lastWrite >= MIN_GAP_MS))) {
      dirty = false;
      lastWrite = t;
      if (!p.stdin.write(frame)) {
        videoBlocked = true;
        p.stdin.once('drain', () => { if (proc === p) { videoBlocked = false; dirty = true; } });
      }
    }
  }

  return {
    start() {
      if (!stopped) return;
      stopped = false;
      launch();
      if (autoTick) interval = setInterval(tick, TICK_MS);
    },
    stop() {
      stopped = true;
      if (interval) { clearInterval(interval); interval = null; }
      if (restartTimer !== null) { clearTimer(restartTimer); restartTimer = null; }
      const p = proc;
      if (!p) return Promise.resolve();
      return new Promise((resolve) => {
        const killer = setTimeout(() => p.kill('SIGKILL'), KILL_AFTER_MS);
        p.once('exit', () => { clearTimeout(killer); resolve(); });
        p.stdin.end();
        p.stdio[3].end();
      });
    },
    setFrame(rgba) {
      frame = Buffer.isBuffer(rgba) ? rgba : Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength);
      dirty = true;
    },
    _tick: tick,
  };
}

module.exports = { createEncoder, ffmpegArgs };
