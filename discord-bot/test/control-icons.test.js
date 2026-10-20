'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { syncControlIcons } = require('../control-icons');
const { setControlEmojis, buildComponents } = require('../presentation');

const actions = ['left', 'up', 'down', 'right', 'action', 'undo', 'restart', 'continue', 'moves', 'tweak', 'again', 'replay'];

function discord() {
  const stored = [];
  let fail = false;
  return {
    stored,
    failNext() { fail = true; },
    async get(route) {
      assert.equal(route, '/applications/app/emojis');
      return { items: stored };
    },
    async post(route, { body }) {
      assert.equal(route, '/applications/app/emojis');
      if (fail) { fail = false; throw new Error('upload interrupted'); }
      assert.match(body.name, /^ps_[a-z]+_[a-f0-9]{12}$/);
      assert.match(body.image, /^data:image\/png;base64,/);
      const png = Buffer.from(body.image.split(',')[1], 'base64');
      assert.equal(png.toString('hex', 0, 8), '89504e470d0a1a0a');
      assert.equal(png.readUInt32BE(16), 128);
      assert.equal(png.readUInt32BE(20), 128);
      const emoji = { id: String(100000000000000000n + BigInt(stored.length)), name: body.name, animated: false };
      stored.push(emoji);
      return emoji;
    },
  };
}

test('startup uploads approved icons once and reuses them on every later startup', async () => {
  const rest = discord();
  const icons = await syncControlIcons(rest, 'app');
  assert.deepEqual(Object.keys(icons).sort(), actions.slice().sort());
  assert.equal(rest.stored.length, 12);
  assert.deepEqual(await syncControlIcons(rest, 'app'), icons);
  assert.equal(rest.stored.length, 12);
});

test('a retry reuses completed uploads after a partial failure and retains older versions', async () => {
  const rest = discord();
  const post = rest.post;
  let count = 0;
  rest.stored.push({ id: '123456789012345678', name: 'ps_action_oldversion', animated: false });
  rest.post = async (...args) => {
    if (++count === 4) rest.failNext();
    return post(...args);
  };
  await assert.rejects(syncControlIcons(rest, 'app'), /upload interrupted/);
  const completed = rest.stored.slice();
  const icons = await syncControlIcons(rest, 'app');
  assert.equal(rest.stored.length, 13);
  for (const emoji of completed) assert(rest.stored.includes(emoji));
  assert.equal(new Set(Object.values(icons).map(e => e.id)).size, 12);
});

test('all game states use the configured custom icons and the new game label', async () => {
  const icons = await syncControlIcons(discord(), 'app');
  setControlEmojis(icons);
  const meta = { flags: {} };
  const states = [
    [{ kind: 'level' }, { tweak: true }],
    [{ kind: 'level', animating: 'more' }, {}],
    [{ kind: 'message' }, {}],
    [{ kind: 'finished' }, {}],
    [{ kind: 'finished' }, { again: true, tweak: true }],
  ];
  const seen = new Set();
  for (const [snapshot, options] of states) {
    for (const row of buildComponents(snapshot, meta, options)) {
      for (const button of row.toJSON().components) {
        const action = button.custom_id.slice(3);
        seen.add(action);
        assert.equal(button.emoji.id, icons[action].id);
        assert.equal(button.emoji.name, icons[action].name);
        if (action === 'replay') assert.equal(button.label, 'New game');
      }
    }
  }
  assert.equal(seen.size, 12);
  assert.throws(() => setControlEmojis({}), /missing control emoji/i);
});
