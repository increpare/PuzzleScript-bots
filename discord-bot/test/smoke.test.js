'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

test('engine sources are reachable from discord-bot', () => {
  const enginePath = path.join(__dirname, '..', '..', 'src', 'js', 'engine.js');
  assert.ok(fs.existsSync(enginePath), 'expected ../src/js/engine.js to exist');
});
