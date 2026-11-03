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

test('new solves keep their original timestamp across replays and restarts', (t) => {
  const dir = tmp();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let time = Date.parse('2026-10-23T12:00:00Z');
  const firstTime = time;
  const s = createScores({ dataDir: dir, now: () => time });
  s.credit('u1', 'abcd', 1);
  const file = path.join(dir, 'scores.json');
  const firstSave = fs.readFileSync(file, 'utf8');
  assert.deepEqual(JSON.parse(firstSave).u1.solvedAt, { 'abcd:1': firstTime });

  time += 8 * 24 * 60 * 60 * 1000;
  assert.equal(s.credit('u1', 'abcd', 1).counted, false);
  assert.equal(fs.readFileSync(file, 'utf8'), firstSave);
  const restarted = createScores({ dataDir: dir, now: () => time });
  assert.equal(restarted.credit('u1', 'abcd', 1).counted, false);
  restarted.credit('u1', 'abcd', 2);
  restarted.credit('u2', 'abcd', 1);
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(saved.u1.solvedAt, { 'abcd:1': firstTime, 'abcd:2': time });
  assert.deepEqual(saved.u2.solvedAt, { 'abcd:1': time });
  assert.equal(restarted.get('u1').count, 2);
});

test('legacy solves keep their totals without acquiring invented solve dates', (t) => {
  const dir = tmp();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'scores.json');
  const original = JSON.stringify({ u1: { solved: ['abcd:1', 'abcd:2'] } });
  fs.writeFileSync(file, original);
  const time = Date.parse('2026-10-23T12:00:00Z');
  const s = createScores({ dataDir: dir, now: () => time });
  assert.equal(s.get('u1').count, 2);
  assert.equal(s.credit('u1', 'abcd', 1).counted, false);
  assert.equal(fs.readFileSync(file, 'utf8'), original);
  assert.deepEqual(s.credit('u1', 'abcd', 3), { count: 3, rank: 1, next: 5, counted: true, rankedUp: false });
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(saved.u1.solved, ['abcd:1', 'abcd:2', 'abcd:3']);
  assert.deepEqual(saved.u1.solvedAt, { 'abcd:3': time });
  assert.deepEqual(s.leaderboard('u1').player, { userId: 'u1', count: 3, position: 1 });
});

test('the leaderboard shows ten players by solved count and the caller\'s full position', (t) => {
  const dir = tmp();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const s = createScores({ dataDir: dir });
  for (let i = 1; i <= 12; i++) {
    for (let level = 0; level < i; level++) s.credit('u' + i, 'abcd', level);
  }
  const expected = {
    top: Array.from({ length: 10 }, (_, i) => ({ userId: 'u' + (12 - i), count: 12 - i, position: i + 1 })),
    player: { userId: 'u1', count: 1, position: 12 },
  };
  assert.deepEqual(s.leaderboard('u1'), expected);
  assert.deepEqual(createScores({ dataDir: dir }).leaderboard('u1'), expected);
  assert.deepEqual(s.leaderboard('u3').player, expected.top[9]);
  assert.deepEqual(s.leaderboard('u12').player, expected.top[0]);
});

test('equal scores have stable positions in user id order', (t) => {
  const dir = tmp();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const s = createScores({ dataDir: dir });
  for (const id of ['300', '100', '200']) s.credit(id, 'abcd', 1);
  s.credit('300', 'abcd', 1); // Replaying a solved level must not change the order.
  assert.deepEqual(s.leaderboard('200'), {
    top: [
      { userId: '100', count: 1, position: 1 },
      { userId: '200', count: 1, position: 2 },
      { userId: '300', count: 1, position: 3 },
    ],
    player: { userId: '200', count: 1, position: 2 },
  });
  s.credit('300', 'abcd', 2);
  assert.deepEqual(s.leaderboard('300').player, { userId: '300', count: 2, position: 1 });
});

test('players with no solves are unranked and viewing the leaderboard does not save them', (t) => {
  const dir = tmp();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const s = createScores({ dataDir: dir });
  assert.deepEqual(s.leaderboard('nobody'), { top: [], player: null });
  assert.equal(fs.existsSync(path.join(dir, 'scores.json')), false);
  s.credit('u1', 'abcd', 1);
  const saved = fs.readFileSync(path.join(dir, 'scores.json'), 'utf8');
  assert.deepEqual(s.leaderboard('nobody'), {
    top: [{ userId: 'u1', count: 1, position: 1 }], player: null,
  });
  assert.equal(fs.readFileSync(path.join(dir, 'scores.json'), 'utf8'), saved);
});
