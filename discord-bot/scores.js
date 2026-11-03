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

function createScores({ dataDir, now = Date.now }) {
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

  function leaderboard(userId) {
    const players = Object.keys(data)
      .map((id) => ({ userId: id, count: get(id).count }))
      .filter((player) => player.count > 0)
      // Break ties by id so a player has the same position across requests and restarts.
      .sort((a, b) => b.count - a.count || (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0))
      .map((player, i) => ({ ...player, position: i + 1 }));
    return { top: players.slice(0, 10), player: players.find((player) => player.userId === userId) || null };
  }

  // Each (game, level) counts once per player, so replaying a level does not add to the score.
  function credit(userId, gistId, levelIndex) {
    const key = gistId + ':' + levelIndex;
    const entry = data[userId] || (data[userId] = { solved: [] });
    const before = rankFor(entry.solved.length);
    if (entry.solved.includes(key)) return Object.assign(get(userId), { counted: false, rankedUp: false });
    entry.solved.push(key);
    // Keep exact times so rolling windows and calendar weeks can both be counted later.
    // Older solves have no known date; replaying them must not give them a new one.
    entry.solvedAt = entry.solvedAt || {};
    entry.solvedAt[key] = now();
    save();
    const after = get(userId);
    return Object.assign(after, { counted: true, rankedUp: after.rank > before });
  }

  return { credit, get, leaderboard };
}

module.exports = { createScores, rankFor, nextThreshold, THRESHOLDS };
