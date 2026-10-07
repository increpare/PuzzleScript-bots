'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { parseEnv } = require('../discord-bot/config');

const DEFAULT_ENV = path.join(__dirname, '.env');

function readEnv(envPath, processEnv) {
  return Object.assign({}, fs.existsSync(envPath) ? parseEnv(fs.readFileSync(envPath, 'utf8')) : {}, processEnv);
}

// Where the music and the bot's own data live; all that index-music.js needs.
function loadPaths(envPath = DEFAULT_ENV, processEnv = process.env) {
  const env = readEnv(envPath, processEnv);
  return {
    musicDir: env.MUSIC_DIR || '/mnt/media/increpare',
    dataDir: env.DATA_DIR || path.join(path.dirname(envPath), 'data'),
  };
}

function loadConfig(envPath = DEFAULT_ENV, processEnv = process.env) {
  const env = readEnv(envPath, processEnv);
  const required = ['TWITCH_CHANNEL', 'GITHUB_TOKEN'];
  if (!env.OUTPUT) required.push('TWITCH_STREAM_KEY');
  const missing = required.filter((k) => !env[k]);
  if (missing.length) throw new Error('missing config: ' + missing.join(', ') + ' (see .env.example)');
  const minFps = Number(env.MIN_FPS);
  return Object.assign(loadPaths(envPath, processEnv), {
    channel: String(env.TWITCH_CHANNEL).trim().replace(/^#/, '').toLowerCase(),
    githubToken: env.GITHUB_TOKEN,
    output: env.OUTPUT || 'rtmp://live.twitch.tv/app/' + env.TWITCH_STREAM_KEY,
    streamKey: env.TWITCH_STREAM_KEY || null, // kept apart so the encoder can keep it out of the log by itself
    minFps: Number.isFinite(minFps) ? Math.min(Math.max(minFps, 1), 20) : 1, // only ever raises the idle frame rate
  });
}

module.exports = { loadConfig, loadPaths };
