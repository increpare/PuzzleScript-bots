'use strict';
const fs = require('node:fs');
const path = require('node:path');

const HOUR = 60 * 60 * 1000;

// The Skinner of the Day: once a day, from hourUtc on, one puzzle is picked at random, a gist is
// made of its game and it is posted. No puzzle comes round again until all have been posted.
// makeGist(puzzle) answers { ok, id } or { ok: false, error }; post(puzzle, gistId) throws if the
// puzzle could not be posted. What has been picked, made and posted is kept in one small file, so
// that a failure or a restart part-way carries on with the same puzzle and the same gist.
function createDaily({ dataDir, puzzles, makeGist, post, hourUtc = 9, now = Date.now, random = Math.random, retryMs = HOUR, log = console.error }) {
  const file = path.join(dataDir, 'skinner.json');
  fs.mkdirSync(dataDir, { recursive: true });
  // day: the day (UTC) of the last post. waiting: the puzzle picked but not yet posted.
  // gists: puzzle id -> gist id, for every gist made. posted: the puzzles posted in this round.
  const state = { day: null, waiting: null, gists: {}, posted: [] };
  try {
    const read = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (typeof read.day === 'string') state.day = read.day;
    if (typeof read.waiting === 'string') state.waiting = read.waiting;
    if (read.gists && typeof read.gists === 'object' && !Array.isArray(read.gists)) state.gists = read.gists;
    if (Array.isArray(read.posted)) state.posted = read.posted.map(String);
  } catch (e) { /* nothing posted yet */ }

  function save() {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, file);
  }

  function pick() {
    let left = puzzles.filter((p) => !state.posted.includes(p.id));
    if (left.length === 0) { state.posted = []; left = puzzles; }
    return left[Math.min(left.length - 1, Math.floor(random() * left.length))];
  }

  let busy = false;
  let retryAt = 0;

  async function attempt() {
    const date = new Date(now());
    const day = date.toISOString().slice(0, 10);
    if (state.day === day || date.getUTCHours() < hourUtc || now() < retryAt) return null;
    let puzzle = puzzles.find((p) => p.id === state.waiting);
    if (!puzzle) {
      puzzle = pick();
      state.waiting = puzzle.id;
      save();
    }
    const later = (why) => { log('the Skinner of the Day (' + puzzle.id + ') is not posted yet:', why); retryAt = now() + retryMs; return null; };
    if (typeof state.gists[puzzle.id] !== 'string') {
      const made = await makeGist(puzzle);
      if (!made.ok) return later(made.error);
      state.gists[puzzle.id] = made.id;
      save();
    }
    const gistId = state.gists[puzzle.id];
    try { await post(puzzle, gistId); } catch (e) { return later((e && e.message) || String(e)); }
    state.posted.push(puzzle.id);
    state.day = day;
    state.waiting = null;
    save();
    return { puzzle, gistId };
  }

  return {
    // Posts the day's puzzle if it is due. Answers what was posted, or null.
    async tick() {
      if (busy) return null;
      busy = true;
      try { return await attempt(); } finally { busy = false; }
    },
  };
}

// Posting a puzzle: the announcement, and under it a game of the puzzle, started as /play would
// start it. Once the announcement is out the puzzle counts as posted, since it carries a link to
// the game in a browser; a second announcement would be worse than a game missing under the first.
function createPoster({ fetchChannel, registry, announcement, frame, log = console.error }) {
  async function post(puzzle, gistId) {
    const channel = await fetchChannel();
    await channel.send({ content: announcement(puzzle, gistId) });
    let message = null;
    try {
      // A game is known by the id of its message, so the message has to exist before the game does.
      message = await channel.send({ content: 'Starting it…' });
      const { record, snapshot } = await registry.start({ gameId: message.id, channelId: channel.id, gistId });
      await message.edit(frame(record, snapshot, { channelId: channel.id, parentId: channel.parentId || null }));
    } catch (e) {
      log('the game of the Skinner of the Day (' + puzzle.id + ') could not be started:', (e && e.message) || String(e));
      if (message) await message.edit({ content: 'It could not be started here. Play it at https://www.puzzlescript.net/play.html?p=' + gistId }).catch(() => {});
    }
  }
  return { post };
}

module.exports = { createDaily, createPoster };
