'use strict';
const fs = require('node:fs');
const path = require('node:path');

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
  return {
    discordToken: env.DISCORD_TOKEN,
    appId: env.DISCORD_APP_ID,
    guildId: env.DISCORD_GUILD_ID,
    githubToken: env.GITHUB_TOKEN,
    scoreChannelId: env.SCORE_CHANNEL_ID || null,
    dataDir: env.DATA_DIR || path.join(path.dirname(envPath), 'data'),
  };
}

module.exports = { loadConfig, parseEnv };
