'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadConfig, loadPaths } = require('../config');

function envFile(text) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'twitch-config-'));
  const file = path.join(dir, '.env');
  fs.writeFileSync(file, text);
  return file;
}

test('loads a full config with defaults', () => {
  const file = envFile('TWITCH_CHANNEL=#SomeChannel\nTWITCH_STREAM_KEY=live_123\nGITHUB_TOKEN=gh\n');
  const cfg = loadConfig(file, {});
  assert.equal(cfg.channel, 'somechannel');
  assert.equal(cfg.githubToken, 'gh');
  assert.equal(cfg.output, 'rtmp://live.twitch.tv/app/live_123');
  assert.equal(cfg.minFps, 1);
  assert.equal(cfg.musicDir, '/mnt/media/increpare');
  assert.equal(cfg.dataDir, path.join(path.dirname(file), 'data'));
});

test('OUTPUT replaces the Twitch address and makes the key optional', () => {
  const cfg = loadConfig(envFile('TWITCH_CHANNEL=c\nGITHUB_TOKEN=gh\nOUTPUT=/tmp/x.flv\n'), {});
  assert.equal(cfg.output, '/tmp/x.flv');
});

test('names the missing keys', () => {
  assert.throws(() => loadConfig(envFile('GITHUB_TOKEN=gh\n'), {}), /missing config: TWITCH_CHANNEL, TWITCH_STREAM_KEY/);
});

test('MIN_FPS is read, kept between 1 and 20, and falls back to 1 when invalid', () => {
  const base = 'TWITCH_CHANNEL=c\nGITHUB_TOKEN=gh\nOUTPUT=o\n';
  assert.equal(loadConfig(envFile(base + 'MIN_FPS=5\n'), {}).minFps, 5);
  assert.equal(loadConfig(envFile(base + 'MIN_FPS=0.5\n'), {}).minFps, 1, 'it only raises the idle frame rate');
  assert.equal(loadConfig(envFile(base + 'MIN_FPS=99\n'), {}).minFps, 20);
  assert.equal(loadConfig(envFile(base + 'MIN_FPS=zero\n'), {}).minFps, 1);
  assert.equal(loadConfig(envFile(base + 'MIN_FPS=-2\n'), {}).minFps, 1);
});

test('the process environment overrides the file', () => {
  const cfg = loadConfig(envFile('TWITCH_CHANNEL=c\nGITHUB_TOKEN=gh\nOUTPUT=o\n'), { MUSIC_DIR: '/music', DATA_DIR: '/data' });
  assert.equal(cfg.musicDir, '/music');
  assert.equal(cfg.dataDir, '/data');
});

test('loadPaths needs no Twitch keys', () => {
  const file = envFile('MUSIC_DIR=/m\n');
  assert.deepEqual(loadPaths(file, {}), { musicDir: '/m', dataDir: path.join(path.dirname(file), 'data') });
});
