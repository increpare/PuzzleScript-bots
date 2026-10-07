'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ChangeSet } = require('../vendor/codemirror-state.cjs');
const { createWorkshopDoc } = require('../workshop-doc');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'psbot-workshop-'));
// an update as a client sends it: who made it, and the change as CodeMirror serialises it
const update = (clientID, length, spec) => ({ clientID, changes: ChangeSet.of(spec, length).toJSON() });

// timers the test fires by hand
function fakeTimers() {
  const pending = new Set();
  return {
    set: (fn) => { const t = { fn }; pending.add(t); return t; },
    clear: (t) => { pending.delete(t); },
    fire() { const all = [...pending]; pending.clear(); for (const t of all) t.fn(); },
    count: () => pending.size,
  };
}

function make(over = {}) {
  const timers = fakeTimers();
  const doc = createWorkshopDoc(Object.assign({ dataDir: tmp(), setTimer: timers.set, clearTimer: timers.clear }, over));
  return { doc, timers };
}

test('a new workshop is empty, at version 0', () => {
  const { doc } = make();
  assert.deepEqual(doc.state(), { doc: '', version: 0 });
});

test('pushed changes are applied in order and the version counts them', () => {
  const { doc } = make();
  assert.deepEqual(doc.push(0, [update('a', 0, { from: 0, insert: 'title One' })]), { accepted: true });
  assert.deepEqual(doc.push(1, [update('a', 9, { from: 9, insert: '\nauthor Me' }), update('a', 19, { from: 6, to: 9, insert: 'Two' })]), { accepted: true });
  assert.deepEqual(doc.state(), { doc: 'title Two\nauthor Me', version: 3 });
});

test('a push made against an older version is turned away, and changes nothing', () => {
  const { doc } = make();
  doc.push(0, [update('a', 0, { from: 0, insert: 'abc' })]);
  assert.deepEqual(doc.push(0, [update('b', 0, { from: 0, insert: 'xyz' })]), { accepted: false });
  assert.deepEqual(doc.state(), { doc: 'abc', version: 1 });
});

test('a push that is not a list of well-formed changes for this document is refused whole', () => {
  const { doc } = make();
  doc.push(0, [update('a', 0, { from: 0, insert: 'abc' })]);
  const bad = (updates) => assert.throws(() => doc.push(1, updates), (e) => e.name === 'WorkshopError');
  bad('nope');
  bad([]);
  bad([{ clientID: 'a' }]);
  bad([{ clientID: 7, changes: [3] }]);
  bad([{ clientID: 'a', changes: 'x' }]);
  bad([update('a', 99, { from: 0, insert: 'for a longer document' })]);
  // the first is fine and the second is not: neither is applied
  bad([update('a', 3, { from: 3, insert: 'd' }), update('a', 99, { from: 0, insert: 'z' })]);
  bad(Array.from({ length: 501 }, () => update('a', 3, [])));
  assert.throws(() => doc.push('1', [update('a', 3, { from: 3, insert: 'd' })]), (e) => e.name === 'WorkshopError');
  assert.deepEqual(doc.state(), { doc: 'abc', version: 1 });
});

test('the document cannot grow past its limit', () => {
  const { doc } = make({ maxLength: 10 });
  doc.push(0, [update('a', 0, { from: 0, insert: '12345678' })]);
  assert.throws(() => doc.push(1, [update('a', 8, { from: 8, insert: 'abc' })]), (e) => e.name === 'WorkshopError' && /too long/.test(e.message));
  assert.deepEqual(doc.push(1, [update('a', 8, { from: 8, insert: 'ab' })]), { accepted: true });
});

test('pull hands over what a client has missed straight away', async () => {
  const { doc } = make();
  const u1 = update('a', 0, { from: 0, insert: 'abc' });
  const u2 = update('b', 3, { from: 3, insert: 'd' });
  doc.push(0, [u1]);
  doc.push(1, [u2]);
  assert.deepEqual(await doc.pull(0).promise, { updates: [u1, u2] });
  assert.deepEqual(await doc.pull(1).promise, { updates: [u2] });
});

