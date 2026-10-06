'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { buildComponents, buildEmbed, parseCustomId } = require('../presentation');

const meta = (flags) => ({ title: 'T', author: 'A', levelCount: 3, flags: Object.assign({ noaction: false, noundo: false, norestart: false, realtime: false }, flags) });
const ids = (rows) => rows.map((r) => r.toJSON().components.map((c) => c.custom_id));

test('level frames get movement and control rows', () => {
  const rows = buildComponents({ kind: 'level' }, meta({}));
  assert.deepEqual(ids(rows), [['ps:left', 'ps:up', 'ps:down', 'ps:right', 'ps:action'], ['ps:undo', 'ps:restart']]);
});

test('flags remove buttons', () => {
  assert.deepEqual(ids(buildComponents({ kind: 'level' }, meta({ noaction: true }))), [['ps:left', 'ps:up', 'ps:down', 'ps:right'], ['ps:undo', 'ps:restart']]);
  assert.deepEqual(ids(buildComponents({ kind: 'level' }, meta({ noundo: true, norestart: true }))), [['ps:left', 'ps:up', 'ps:down', 'ps:right', 'ps:action']]);
});

test('message frames get a continue button; finished gets none', () => {
  assert.deepEqual(ids(buildComponents({ kind: 'message' }, meta({}))), [['ps:continue']]);
  assert.deepEqual(ids(buildComponents({ kind: 'finished' }, meta({}))), []);
});

test('embed carries title, author, level footer and attachment image', () => {
  const record = { meta: meta({}), status: 'playing' };
  const e = buildEmbed({ record, snapshot: { kind: 'level', levelIndex: 1, levelCount: 3 }, attachmentName: 'frame.png' }).toJSON();
  assert.equal(e.title, 'T');
  assert.equal(e.description, 'by A');
  assert.equal(e.footer.text, 'Level 2 of 3');
  assert.equal(e.image.url, 'attachment://frame.png');
  const dead = buildEmbed({ record: { meta: meta({}), status: 'dead', deadReason: 'timeout' }, snapshot: { kind: 'level', levelIndex: 0, levelCount: 3 }, attachmentName: 'f.png' }).toJSON();
  assert.equal(dead.footer.text, 'stopped: timeout');
});

test('overlong titles are truncated to 256 characters', () => {
  const record = { meta: Object.assign(meta({}), { title: 'x'.repeat(300) }), status: 'playing' };
  const e = buildEmbed({ record, snapshot: { kind: 'level', levelIndex: 0, levelCount: 3 }, attachmentName: null }).toJSON();
  assert.equal(e.title.length, 256);
});

test('embed title links to game play page when gistId is provided', () => {
  const record = { meta: meta({}), status: 'playing', gistId: '6841219' };
  const e = buildEmbed({ record, snapshot: { kind: 'level', levelIndex: 0, levelCount: 3 }, attachmentName: 'f.png' }).toJSON();
  assert.equal(e.url, 'https://www.puzzlescript.net/play.html?p=6841219');
});

test('embed has no url when gistId is not provided', () => {
  const record = { meta: meta({}), status: 'playing' };
  const e = buildEmbed({ record, snapshot: { kind: 'level', levelIndex: 0, levelCount: 3 }, attachmentName: 'f.png' }).toJSON();
  assert.equal(e.url, undefined);
});

test('custom ids parse', () => {
  assert.equal(parseCustomId('ps:up'), 'up');
  assert.equal(parseCustomId('ps:nope'), null);
  assert.equal(parseCustomId('other'), null);
});
