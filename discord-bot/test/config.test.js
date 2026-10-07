'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadConfig } = require('../config');

test('loads keys from an env file and reports missing ones', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'psbot-cfg-'));
  const file = path.join(dir, '.env');
  fs.writeFileSync(file, '# comment\nDISCORD_TOKEN=abc\nDISCORD_APP_ID=1\nDISCORD_GUILD_ID=2\nGITHUB_TOKEN="ghp"\n');
  const cfg = loadConfig(file);
  assert.equal(cfg.discordToken, 'abc');
  assert.equal(cfg.githubToken, 'ghp');
  assert.equal(cfg.dataDir, path.join(dir, 'data'));
  fs.writeFileSync(file, 'DISCORD_TOKEN=abc\n');
  assert.throws(() => loadConfig(file), /DISCORD_APP_ID.*DISCORD_GUILD_ID.*GITHUB_TOKEN/s);
});

test('activity settings are optional and have safe defaults', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'psbot-cfg-'));
  const file = path.join(dir, '.env');
  const base = 'DISCORD_TOKEN=abc\nDISCORD_APP_ID=1\nDISCORD_GUILD_ID=2\nGITHUB_TOKEN=ghp\n';
  fs.writeFileSync(file, base);
  let cfg = loadConfig(file);
  assert.equal(cfg.clientSecret, null);
  assert.equal(cfg.httpPort, 8787);
  assert.deepEqual(cfg.tweakChannels, []);
  fs.writeFileSync(file, base + 'DISCORD_CLIENT_SECRET=shh\nHTTP_PORT=9000\nTWEAK_CHANNEL_IDS=111,222\n');
  cfg = loadConfig(file);
  assert.equal(cfg.clientSecret, 'shh');
  assert.equal(cfg.httpPort, 9000);
  assert.deepEqual(cfg.tweakChannels, ['111', '222']);
  fs.writeFileSync(file, base + 'HTTP_PORT=nope\n');
  assert.throws(() => loadConfig(file), /HTTP_PORT/);
});

test('workshop settings: no channel by default, and labs beside the bot', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'psbot-cfg-'));
  const file = path.join(dir, '.env');
  const base = 'DISCORD_TOKEN=abc\nDISCORD_APP_ID=1\nDISCORD_GUILD_ID=2\nGITHUB_TOKEN=ghp\n';
  fs.writeFileSync(file, base);
  let cfg = loadConfig(file);
  assert.equal(cfg.workshopChannelId, null);
  assert.equal(cfg.labsDir, path.join(dir, '..', 'labs'));
  fs.writeFileSync(file, base + 'WORKSHOP_CHANNEL_ID=555\nLABS_DIR=/somewhere/labs\n');
  cfg = loadConfig(file);
  assert.equal(cfg.workshopChannelId, '555');
  assert.equal(cfg.labsDir, '/somewhere/labs');
});