test('pull waits when a client is up to date, until something is pushed or the wait runs out', async () => {
  const { doc, timers } = make();
  let got = null;
  doc.pull(0).promise.then((r) => { got = r; });
  await new Promise((r) => setImmediate(r));
  assert.equal(got, null);
  const u1 = update('a', 0, { from: 0, insert: 'abc' });
  doc.push(0, [u1]);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(got, { updates: [u1] });

  let idle = null;
  doc.pull(1).promise.then((r) => { idle = r; });
  await new Promise((r) => setImmediate(r));
  assert.equal(idle, null);
  timers.fire();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(idle, { updates: [] });
});

test('a pull that is given up on is forgotten', async () => {
  const { doc } = make();
  const waiting = doc.pull(0);
  assert.equal(doc.waiting(), 1);
  waiting.cancel();
  assert.equal(doc.waiting(), 0);
  doc.push(0, [update('a', 0, { from: 0, insert: 'abc' })]);
});

test('a client from the future, or too far behind, is told to start again', async () => {
  const { doc } = make({ keep: 2 });
  doc.push(0, [update('a', 0, { from: 0, insert: 'a' })]);
  doc.push(1, [update('a', 1, { from: 1, insert: 'b' })]);
  doc.push(2, [update('a', 2, { from: 2, insert: 'c' })]);
  assert.deepEqual(await doc.pull(9).promise, { reset: true });
  assert.deepEqual(await doc.pull(0).promise, { reset: true }); // only the last two updates are kept
  assert.equal((await doc.pull(1).promise).updates.length, 2);
  assert.deepEqual(await doc.pull(-1).promise, { reset: true });
  assert.deepEqual(await doc.pull('x').promise, { reset: true });
});

test('the document is saved a moment after a change, and found again by a new bot', async () => {
  const dir = tmp();
  const timers = fakeTimers();
  const doc = createWorkshopDoc({ dataDir: dir, setTimer: timers.set, clearTimer: timers.clear });
  doc.push(0, [update('a', 0, { from: 0, insert: 'title Kept\n\nOBJECTS' })]);
  assert.equal(fs.existsSync(path.join(dir, 'workshop', 'doc.json')), false);
  timers.fire();
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'workshop', 'doc.json'), 'utf8')), { doc: 'title Kept\n\nOBJECTS', version: 1 });

  const again = createWorkshopDoc({ dataDir: dir, setTimer: timers.set, clearTimer: timers.clear });
  assert.deepEqual(again.state(), { doc: 'title Kept\n\nOBJECTS', version: 1 });
  // the versions carry on, and a client from before the restart starts again
  assert.deepEqual(again.push(1, [update('b', 19, { from: 19, insert: '\n' })]), { accepted: true });
  assert.deepEqual(await again.pull(0).promise, { reset: true });
  assert.equal((await again.pull(1).promise).updates.length, 1);
});

test('closing saves at once and lets go of anyone waiting', async () => {
  const dir = tmp();
  const timers = fakeTimers();
  const doc = createWorkshopDoc({ dataDir: dir, setTimer: timers.set, clearTimer: timers.clear });
  doc.push(0, [update('a', 0, { from: 0, insert: 'abc' })]);
  let idle = null;
  doc.pull(1).promise.then((r) => { idle = r; });
  doc.close();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(idle, { updates: [] });
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'workshop', 'doc.json'), 'utf8')).doc, 'abc');
  assert.equal(timers.count(), 0);
});

test('a corrupt saved document is set aside, not loaded and not overwritten', () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, 'workshop'));
  fs.writeFileSync(path.join(dir, 'workshop', 'doc.json'), '{ not json');
  const timers = fakeTimers();
  const doc = createWorkshopDoc({ dataDir: dir, setTimer: timers.set, clearTimer: timers.clear, log: () => {} });
  assert.deepEqual(doc.state(), { doc: '', version: 0 });
  assert.equal(fs.readdirSync(path.join(dir, 'workshop')).some((f) => f.startsWith('doc.json.corrupt-')), true);
});
