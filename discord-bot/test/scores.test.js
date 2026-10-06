'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createScores, rankFor, nextThreshold } = require('../scores');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'psbot-scores-'));

test('ranks rise at the configured thresholds', () => {
  assert.deepEqual([0, 1, 4, 5, 9, 10, 30, 39, 40, 100, 250].map(rankFor), [0, 1, 1, 2, 2, 3, 7, 7, 8, 14, 14]);
  assert.equal(nextThreshold(0), 1);
  assert.equal(nextThreshold(5), 10);
  assert.equal(nextThreshold(100), null);
});

test('a level counts once per player and rank-ups are reported', () => {
  const s = createScores({ dataDir: tmp() });
  const first = s.credit('u1', 'abcd', 1);
  assert.deepEqual([first.count, first.rank, first.counted, first.rankedUp], [1, 1, true, true]);
  const again = s.credit('u1', 'abcd', 1);
  assert.deepEqual([again.count, again.counted, again.rankedUp], [1, false, false]);
  let last;
  for (let i = 2; i <= 5; i++) last = s.credit('u1', 'abcd', i);
  assert.deepEqual([last.count, last.rank, last.rankedUp], [5, 2, true]);
  assert.equal(s.credit('u1', 'abcd', 6).rankedUp, false);
  assert.equal(s.get('nobody').count, 0);
});

test('scores survive a restart', () => {
  const dir = tmp();
  createScores({ dataDir: dir }).credit('u1', 'abcd', 1);
  assert.equal(createScores({ dataDir: dir }).get('u1').count, 1);
});
