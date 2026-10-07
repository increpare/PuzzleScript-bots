'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createThreadIndex } = require('../threads');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'psbot-threads-'));

test('the thread for a game in a channel is remembered across restarts', () => {
  const dir = tmp();
  const index = createThreadIndex({ dataDir: dir });
  assert.equal(index.get('c1', 'gist'), null);
  index.set('c1', 'gist', 't1');
  index.set('c2', 'gist', 't2');
  index.set('c1', 'other', 't3');
  assert.equal(index.get('c1', 'gist'), 't1');
  const again = createThreadIndex({ dataDir: dir });
  assert.equal(again.get('c1', 'gist'), 't1');
  assert.equal(again.get('c2', 'gist'), 't2');
  assert.equal(again.get('c1', 'other'), 't3');
  again.set('c1', 'gist', 't9');
  assert.equal(createThreadIndex({ dataDir: dir }).get('c1', 'gist'), 't9');
});

test('a corrupt index is treated as empty', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'threads.json'), '{ not json');
  const index = createThreadIndex({ dataDir: dir });
  assert.equal(index.get('c', 'g'), null);
  index.set('c', 'g', 't');
  assert.equal(createThreadIndex({ dataDir: dir }).get('c', 'g'), 't');
});
