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
  assert.equal(cfg.gistToken, null);
  assert.equal(cfg.workshopShareChannelId, null);
  assert.equal(cfg.labsDir, path.join(dir, '..', 'labs'));
  fs.writeFileSync(file, base + 'WORKSHOP_CHANNEL_ID=555\nLABS_DIR=/somewhere/labs\nGIST_TOKEN=gh\n');
  cfg = loadConfig(file);
  assert.equal(cfg.workshopChannelId, '555');
  assert.equal(cfg.workshopShareChannelId, '555'); // shared games are started in the workshop unless told otherwise
  assert.equal(cfg.gistToken, 'gh');
  fs.writeFileSync(file, base + 'WORKSHOP_CHANNEL_ID=555\nWORKSHOP_SHARE_CHANNEL_ID=777\n');
  assert.equal(loadConfig(file).workshopShareChannelId, '777');
  assert.equal(cfg.labsDir, '/somewhere/labs');
});

test('workshop download URL defaults to the public app and normalizes HTTPS and local HTTP bases', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'psbot-cfg-'));
  const file = path.join(dir, '.env');
  const base = 'DISCORD_TOKEN=abc\nDISCORD_APP_ID=1\nDISCORD_GUILD_ID=2\nGITHUB_TOKEN=ghp\n';
  fs.writeFileSync(file, base);
  assert.equal(loadConfig(file).workshopPublicUrl, 'https://games.increpare.com/puzzlescriptbot/app/');
  for (const url of ['https://downloads.example/app', 'http://localhost:8787/app', 'http://127.0.0.1:8787', 'http://[::1]:8787']) {
    fs.writeFileSync(file, base + 'WORKSHOP_PUBLIC_URL=' + url + '\n');
    assert.equal(loadConfig(file).workshopPublicUrl, url + '/');
  }
});

test('workshop download URL rejects unsafe or ambiguous public bases', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'psbot-cfg-'));
  const file = path.join(dir, '.env');
  const base = 'DISCORD_TOKEN=abc\nDISCORD_APP_ID=1\nDISCORD_GUILD_ID=2\nGITHUB_TOKEN=ghp\n';
  for (const url of ['bad url', 'http://example.com/app/', 'javascript:alert(1)', 'https://user:pass@example.com/app', 'https://example.com/app?session=secret', 'https://example.com/app#fragment', 'ftp://localhost/app']) {
    fs.writeFileSync(file, base + 'WORKSHOP_PUBLIC_URL=' + url + '\n');
    assert.throws(() => loadConfig(file), /WORKSHOP_PUBLIC_URL/);
  }
});

test('the Skinner of the Day: off without a channel, at nine in the morning (UTC) unless told otherwise', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'psbot-cfg-'));
  const file = path.join(dir, '.env');
  const base = 'DISCORD_TOKEN=abc\nDISCORD_APP_ID=1\nDISCORD_GUILD_ID=2\nGITHUB_TOKEN=ghp\n';
  fs.writeFileSync(file, base);
  let cfg = loadConfig(file);
  assert.equal(cfg.skinnerChannelId, null);
  assert.equal(cfg.skinnerHourUtc, 9);
  fs.writeFileSync(file, base + 'SKINNER_CHANNEL_ID=555\nSKINNER_HOUR_UTC=0\n');
  cfg = loadConfig(file);
  assert.equal(cfg.skinnerChannelId, '555');
  assert.equal(cfg.skinnerHourUtc, 0);
  for (const bad of ['24', '-1', '9.5', 'noon']) {
    fs.writeFileSync(file, base + 'SKINNER_HOUR_UTC=' + bad + '\n');
    assert.throws(() => loadConfig(file), /SKINNER_HOUR_UTC/);
  }
});
