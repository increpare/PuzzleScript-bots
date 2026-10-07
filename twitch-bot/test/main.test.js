'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../main');

async function logsFor(indexText) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'twitch-main-'));
  if (indexText !== null) fs.writeFileSync(path.join(dir, 'music-index.json'), indexText);
  const logs = [];
  const app = createApp({ cfg: { dataDir: dir, output: path.join(dir, 'out.flv'), minFps: 1 }, gallery: [{ gistId: 'aaaa', title: 'Sokoban', author: 'test' }], getSource: async () => '', log: (m) => logs.push(String(m)) });
  try { return logs; } finally { await app.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
}

test('a missing music index, and one with no tracks, are both reported', async () => {
  for (const text of [null, JSON.stringify({ root: '/music', tracks: [] })]) {
    assert.ok((await logsFor(text)).some((l) => l.startsWith('no music index')), String(text));
  }
});

test('a music index with tracks is not reported', async () => {
  const text = JSON.stringify({ root: '/music', tracks: [{ path: 'a/1.mp3', album: 'A', title: 'One', seconds: 60 }] });
  assert.deepEqual(await logsFor(text), []);
});
