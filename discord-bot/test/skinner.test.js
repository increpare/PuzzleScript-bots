'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { parseSet, loadPuzzles, dailyPuzzles, levelText, gameSource, announcement, HIS_PAGE, CREDITS_PAGE } = require('../skinner');
const { levelLayout } = require('../renderer');
const { createHost } = require('../engine-host');
const { SRC_DIR } = require('../engine-src');

const DEMO = fs.readFileSync(path.join(SRC_DIR, 'demo', 'microban.txt'), 'utf8');
const count = (text, re) => (text.match(re) || []).length;

test('a set is read as numbered puzzles, named after the set', () => {
  const puzzles = parseSet('Microban II', '; 1\n\n####\n#@$.#\n####\n\n; 2\n\n#####\n#@$.#\n#####\n');
  assert.deepEqual(puzzles, [
    { id: 'Microban II.1', set: 'Microban II', number: 1, name: null, rows: ['####', '#@$.#', '####'] },
    { id: 'Microban II.2', set: 'Microban II', number: 2, name: null, rows: ['#####', '#@$.#', '#####'] },
  ]);
});

test('a puzzle\'s name is read from its heading, or from the line under it', () => {
  const puzzles = parseSet('Microban II', "; 132 'The Mixer'\n\n###\n\n; 41\n'MS46 v2'\n\n###\n");
  assert.deepEqual(puzzles.map((p) => p.name), ['The Mixer', 'MS46 v2']);
  assert.deepEqual(puzzles.map((p) => p.rows), [['###'], ['###']]);
});

test('line endings from Windows are read as well', () => {
  assert.deepEqual(parseSet('Microban I', '; 1\r\n\r\n###\r\n#@#\r\n').map((p) => p.rows), [['###', '#@#']]);
});

test('anything that is not Sokoban is refused', () => {
  assert.throws(() => parseSet('Microban I', '; 1\n\n###\n#x#\n'), /Microban I\.1/);
  assert.throws(() => parseSet('Microban I', '###\n'), /before the first puzzle/);
});

test('a puzzle is written in the glyphs of the Microban demo, as a rectangle', () => {
  const [puzzle] = parseSet('Microban I', '; 1\n\n  ####\n###  #\n# $*.#\n# @ ##\n#####\n');
  assert.equal(levelText(puzzle), '..####\n###..#\n#.*@O#\n#.P.##\n#####.');
});

test('a player standing on a target has a glyph of its own', () => {
  const [puzzle] = parseSet('Microban I', '; 1\n\n#####\n#+$ #\n#####\n');
  assert.equal(levelText(puzzle), '#####\n#+*.#\n#####');
});

test('all fifteen sets are there, in order', () => {
  const puzzles = loadPuzzles();
  const sets = [];
  for (const p of puzzles) {
    const last = sets[sets.length - 1];
    if (last && last[0] === p.set) last[1]++; else sets.push([p.set, 1]);
  }
  assert.deepEqual(sets, [
    ['Microban I', 155], ['Microban II', 135], ['Microban III', 101], ['Microban IV', 102],
    ['Sasquatch I', 50], ['Sasquatch II', 50], ['Sasquatch III', 50], ['Sasquatch IV', 50],
    ['Sasquatch V', 50], ['Sasquatch VI', 50], ['Sasquatch VII', 50], ['Sasquatch VIII', 50],
    ['Sasquatch IX', 50], ['Sasquatch X', 50], ['Sasquatch XI', 50],
  ]);
  assert.equal(new Set(puzzles.map((p) => p.id)).size, 1043);
  puzzles.forEach((p, i) => assert.equal(p.number, i === 0 || puzzles[i - 1].set !== p.set ? 1 : puzzles[i - 1].number + 1, p.id));
});

test('every puzzle has one player and a crate for each target', () => {
  for (const p of loadPuzzles()) {
    const text = levelText(p);
    assert.equal(count(text, /[P+]/g), 1, p.id);
    assert.ok(count(text, /[*@]/g) > 0, p.id);
    assert.equal(count(text, /[*@]/g), count(text, /[O@+]/g), p.id);
  }
});

test('the first ten puzzles of Microban come out as the demo has them', () => {
  const demoLevels = DEMO.slice(DEMO.indexOf('LEVELS\n=======') + 14).split(/message[^\n]*\n/).map((s) => s.trim()).filter(Boolean);
  assert.equal(demoLevels.length, 10);
  const puzzles = loadPuzzles();
  demoLevels.forEach((level, i) => assert.equal(levelText(puzzles[i]), level.toUpperCase(), puzzles[i].id));
});

