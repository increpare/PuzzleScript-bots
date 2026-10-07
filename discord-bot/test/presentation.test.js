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

test('footer names the last person who moved', () => {
  const record = { meta: meta({}), status: 'playing', lastMover: 'increpare' };
  const e = buildEmbed({ record, snapshot: { kind: 'level', levelIndex: 1, levelCount: 3 }, attachmentName: 'f.png' }).toJSON();
  assert.equal(e.footer.text, 'Level 2 of 3 (Last move: increpare)');
});

test('footer uses level numbers that leave out message screens', () => {
  const record = { meta: meta({}), status: 'playing' };
  const e = buildEmbed({ record, snapshot: { kind: 'level', levelIndex: 28, levelCount: 35, levelNumber: 15, realLevelCount: 18 }, attachmentName: 'f.png' }).toJSON();
  assert.equal(e.footer.text, 'Level 15 of 18');
});

test('while an animation loops, only undo and restart are offered', () => {
  const rows = buildComponents({ kind: 'level', animating: 'loop' }, meta({}));
  assert.deepEqual(ids(rows), [['ps:undo', 'ps:restart']]);
  assert.deepEqual(ids(buildComponents({ kind: 'level', animating: 'loop' }, meta({ noundo: true }))), [['ps:restart']]);
  assert.deepEqual(ids(buildComponents({ kind: 'level', animating: 'loop' }, meta({ noundo: true, norestart: true }))), []);
});

test('a paused long animation can be continued, undone or restarted', () => {
  const rows = buildComponents({ kind: 'level', animating: 'more' }, meta({}));
  assert.deepEqual(ids(rows), [['ps:continue', 'ps:undo', 'ps:restart']]);
});

test('the footer says why the move buttons are gone', () => {
  const record = { meta: meta({}), status: 'playing', lastMover: 'increpare' };
  const footer = (animating) => buildEmbed({ record, snapshot: { kind: 'level', levelNumber: 1, realLevelCount: 3, animating }, attachmentName: 'f.gif' }).toJSON().footer.text;
  assert.equal(footer(null), 'Level 1 of 3 (Last move: increpare)');
  assert.equal(footer('loop'), 'Level 1 of 3 (Last move: increpare) · looping: undo or restart');
  assert.equal(footer('more'), 'Level 1 of 3 (Last move: increpare) · still animating: continue, undo or restart');
});

test('errors are worded for the player, and a move that took too long reads as refused', () => {
  const { userMessage } = require('../presentation');
  const named = (name, message) => Object.assign(new Error(message || name), { name });
  assert.equal(userMessage(named('MoveTooLongError')), 'that move took too long, so it was not made');
  assert.equal(userMessage(named('TimeoutError')), 'that move took too long, so it was not made');
  assert.equal(userMessage(named('TimeoutError'), 'start'), 'that game took too long to start');
  assert.equal(userMessage(named('CompileError', 'no player')), 'that game does not compile: no player');
  assert.equal(userMessage(named('EvictedError')), 'the game was paused by the server, press again');
  assert.equal(userMessage(named('LevelRangeError', 'that game only has 3 levels')), 'that game only has 3 levels');
  assert.equal(userMessage(named('CompileError', 'x'.repeat(5000))).length, 1900);
});
