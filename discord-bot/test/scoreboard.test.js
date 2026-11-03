'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { MessageFlags } = require('discord.js');
const { createScores } = require('../scores');
const { showScoreboard } = require('../scoreboard');

function setup(t, playerCount = 4) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'psbot-scoreboard-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const scores = createScores({ dataDir: dir });
  for (let i = 1; i <= playerCount; i++) scores.credit(String(i), 'game', 1);
  const calls = [];
  let reply;
  const interaction = {
    user: { id: String(playerCount), globalName: 'Caller', username: 'caller' },
    member: { displayName: 'Caller nickname' },
    async deferReply() { calls.push('deferred'); },
    async editReply(payload) { calls.push('replied'); reply = payload; },
  };
  return { scores, interaction, calls, reply: () => reply, dir };
}

test('scoreboard resolves plain display names without links, at signs or mentions', async (t) => {
  const s = setup(t);
  const original = fs.readFileSync(path.join(s.dir, 'scores.json'), 'utf8');
  s.interaction.guild = { members: { async fetch({ user: id, force }) {
    assert.equal(s.calls[0], 'deferred');
    assert.equal(force, true);
    if (id === '1') return { displayName: 'Server nickname' };
    throw new Error('not in server');
  } } };
  await showScoreboard(s.interaction, {
    scores: s.scores,
    users: { async fetch(id, { force }) {
      assert.equal(s.calls[0], 'deferred');
      assert.equal(force, true);
      if (id === '2') return { globalName: 'Global name', username: 'account2' };
      if (id === '3') return { globalName: null, username: 'account3' };
      assert.fail('unnecessary lookup: ' + id);
    } },
  });
  const { content, allowedMentions, flags } = s.reply();
  for (const name of ['Server nickname', 'Global name', 'account3', 'Caller nickname']) assert.ok(content.includes(name));
  assert.doesNotMatch(content, /@|https?:\/\/|\]\(/);
  assert.deepEqual(allowedMentions, { parse: [] });
  assert.ok(flags & MessageFlags.SuppressEmbeds);
  assert.deepEqual(s.calls, ['deferred', 'replied']);
  assert.equal(fs.readFileSync(path.join(s.dir, 'scores.json'), 'utf8'), original);
});

test('only displayed players are fetched and an outside caller appears once', async (t) => {
  const s = setup(t, 12);
  for (let i = 1; i < 12; i++) s.scores.credit(String(i), 'game', 2);
  const lookedUp = [];
  await showScoreboard(s.interaction, {
    scores: s.scores,
    users: { async fetch(id) { lookedUp.push(id); return { username: 'player' + id }; } },
  });
  assert.equal(lookedUp.length, 10);
  assert.equal(new Set(lookedUp).size, 10);
  assert.equal((s.reply().content.match(/Caller nickname/g) || []).length, 1);
  assert.ok(s.reply().content.endsWith('\n⋮\n`12.` Caller nickname - 1 level (you)\n⋮'));
  assert.doesNotMatch(s.reply().content, /@|https?:\/\//);
});

test('unavailable account names use a distinct plain label', async (t) => {
  const s = setup(t, 2);
  s.interaction.member = null;
  await showScoreboard(s.interaction, { scores: s.scores, users: { async fetch() { throw new Error('unavailable'); } } });
  assert.ok(s.reply().content.includes('User 1 - 1 level! 🥇'));
  assert.ok(s.reply().content.includes('Caller - 1 level! 🥈 (you)'));
  assert.doesNotMatch(s.reply().content, /@|https?:\/\//);
});

test('empty scores and an unranked caller still produce plain replies', async (t) => {
  for (const count of [0, 2]) {
    const s = setup(t, count);
    s.interaction.user.id = '999';
    await showScoreboard(s.interaction, { scores: s.scores, users: { async fetch(id) { return { username: 'player' + id }; } } });
    assert.deepEqual(s.reply().allowedMentions, { parse: [] });
    assert.doesNotMatch(s.reply().content, /@|https?:\/\//);
    if (count === 0) {
      assert.equal(s.reply().content, '**Scoreboard**\nNo levels have been solved yet.');
      assert.equal(fs.existsSync(path.join(s.dir, 'scores.json')), false);
    } else assert.match(s.reply().content, /you are not ranked/);
  }
});
