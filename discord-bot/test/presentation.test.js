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

test('the footer only suggests what the game allows, and says nothing while a message is up', () => {
  const footer = (animating, flags, kind = 'level') => buildEmbed({ record: { meta: meta(flags), status: 'playing' }, snapshot: { kind, levelNumber: 1, realLevelCount: 3, animating }, attachmentName: 'f.gif' }).toJSON().footer.text;
  assert.equal(footer('loop', { noundo: true }), 'Level 1 of 3 · looping: restart');
  assert.equal(footer('loop', { norestart: true }), 'Level 1 of 3 · looping: undo');
  assert.equal(footer('loop', { noundo: true, norestart: true }), 'Level 1 of 3 · looping, and this game has no undo or restart');
  assert.equal(footer('more', { noundo: true }), 'Level 1 of 3 · still animating: continue or restart');
  assert.equal(footer('more', { noundo: true, norestart: true }), 'Level 1 of 3 · still animating: continue');
  assert.equal(footer('loop', {}, 'message'), 'Level 1 of 3', 'the only button on a message is continue, and it only dismisses the message');
  assert.equal(footer('more', {}, 'message'), 'Level 1 of 3');
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

test('the tweak button joins the control row of a level, only when asked for', () => {
  const moves = ['ps:left', 'ps:up', 'ps:down', 'ps:right', 'ps:action'];
  assert.deepEqual(ids(buildComponents({ kind: 'level' }, meta({}), { tweak: true })), [moves, ['ps:undo', 'ps:restart', 'ps:tweak']]);
  assert.deepEqual(ids(buildComponents({ kind: 'level' }, meta({ noundo: true, norestart: true }), { tweak: true })), [moves, ['ps:tweak']]);
  assert.deepEqual(ids(buildComponents({ kind: 'level' }, meta({}), { tweak: false })), [moves, ['ps:undo', 'ps:restart']]);
  assert.deepEqual(ids(buildComponents({ kind: 'message' }, meta({}), { tweak: true })), [['ps:continue']]);
  assert.deepEqual(ids(buildComponents({ kind: 'level', animating: 'loop' }, meta({}), { tweak: true })), [['ps:undo', 'ps:restart']]);
  assert.equal(parseCustomId('ps:tweak'), 'tweak');
});

// ---- sent levels ----
const { levelFile } = require('../presentation');

const sentLevel = (over = {}) => Object.assign({ id: 'aaaaaaaaaa', text: '###\n#p#\n###', authorName: 'Ada', solvedBy: [] }, over);
const playing = { meta: meta({}), status: 'playing', levelId: 'aaaaaaaaaa' };

test('a sent level is titled with its author and shows its text', () => {
  const e = buildEmbed({ record: playing, snapshot: { kind: 'level', levelIndex: 0, levelCount: 1 }, attachmentName: 'frame.png', level: sentLevel() }).toJSON();
  assert.equal(e.title, 'T — level by Ada');
  assert.equal(e.description, '```\n###\n#p#\n###\n```');
  assert.equal(e.footer.text, 'Custom level');
  const moved = buildEmbed({ record: Object.assign({}, playing, { lastMover: 'Bob' }), snapshot: { kind: 'level', levelIndex: 0, levelCount: 1 }, attachmentName: 'frame.png', level: sentLevel() }).toJSON();
  assert.equal(moved.footer.text, 'Custom level (Last move: Bob)');
});

test('an author name is shown as text, whatever is in it', () => {
  const e = buildEmbed({ record: playing, snapshot: { kind: 'level', levelIndex: 0, levelCount: 1 }, attachmentName: null, level: sentLevel({ authorName: '**big** `x`' }) }).toJSON();
  assert.equal(e.title, 'T — level by \\*\\*big\\*\\* \\`x\\`');
});

test('a level too long for the embed, or with a code fence in it, is attached instead', () => {
  const long = sentLevel({ text: Array(20).fill('#'.repeat(60)).join('\n') });
  assert.equal(buildEmbed({ record: playing, snapshot: { kind: 'level', levelIndex: 0, levelCount: 1 }, attachmentName: null, level: long }).toJSON().description, 'Level text attached.');
  assert.deepEqual(levelFile(long), { name: 'level.txt', data: Buffer.from(long.text + '\n') });
  const fenced = sentLevel({ text: '```\n#p#\n###' });
  assert.equal(buildEmbed({ record: playing, snapshot: { kind: 'level', levelIndex: 0, levelCount: 1 }, attachmentName: null, level: fenced }).toJSON().description, 'Level text attached.');
  assert.ok(levelFile(fenced));
  assert.equal(levelFile(sentLevel()), null);
});

test('a solved level lists who solved it', () => {
  const done = { meta: meta({}), status: 'finished', levelId: 'aaaaaaaaaa' };
  const footer = (names) => buildEmbed({ record: done, snapshot: { kind: 'finished', levelIndex: 0, levelCount: 1 }, attachmentName: null, level: sentLevel({ solvedBy: names.map((name, i) => ({ id: String(i), name })) }) }).toJSON().footer.text;
  assert.equal(footer([]), 'Solved');
  assert.equal(footer(['Ada']), 'Solved by Ada');
  assert.equal(footer(['Ada', 'Bob']), 'Solved by Ada and Bob');
  assert.equal(footer(['Ada', 'Bob', 'Cy']), 'Solved by Ada, Bob and Cy');
  const many = Array.from({ length: 13 }, (_, i) => 'P' + i);
  assert.equal(footer(many), 'Solved by P0, P1, P2, P3, P4, P5, P6, P7, P8, P9 and 3 more');
  const dead = buildEmbed({ record: { meta: meta({}), status: 'dead', deadReason: 'x', levelId: 'aaaaaaaaaa' }, snapshot: { kind: 'level', levelIndex: 0, levelCount: 1 }, attachmentName: null, level: sentLevel() }).toJSON();
  assert.equal(dead.footer.text, 'stopped: x');
});

test('a solved level offers playing again, and the pencil where it is allowed; a finished normal game offers nothing', () => {
  assert.deepEqual(ids(buildComponents({ kind: 'finished' }, meta({}), { again: true })), [['ps:again']]);
  assert.deepEqual(ids(buildComponents({ kind: 'finished' }, meta({}), { again: true, tweak: true })), [['ps:again', 'ps:tweak']]);
  assert.deepEqual(ids(buildComponents({ kind: 'finished' }, meta({}), { tweak: true })), []);
  assert.deepEqual(ids(buildComponents({ kind: 'level' }, meta({}), { again: true })), [['ps:left', 'ps:up', 'ps:down', 'ps:right', 'ps:action'], ['ps:undo', 'ps:restart']]);
  assert.equal(parseCustomId('ps:again'), 'again');
});

// ---- the workshop ----
const { workshopDoor, WORKSHOP_BUTTON } = require('../presentation');

test('the workshop\'s door is a message with one button, which is not a game button', () => {
  const door = workshopDoor();
  assert.match(door.content, /PuzzleScript workshop/);
  const buttons = door.components.map((r) => r.toJSON().components).flat();
  assert.equal(buttons.length, 1);
  assert.equal(buttons[0].custom_id, WORKSHOP_BUTTON);
  assert.equal(buttons[0].label, 'Open the workshop');
  assert.equal(parseCustomId(WORKSHOP_BUTTON), null);
});
