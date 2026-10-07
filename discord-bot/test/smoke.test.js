'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { SRC_DIR } = require('../engine-src');

test('engine sources are reachable from discord-bot', () => {
  const enginePath = path.join(SRC_DIR, 'js', 'engine.js');
  assert.ok(fs.existsSync(enginePath), `expected ${enginePath} to exist (run: git submodule update --init)`);
});