test('a puzzle\'s game is the Microban demo around that one level, with one glyph more', () => {
  const puzzle = loadPuzzles().find((p) => p.id === 'Microban II.3');
  const source = gameSource(puzzle);
  const demoBody = DEMO.slice(DEMO.indexOf('========\nOBJECTS'), DEMO.indexOf('=======\nLEVELS'));
  const body = source.slice(source.indexOf('========\nOBJECTS'), source.indexOf('=======\nLEVELS'));
  assert.equal(body, demoBody.replace('O = Target\n', 'O = Target\n+ = Player and Target\n'));
  assert.ok(source.endsWith('=======\nLEVELS\n=======\n\n' + levelText(puzzle) + '\n'));
});

test('a puzzle\'s game is credited to Skinner and says where his puzzles are', () => {
  const puzzles = loadPuzzles();
  const source = gameSource(puzzles.find((p) => p.id === 'Microban II.3'));
  const lines = source.split('\n');
  assert.equal(lines[0], 'title Microban II.3');
  assert.equal(lines[1], 'author David W. Skinner');
  // play.html makes every homepage an https link, and his page has no https; ours has, and links to his
  assert.equal(lines[2], 'homepage ' + CREDITS_PAGE);
  assert.match(CREDITS_PAGE, /^https:\/\//);
  assert.equal(HIS_PAGE, 'http://www.abelmartin.com/rj/sokobanJS/Skinner/David%20W.%20Skinner%20-%20Sokoban.htm');
  const prelude = source.slice(0, source.indexOf('========\nOBJECTS'));
  assert.ok(prelude.includes('Puzzle 3 of the set Microban II, by David W. Skinner.'));
  assert.ok(prelude.includes(HIS_PAGE));
  assert.ok(gameSource(puzzles.find((p) => p.id === 'Microban II.132')).includes('He called it "The Mixer".'));
});

test('the games compile and start on their level', () => {
  const puzzles = loadPuzzles();
  const withPlayerOnTarget = puzzles.find((p) => p.rows.some((r) => r.includes('+')));
  const biggest = puzzles.reduce((a, b) => (levelText(b).length > levelText(a).length ? b : a));
  const host = createHost();
  for (const p of [puzzles[0], withPlayerOnTarget, biggest, puzzles[puzzles.length - 1]]) {
    const meta = host.load(gameSource(p), 'seed', 0);
    assert.equal(meta.title, p.id);
    assert.equal(meta.author, 'David W. Skinner');
    assert.deepEqual(meta.realLevels, [0]);
    const snapshot = host.snapshot();
    assert.equal(snapshot.kind, 'level');
    assert.equal(snapshot.height, p.rows.length, p.id);
  }
});

test('the day\'s puzzle is announced by name, with his page and the game in a browser', () => {
  const puzzles = loadPuzzles();
  assert.equal(announcement(puzzles.find((p) => p.id === 'Microban II.3'), 'abc123'),
    '**Skinner of the Day: Microban II.3**\n'
    + 'A Sokoban puzzle by [David W. Skinner](<' + HIS_PAGE + '>). Play it here, or [in a browser](<https://www.puzzlescript.net/play.html?p=abc123>).');
  assert.ok(announcement(puzzles.find((p) => p.id === 'Microban II.132'), 'abc123')
    .startsWith('**Skinner of the Day: Microban II.132, "The Mixer"**\n'));
});

test('the puzzles of the day leave out those too big to be drawn at more than 5 px a cell', () => {
  const all = loadPuzzles();
  const daily = dailyPuzzles();
  assert.equal(daily.length, 1024);
  const left = all.filter((p) => !daily.includes(p));
  assert.equal(left.length, 19);
  assert.ok(left.some((p) => p.id === 'Microban IV.102')); // 49 by 44
  assert.ok(daily.some((p) => p.id === 'Microban II.3'));
  // as the bot draws them: a sprite is 5 px across, so a scale of 1 is 5 px a cell
  const host = createHost();
  const scale = (p) => { host.load(gameSource(p), 'seed', 0); return levelLayout(host.snapshot()).scale; };
  for (const p of left) assert.equal(scale(p), 1, p.id);
  const biggestKept = daily.reduce((a, b) => (levelText(b).length > levelText(a).length ? b : a));
  assert.ok(scale(biggestKept) >= 2, biggestKept.id);
  const widest = daily.reduce((a, b) => (levelText(b).indexOf('\n') > levelText(a).indexOf('\n') ? b : a));
  const tallest = daily.reduce((a, b) => (b.rows.length > a.rows.length ? b : a));
  assert.ok(scale(widest) >= 2, widest.id);
  assert.ok(scale(tallest) >= 2, tallest.id);
});
