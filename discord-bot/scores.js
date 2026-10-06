'use strict';
const fs = require('node:fs');
const path = require('node:path');

// A player's rank goes up each time their count of distinct solved levels reaches one of these.
const THRESHOLDS = [1, 5, 10, 15, 20, 25, 30, 40, 50, 60, 70, 80, 90, 100];

function rankFor(count) {
  let rank = 0;
  for (const t of THRESHOLDS) if (count >= t) rank++;
  return rank;
}

function nextThreshold(count) {
  const t = THRESHOLDS.find((x) => x > count);
  return t === undefined ? null : t;
}

function createScores({ dataDir }) {
  const file = path.join(dataDir, 'scores.json');
  fs.mkdirSync(dataDir, { recursive: true });
  let data = {};
  try { data = JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch (e) { data = {}; }

  function save() {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, file);
  }

  function get(userId) {
    const solved = (data[userId] && data[userId].solved) || [];
    return { count: solved.length, rank: rankFor(solved.length), next: nextThreshold(solved.length) };
  }

  // Each (game, level) counts once per player, so replaying a level does not add to the score.
  function credit(userId, gistId, levelIndex) {
    const key = gistId + ':' + levelIndex;
    const entry = data[userId] || (data[userId] = { solved: [] });
    const before = rankFor(entry.solved.length);
    if (entry.solved.includes(key)) return Object.assign(get(userId), { counted: false, rankedUp: false });
    entry.solved.push(key);
    save();
    const after = get(userId);
    return Object.assign(after, { counted: true, rankedUp: after.rank > before });
  }

  return { credit, get };
}

module.exports = { createScores, rankFor, nextThreshold, THRESHOLDS };
