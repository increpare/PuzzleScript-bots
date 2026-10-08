'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createDaily, createPoster } = require('../skinner-daily');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'psbot-skinner-'));
const HOUR = 60 * 60 * 1000;
const at = (iso) => Date.parse(iso + 'Z');
const PUZZLES = ['A.1', 'A.2', 'A.3'].map((id) => ({ id }));

// A daily poster with a clock to set, GitHub and Discord to switch off, and a record of what it did.
function setup({ dataDir = tmp(), puzzles = PUZZLES, random = () => 0 } = {}) {
  const world = { clock: at('2026-10-08T12:00:00'), gistsDown: false, discordDown: false, made: [], posts: [], logs: [] };
  const daily = createDaily({
    dataDir, puzzles, hourUtc: 9, random,
    now: () => world.clock,
    log: (...args) => world.logs.push(args.join(' ')),
    async makeGist(puzzle) {
      if (world.gistsDown) return { ok: false, error: 'GitHub could not be reached' };
      world.made.push(puzzle.id);
      return { ok: true, id: 'gist' + world.made.length };
    },
    async post(puzzle, gistId) {
      if (world.discordDown) throw new Error('Missing Access');
      world.posts.push(puzzle.id + ' ' + gistId);
    },
  });
  return { daily, world, dataDir };
}

test('a puzzle is posted once the hour has come, with a gist made for it', async () => {
  const { daily, world } = setup();
  world.clock = at('2026-10-08T08:59:00');
  assert.equal(await daily.tick(), null);
  assert.deepEqual(world.posts, []);
  world.clock = at('2026-10-08T09:00:00');
  assert.deepEqual(await daily.tick(), { puzzle: PUZZLES[0], gistId: 'gist1' });
  assert.deepEqual(world.posts, ['A.1 gist1']);
});

test('one puzzle a day, by the calendar in UTC', async () => {
  const { daily, world } = setup();
  await daily.tick();
  world.clock = at('2026-10-08T23:59:00');
  assert.equal(await daily.tick(), null);
  world.clock = at('2026-10-09T08:00:00');
  assert.equal(await daily.tick(), null);
  world.clock = at('2026-10-09T09:30:00');
  assert.notEqual(await daily.tick(), null);
  assert.equal(world.posts.length, 2);
});

test('the puzzle is picked at random from those not yet posted, and when all have been, from all again', async () => {
  const picks = [0.99, 0.99, 0.5, 0.4];
  const { daily, world } = setup({ random: () => picks.shift() });
  for (let day = 8; day <= 11; day++) {
    world.clock = at('2026-10-' + String(day).padStart(2, '0') + 'T10:00:00');
    await daily.tick();
  }
  // last of three, last of the two left, the one left, then the second of all three
  assert.deepEqual(world.posts, ['A.3 gist1', 'A.2 gist2', 'A.1 gist3', 'A.2 gist2']);
  assert.deepEqual(world.made, ['A.3', 'A.2', 'A.1']); // a puzzle that comes round again keeps its gist
});

test('what has been posted is remembered over a restart', async () => {
  const first = setup();
  await first.daily.tick();
  const second = setup({ dataDir: first.dataDir });
  assert.equal(await second.daily.tick(), null); // the same day
  second.world.clock = at('2026-10-09T10:00:00');
  assert.equal((await second.daily.tick()).puzzle.id, 'A.2'); // A.1 is not picked again
});

test('when GitHub fails, the same puzzle is tried again an hour later', async () => {
  const picks = [0.5, 0];
  const { daily, world } = setup({ random: () => picks.shift() });
  world.gistsDown = true;
  assert.equal(await daily.tick(), null);
  assert.match(world.logs[0], /A\.2.*GitHub could not be reached/);
  world.gistsDown = false;
  world.clock += HOUR - 1;
  assert.equal(await daily.tick(), null); // not yet
  assert.deepEqual(world.made, []);
  world.clock += 1;
  assert.equal((await daily.tick()).puzzle.id, 'A.2');
});

