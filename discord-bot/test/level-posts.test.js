'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createPool } = require('../pool');
const { createRegistry } = require('../games');
const { createSourceStore } = require('../sources');
const { createLevelStore } = require('../levels');
const { createThreadIndex } = require('../threads');
const { createLevelPoster } = require('../level-posts');
const { SRC_DIR } = require('../engine-src');

const SOKOBAN = fs.readFileSync(path.join(SRC_DIR, 'demo', 'sokoban_basic.txt'), 'utf8');
const TITLE = 'Simple Block Pushing Game';
const TWO_STEPS = '######\n#p.*o#\n######';
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'psbot-posts-'));

// Just enough of discord.js for the poster: channels, threads, messages.
function fakeDiscord() {
  let next = 100;
  const channels = new Map();
  function makeThread(parent, name) {
    const thread = {
      id: 't' + next++, name, parentId: parent.id, sent: [], isThread: () => true,
      async send(payload) {
        const m = { id: 'm' + next++, payload, async edit(p) { m.payload = p; return m; } };
        thread.sent.push(m);
        return m;
      },
    };
    parent.threadsById.set(thread.id, thread);
    channels.set(thread.id, thread);
    return thread;
  }
  function makeChannel(id) {
    const channel = {
      id, parentId: null, isThread: () => false, threadsById: new Map(), messagesById: new Map(), standalone: 0,
      threads: {
        async fetch(tid) { const t = channel.threadsById.get(tid); if (!t) throw new Error('Unknown Channel'); return t; },
        async create({ name }) { channel.standalone++; return makeThread(channel, name); },
      },
      messages: { async fetch(mid) { const m = channel.messagesById.get(mid); if (!m) throw new Error('Unknown Message'); return m; } },
    };
    channels.set(id, channel);
    return channel;
  }
  function addGameMessage(channel, id) {
    channel.messagesById.set(id, { id, async startThread({ name }) { return makeThread(channel, name); } });
  }
  return { guildId: 'G', makeChannel, makeThread, addGameMessage, async channel(id) { const c = channels.get(id); if (!c) throw new Error('Unknown Channel'); return c; } };
}

async function setup(t, { perHour = 10, maxLevelBytes, now = Date.now } = {}) {
  const dir = tmp();
  const pool = createPool({ size: 1 });
  const sources = createSourceStore({ dataDir: dir });
  const levels = createLevelStore({ dataDir: dir, maxBytes: maxLevelBytes });
  const threads = createThreadIndex({ dataDir: dir });
  const getSource = async (id) => { if (id === 'sok') return SOKOBAN; throw new Error('unknown gist'); };
  const registry = createRegistry({ dataDir: dir, pool, getSource, sources, levels });
  const discord = fakeDiscord();
  const channel = discord.makeChannel('chan');
  discord.addGameMessage(channel, 'game1');
  const poster = createLevelPoster({
    registry, levels, pool, sources, getSource, threads, discord, perHour, now, log: () => {},
    frame: (record, snapshot, where) => ({ framed: true, levelId: record.levelId, kind: snapshot.kind, where }),
  });
  t.after(async () => { await registry.close(); await pool.close(); });
  const ticket = (over = {}) => Object.assign({ uid: 'u1', gistId: 'sok', baseSourceHash: null, channelId: 'chan', gameId: 'game1', authorName: 'Ada', title: TITLE }, over);
  return { poster, registry, levels, threads, discord, channel, ticket, pool, dir };
}

const onlyThread = (channel) => { assert.equal(channel.threadsById.size, 1); return [...channel.threadsById.values()][0]; };

test('a sent level becomes a game in a thread started on the game it was made from', async (t) => {
  const { poster, registry, levels, threads, channel, ticket } = await setup(t);
  const r = await poster.submit({ ticket: ticket(), text: TWO_STEPS + '\n' });
  assert.equal(r.ok, true, JSON.stringify(r));
  const thread = onlyThread(channel);
  assert.equal(thread.name, 'Levels: ' + TITLE);
  assert.equal(channel.standalone, 0); // it was started on the game's message
  assert.equal(thread.sent.length, 1);
  const message = thread.sent[0];
  assert.equal(r.url, 'https://discord.com/channels/G/' + thread.id + '/' + message.id);
  assert.equal(message.payload.framed, true);
  assert.equal(message.payload.kind, 'level');
  assert.deepEqual(message.payload.where, { channelId: thread.id, parentId: 'chan' });
  const level = levels.get(message.payload.levelId);
  assert.equal(level.text, TWO_STEPS);
  assert.equal(level.authorId, 'u1');
  assert.equal(level.authorName, 'Ada');
  assert.equal(level.threadId, thread.id);
  assert.equal(level.messageId, message.id);
  assert.equal(threads.get('chan', 'sok'), thread.id);
  // the message is a game like any other
  await registry.press(message.id, 'right');
  assert.equal((await registry.press(message.id, 'right')).solvedLevel, 0);
});

