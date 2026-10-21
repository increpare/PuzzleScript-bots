'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { MessageFlags } = require('discord.js');
const { createPool } = require('../pool');
const { createRegistry } = require('../games');
const { SRC_DIR } = require('../engine-src');
const { playAgain } = require('../play-again');

function interaction() {
  const calls = [];
  return {
    channelId: 'channel', message: { id: 'old' }, calls,
    async reply(payload) { calls.push(['reply', payload]); },
    async deferReply() { calls.push(['defer']); },
    async fetchReply() { return { id: 'new', url: 'https://discord.com/channels/guild/channel/new' }; },
    async editReply(payload) { calls.push(['edit', payload]); },
    async followUp(payload) { calls.push(['follow', payload]); },
  };
}

test('replay posts only a new game from the beginning', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'psbot-replay-'));
  const source = fs.readFileSync(path.join(SRC_DIR, 'demo', 'sokoban_basic.txt'), 'utf8');
  const pool = createPool({ size: 1 });
  const registry = createRegistry({ dataDir: dir, pool, getSource: async () => source });
  t.after(async () => { await registry.close(); await pool.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const { record } = await registry.start({ gameId: 'old', channelId: 'channel', gistId: 'sok', startLevelNumber: 2 });
  record.status = 'finished';
  record.lastMover = 'Ada';
  record.inputs.push('right');
  const original = structuredClone(record);
  const press = interaction();
  await playAgain(press, { registry, frame: (rec, snapshot) => ({ id: rec.gameId, kind: snapshot.kind }) });
  const fresh = registry.get('new');
  assert.equal(fresh.channelId, 'channel');
  assert.equal(fresh.gistId, 'sok');
  assert.equal(fresh.seed, 'new');
  assert.equal(fresh.startLevel, 0);
  assert.deepEqual(fresh.inputs, []);
  assert.equal(fresh.status, 'playing');
  assert.equal(fresh.lastMover, undefined);
  assert.deepEqual(registry.get('old'), original);
  assert.deepEqual(press.calls, [['defer'], ['edit', { id: 'new', kind: 'level' }]]);
});

test('unavailable, playing and sent-level games do not create a replay', async () => {
  for (const record of [null, { status: 'playing' }, { status: 'finished', levelId: 'sent' }]) {
    const press = interaction();
    await playAgain(press, { registry: { get: () => record }, frame: () => assert.fail('must not render') });
    assert.equal(press.calls.length, 1);
    assert.equal(press.calls[0][0], 'reply');
    assert.equal(press.calls[0][1].flags, MessageFlags.Ephemeral);
  }
});

test('a start failure is reported on the new response', async () => {
  const press = interaction();
  await playAgain(press, {
    registry: {
      get: () => ({ status: 'finished', gistId: 'sok' }),
      async start() { throw Object.assign(new Error('bad rule'), { name: 'CompileError' }); },
    },
    frame: () => assert.fail('must not render'),
  });
  assert.deepEqual(press.calls, [['defer'], ['edit', { content: 'that game does not compile: bad rule' }]]);
});

test('a changed gist that is now realtime is refused as with /play', async () => {
  const press = interaction();
  let stopped;
  await playAgain(press, {
    registry: {
      get: () => ({ status: 'finished', gistId: 'sok' }),
      async start() { return { record: { gameId: 'new', meta: { flags: { realtime: true } } } }; },
      markDead(id, why) { stopped = [id, why]; },
    },
    frame: () => assert.fail('must not render'),
  });
  assert.deepEqual(stopped, ['new', 'realtime game']);
  assert.match(press.calls[1][1].content, /realtime games cannot be played here/);
  assert.equal(press.calls.length, 2);
});
