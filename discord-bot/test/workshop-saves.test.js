'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createWorkshopSaves } = require('../workshop-saves');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'psbot-saves-'));
const entry = (title, text) => ({ title, text, date: 'whatever the browser says' });

test('the room starts with no saves', () => {
  const saves = createWorkshopSaves({ dataDir: tmp() });
  assert.deepEqual(saves.get(), { saves: [], autosaves: [], rev: 0 });
});

test('a save is added to its list, dated by the bot, and the revision moves on', () => {
  const saves = createWorkshopSaves({ dataDir: tmp(), now: () => Date.UTC(2026, 9, 7, 12, 0, 0) });
  const after = saves.add('saves', entry('My Game', 'title My Game'));
  assert.deepEqual(after, { saves: [{ title: 'My Game', text: 'title My Game', date: '2026-10-07T12:00:00.000Z' }], autosaves: [], rev: 1 });
  saves.add('autosaves', entry('My Game', 'title My Game\n'));
  const all = saves.get();
  assert.equal(all.saves.length, 1);
  assert.equal(all.autosaves.length, 1);
  assert.equal(all.rev, 2);
});

test('saving what was saved last changes nothing', () => {
  const saves = createWorkshopSaves({ dataDir: tmp() });
  saves.add('saves', entry('A', 'same'));
  const again = saves.add('saves', entry('A renamed', 'same'));
  assert.equal(again.saves.length, 1);
  assert.equal(again.rev, 1);
  // but it is not the last autosave, so it is kept there
  assert.equal(saves.add('autosaves', entry('A', 'same')).autosaves.length, 1);
});

test('each list keeps only its newest entries', () => {
  const saves = createWorkshopSaves({ dataDir: tmp(), maxEntries: 3 });
  for (let i = 1; i <= 5; i++) saves.add('saves', entry('G' + i, 'text ' + i));
  assert.deepEqual(saves.get().saves.map((s) => s.title), ['G3', 'G4', 'G5']);
});

test('over the size limit the oldest go first: autosaves, then saves, never the one just made', () => {
  const big = (c) => c.repeat(400);
  // each entry is a little under 470 bytes as stored: two fit in 1300, three do not
  const saves = createWorkshopSaves({ dataDir: tmp(), maxBytes: 1300 });
  saves.add('autosaves', entry('auto1', big('a')));
  saves.add('saves', entry('save1', big('b')));
  saves.add('saves', entry('save2', big('c')));
  let all = saves.get();
  assert.deepEqual(all.autosaves.map((s) => s.title), []);            // the autosave went first
  assert.deepEqual(all.saves.map((s) => s.title), ['save1', 'save2']);
  saves.add('saves', entry('save3', big('d')));
  saves.add('saves', entry('save4', big('e')));
  all = saves.get();
  assert.deepEqual(all.saves.map((s) => s.title), ['save3', 'save4']);
  assert.ok(Buffer.byteLength(JSON.stringify({ saves: all.saves, autosaves: all.autosaves })) <= 1300);
  // one that could never fit is refused, and nothing is lost for it
  assert.throws(() => saves.add('saves', entry('huge', big('f').repeat(5))), (e) => e.name === 'WorkshopError' && /too big/.test(e.message));
  assert.deepEqual(saves.get().saves.map((s) => s.title), ['save3', 'save4']);
});

test('what is not a save is refused', () => {
  const saves = createWorkshopSaves({ dataDir: tmp() });
  const bad = (group, e) => assert.throws(() => saves.add(group, e), (err) => err.name === 'WorkshopError');
  bad('other', entry('A', 'text'));
  bad('saves', null);
  bad('saves', { title: 'A' });
  bad('saves', { title: 7, text: 'x' });
  bad('saves', { title: 'A', text: '' });
  bad('saves', { title: 'A', text: 'x'.repeat(1_000_001) });
  assert.equal(saves.add('saves', { title: 'x'.repeat(500), text: 'ok' }).saves[0].title.length, 200);
  assert.equal(saves.get().rev, 1);
});

test('saves are still there after a restart, and a corrupt file is set aside', () => {
  const dir = tmp();
  createWorkshopSaves({ dataDir: dir }).add('saves', entry('Kept', 'title Kept'));
  const again = createWorkshopSaves({ dataDir: dir });
  assert.deepEqual(again.get().saves.map((s) => s.title), ['Kept']);
  assert.equal(again.get().rev, 0); // revisions only matter to editors that are open, and none are after a restart
  fs.writeFileSync(path.join(dir, 'workshop', 'saves.json'), 'not json');
  const fresh = createWorkshopSaves({ dataDir: dir, log: () => {} });
  assert.deepEqual(fresh.get().saves, []);
  assert.equal(fs.readdirSync(path.join(dir, 'workshop')).some((f) => f.startsWith('saves.json.corrupt-')), true);
});
