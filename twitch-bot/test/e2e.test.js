'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');
const { createApp } = require('../main');

const SOKOBAN = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'demo', 'sokoban_basic.txt'), 'utf8');
const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0 && spawnSync('ffprobe', ['-version']).status === 0;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('the whole pipeline produces a playable stream with video and audio', { skip: hasFfmpeg ? false : 'ffmpeg is not installed', timeout: 60000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'twitch-e2e-'));
  fs.mkdirSync(path.join(dir, 'music', 'album'), { recursive: true });
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=330:duration=20', '-ac', '2', path.join(dir, 'music', 'album', 'tone.wav')]);
  fs.writeFileSync(path.join(dir, 'music-index.json'), JSON.stringify({ root: path.join(dir, 'music'), tracks: [{ path: 'album/tone.wav', album: 'album', title: 'tone', seconds: 20 }] }));
  const out = path.join(dir, 'out.flv');

  const app = createApp({
    cfg: { dataDir: dir, output: out, minFps: 1 },
    gallery: [{ gistId: 'aaaa', title: 'Sokoban', author: 'test' }],
    getSource: async () => SOKOBAN,
    log: () => {},
  });
  await app.start();
  assert.equal(app.session.view().phase, 'playing');
  const moves = ['right', 'up', 'l', 'd', 'x', 'z'];
  moves.forEach((text, i) => setTimeout(() => app.session.handleChat({ user: 'tester', text }), 1500 + i * 1300));
  await wait(12000);
  assert.ok(app.session.view().moves.length >= 4, 'chat moved the player');
  await app.stop();

  const streams = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,width,height,sample_rate,channels', '-of', 'json', out], { encoding: 'utf8' })).streams;
  const video = streams.find((s) => s.codec_type === 'video'), audio = streams.find((s) => s.codec_type === 'audio');
  assert.equal(video.codec_name, 'h264');
  assert.deepEqual([video.width, video.height], [1280, 720]);
  assert.equal(audio.codec_name, 'aac');
  assert.equal(Number(audio.sample_rate), 44100);
  assert.equal(audio.channels, 2);

  const packets = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'packet=codec_type,pts_time,flags', '-of', 'csv=p=0', out], { encoding: 'utf8' })
    .trim().split('\n').map((line) => line.split(',')).map(([type, pts, flags]) => ({ type, t: Number(pts), key: String(flags).includes('K') }));
  const v = packets.filter((p) => p.type === 'video'), a = packets.filter((p) => p.type === 'audio');
  assert.ok(v.length >= 12, 'a heartbeat frame each second, plus the moves: got ' + v.length);
  assert.ok(v.length <= 60, 'frames are sent on change, not continuously: got ' + v.length);
  const keys = v.filter((p) => p.key).map((p) => p.t);
  assert.ok(keys.length >= 5, 'keyframes: got ' + keys.length);
  for (let i = 1; i < keys.length; i++) assert.ok(keys[i] - keys[i - 1] <= 2.2, 'keyframe gap ' + (keys[i] - keys[i - 1]));
  assert.ok(a[a.length - 1].t >= 10, 'audio runs the whole time');
  for (let i = 1; i < a.length; i++) assert.ok(a[i].t - a[i - 1].t < 0.1, 'audio gap at ' + a[i].t);
});