test('later levels for the same game go to the same thread; one made inside a thread stays there', async (t) => {
  const { poster, discord, channel, ticket } = await setup(t);
  const first = await poster.submit({ ticket: ticket(), text: TWO_STEPS });
  const second = await poster.submit({ ticket: ticket({ uid: 'u2', gameId: 'another-game' }), text: '#######\n#p..*o#\n#######' });
  assert.equal(second.ok, true, JSON.stringify(second));
  const thread = onlyThread(channel);
  assert.equal(thread.sent.length, 2);
  const elsewhere = discord.makeThread(channel, 'some other thread');
  const third = await poster.submit({ ticket: ticket({ channelId: elsewhere.id }), text: '########\n#p...*o#\n########' });
  assert.equal(third.ok, true, JSON.stringify(third));
  assert.equal(elsewhere.sent.length, 1);
  assert.equal(thread.sent.length, 2);
  assert.notEqual(first.url, second.url);
});

test('if the thread has gone a new one is started, on its own when the game message has gone too', async (t) => {
  const { poster, threads, channel, ticket } = await setup(t);
  await poster.submit({ ticket: ticket(), text: TWO_STEPS });
  const old = onlyThread(channel);
  channel.threadsById.delete(old.id);
  channel.messagesById.delete('game1');
  const r = await poster.submit({ ticket: ticket(), text: '#######\n#p..*o#\n#######' });
  assert.equal(r.ok, true, JSON.stringify(r));
  const fresh = onlyThread(channel);
  assert.notEqual(fresh.id, old.id);
  assert.equal(channel.standalone, 1);
  assert.equal(threads.get('chan', 'sok'), fresh.id);
});

test('the same level sent again answers with the game it already has', async (t) => {
  const { poster, channel, ticket } = await setup(t);
  const first = await poster.submit({ ticket: ticket(), text: TWO_STEPS });
  const again = await poster.submit({ ticket: ticket({ uid: 'u2' }), text: TWO_STEPS.toUpperCase() + '  \n\n' });
  assert.equal(again.ok, true);
  assert.equal(again.url, first.url);
  assert.equal(onlyThread(channel).sent.length, 1);
});

test('what cannot be a level is refused, and nothing is posted or stored', async (t) => {
  const { poster, channel, ticket, dir } = await setup(t);
  const bad = await poster.submit({ ticket: ticket(), text: '#####\n#pxo#\n#####' });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /^that level does not compile: /);
  assert.match(bad.error, /x/i);
  const two = await poster.submit({ ticket: ticket(), text: TWO_STEPS + '\n\n' + TWO_STEPS });
  assert.equal(two.ok, false);
  assert.match(two.error, /one level at a time/);
  assert.equal(channel.threadsById.size, 0);
  assert.equal(fs.readdirSync(path.join(dir, 'levels')).length, 0);
});

test('a person can only send so many levels an hour', async (t) => {
  let clock = 0;
  const { poster, ticket } = await setup(t, { perHour: 2, now: () => clock });
  const level = (n) => '#'.repeat(n + 5) + '\n#p' + '.'.repeat(n) + '*o#\n' + '#'.repeat(n + 5);
  assert.equal((await poster.submit({ ticket: ticket(), text: level(1) })).ok, true);
  assert.equal((await poster.submit({ ticket: ticket(), text: 'not a level (' })).ok, false); // a refusal does not count
  assert.equal((await poster.submit({ ticket: ticket(), text: level(2) })).ok, true);
  const third = await poster.submit({ ticket: ticket(), text: level(3) });
  assert.equal(third.ok, false);
  assert.match(third.error, /2 levels in the last hour/);
  assert.equal((await poster.submit({ ticket: ticket({ uid: 'someone-else' }), text: level(3) })).ok, true);
  clock = 60 * 60 * 1000;
  assert.equal((await poster.submit({ ticket: ticket(), text: level(4) })).ok, true);
});

test('when the level store is full the level is refused', async (t) => {
  const { poster, channel, ticket } = await setup(t, { maxLevelBytes: 10 });
  const r = await poster.submit({ ticket: ticket(), text: TWO_STEPS });
  assert.equal(r.ok, false);
  assert.match(r.error, /no more levels can be stored/);
  assert.equal(channel.threadsById.size, 0);
});

test('the text to start editing from: a level as written, or a sent level as sent', async (t) => {
  const { poster, levels, ticket } = await setup(t);
  const fromGame = await poster.textFor({ gistId: 'sok', baseSourceHash: null, levelIndex: 0, title: TITLE });
  assert.deepEqual(fromGame, { title: TITLE, levelText: ['####..', '#.o#..', '#..###', '#@p..#', '#..*.#', '#..###', '####..'].join('\n') });
  const r = await poster.submit({ ticket: ticket(), text: TWO_STEPS });
  const id = r.url && levels.get(require('../levels').levelId('sok', TWO_STEPS)).id;
  assert.deepEqual(await poster.textFor({ gistId: 'sok', baseSourceHash: null, levelId: id, title: TITLE }), { title: TITLE, levelText: TWO_STEPS });
  assert.equal(await poster.textFor({ gistId: 'sok', baseSourceHash: null, levelId: 'bbbbbbbbbb', title: TITLE }), null);
});