test('when Discord fails, the puzzle is posted later with the gist it already has', async () => {
  const { daily, world, dataDir } = setup();
  world.discordDown = true;
  assert.equal(await daily.tick(), null);
  assert.match(world.logs[0], /A\.1.*Missing Access/);
  world.discordDown = false;
  // even after a restart, which forgets the hour's wait
  const again = setup({ dataDir });
  assert.deepEqual(await again.daily.tick(), { puzzle: PUZZLES[0], gistId: 'gist1' });
  assert.deepEqual(again.world.made, []);
});

test('a second tick while one is still posting does nothing', async () => {
  const { daily, world } = setup();
  const [a, b] = await Promise.all([daily.tick(), daily.tick()]);
  assert.notEqual(a, null);
  assert.equal(b, null);
  assert.equal(world.posts.length, 1);
});

test('a puzzle left waiting that is no longer among the puzzles is dropped for another', async () => {
  const first = setup();
  first.world.discordDown = true;
  await first.daily.tick(); // A.1 waits
  const second = setup({ dataDir: first.dataDir, puzzles: PUZZLES.slice(1) });
  assert.equal((await second.daily.tick()).puzzle.id, 'A.2');
});

// Just enough of Discord and of the game registry for posting: a channel that keeps its messages,
// and games that start unless told not to.
function postingWorld() {
  const world = { messages: [], started: [], startFails: null, sendFailsAfter: Infinity, logs: [] };
  const channel = {
    id: 'play', parentId: null,
    async send(payload) {
      if (world.messages.length >= world.sendFailsAfter) throw new Error('Missing Permissions');
      const m = { id: 'm' + (world.messages.length + 1), payload, async edit(p) { m.payload = p; return m; } };
      world.messages.push(m);
      return m;
    },
  };
  const registry = {
    async start(args) {
      if (world.startFails) throw world.startFails;
      world.started.push(args);
      return { record: { gameId: args.gameId }, snapshot: { kind: 'level' } };
    },
  };
  const poster = createPoster({
    fetchChannel: async () => { if (world.noChannel) throw new Error('Unknown Channel'); return channel; },
    registry,
    announcement: (puzzle, gistId) => 'Skinner of the Day: ' + puzzle.id + ' ' + gistId,
    frame: (record, snapshot, where) => ({ content: '', frameOf: record.gameId, where }),
    log: (...args) => world.logs.push(args.join(' ')),
  });
  return { world, poster };
}

test('the day\'s puzzle is announced, and a game of it started under the announcement', async () => {
  const { world, poster } = postingWorld();
  await poster.post({ id: 'A.1' }, 'abc123');
  assert.deepEqual(world.messages.map((m) => m.payload), [
    { content: 'Skinner of the Day: A.1 abc123' },
    { content: '', frameOf: 'm2', where: { channelId: 'play', parentId: null } },
  ]);
  // a game is known by the id of its message
  assert.deepEqual(world.started, [{ gameId: 'm2', channelId: 'play', gistId: 'abc123' }]);
});

test('with no channel to post in, posting fails, to be tried again', async () => {
  const { world, poster } = postingWorld();
  world.noChannel = true;
  await assert.rejects(poster.post({ id: 'A.1' }, 'abc123'), /Unknown Channel/);
  world.noChannel = false;
  world.sendFailsAfter = 0;
  await assert.rejects(poster.post({ id: 'A.1' }, 'abc123'), /Missing Permissions/);
  assert.deepEqual(world.messages, []);
});

test('once the announcement is out the puzzle counts as posted, even if its game does not start', async () => {
  const { world, poster } = postingWorld();
  world.startFails = new Error('could not reach GitHub');
  await poster.post({ id: 'A.1' }, 'abc123');
  assert.equal(world.messages[1].payload.content, 'It could not be started here. Play it at https://www.puzzlescript.net/play.html?p=abc123');
  assert.match(world.logs[0], /A\.1.*could not reach GitHub/);

  const second = postingWorld();
  second.world.sendFailsAfter = 1; // the announcement goes out, the game's message does not
  await second.poster.post({ id: 'A.1' }, 'abc123');
  assert.equal(second.world.messages.length, 1);
  assert.match(second.world.logs[0], /A\.1.*Missing Permissions/);
});
