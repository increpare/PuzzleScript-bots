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
