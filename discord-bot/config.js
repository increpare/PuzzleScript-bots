'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { parseTweakChannels } = require('./tweaks');

function parseEnv(text) {
  const out = {};
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    let v = line.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[line.slice(0, eq).trim()] = v;
  }
  return out;
}

function loadConfig(envPath = path.join(__dirname, '.env')) {
  const env = Object.assign({}, fs.existsSync(envPath) ? parseEnv(fs.readFileSync(envPath, 'utf8')) : {}, process.env);
  const required = ['DISCORD_TOKEN', 'DISCORD_APP_ID', 'DISCORD_GUILD_ID', 'GITHUB_TOKEN'];
  const missing = required.filter((k) => !env[k]);
  if (missing.length) throw new Error('missing config: ' + missing.join(', ') + ' (see .env.example)');
  const httpPort = env.HTTP_PORT ? Number(env.HTTP_PORT) : 8787;
  if (!Number.isInteger(httpPort) || httpPort < 1 || httpPort > 65535) throw new Error('HTTP_PORT must be a port number');
  return {
    discordToken: env.DISCORD_TOKEN,
    appId: env.DISCORD_APP_ID,
    guildId: env.DISCORD_GUILD_ID,
    githubToken: env.GITHUB_TOKEN,
    scoreChannelId: env.SCORE_CHANNEL_ID || null,
    dataDir: env.DATA_DIR || path.join(path.dirname(envPath), 'data'),
    // The level editor Activity: without the client secret the http server is not started at all.
    clientSecret: env.DISCORD_CLIENT_SECRET || null,
    httpPort,
    tweakChannels: parseTweakChannels(env.TWEAK_CHANNEL_IDS),
    // The workshop: one channel whose Activity is a shared PuzzleScript editor. The editor is the
    // PuzzleScript-labs one, copied beside the bot when it is deployed.
    workshopChannelId: env.WORKSHOP_CHANNEL_ID || null,
    labsDir: env.LABS_DIR || path.join(path.dirname(envPath), '..', 'labs'),
  };
}

module.exports = { loadConfig, parseEnv };
