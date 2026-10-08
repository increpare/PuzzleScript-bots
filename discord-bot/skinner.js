'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { levelLayout } = require('./renderer');

// David W. Skinner's Sokoban puzzles: the Microban and Sasquatch sets, as he published them, in
// skinner/sets/. Each puzzle becomes a PuzzleScript game of one level: the Microban demo of
// PuzzleScript around it (skinner/game.txt), so that a level reads the same in both.
const HIS_PAGE = 'http://www.abelmartin.com/rj/sokobanJS/Skinner/David%20W.%20Skinner%20-%20Sokoban.htm';
// play.html makes a game's homepage an https link whatever the game says, and his page is not
// served over https. So the games name a page of the bot's own (skinner/skinner.html, published
// with the bot), which credits him and links to his.
const CREDITS_PAGE = 'https://games.increpare.com/puzzlescriptbot/skinner.html';
const AUTHOR = 'David W. Skinner';
const SETS_DIR = path.join(__dirname, 'skinner', 'sets');

// Sokoban's glyphs to the demo's. The player on a target is the one thing the demo has no glyph
// for; it keeps Sokoban's.
const GLYPHS = { ' ': '.', '#': '#', '@': 'P', '$': '*', '.': 'O', '*': '@', '+': '+' };
const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII', 'XIII', 'XIV', 'XV'];

// A set is a text file: "; 12" or "; 12 'Its Name'" heads each puzzle, and its rows follow.
function parseSet(set, text) {
  const puzzles = [];
  let cur = null;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '');
    const heading = /^; *(\d+)(?: +'(.*)')?$/.exec(line);
    if (heading) {
      cur = { id: set + '.' + Number(heading[1]), set, number: Number(heading[1]), name: heading[2] || null, rows: [] };
      puzzles.push(cur);
      continue;
    }
    if (line === '') continue;
    if (!cur) throw new Error(set + ': a line before the first puzzle: ' + line);
    // one puzzle has its name on a line of its own
    const name = /^'(.*)'$/.exec(line);
    if (name && cur.rows.length === 0) { cur.name = name[1]; continue; }
    if (/[^ #@$.*+]/.test(line)) throw new Error(cur.id + ': not a row of Sokoban: ' + line);
    cur.rows.push(line);
  }
  return puzzles;
}

// "Microban.txt" is the first Microban set and "Microban II.txt" the second.
function setOfFile(file) {
  const m = /^(\S+)(?: ([IVX]+))?\.txt$/.exec(file);
  if (!m || (m[2] && !ROMAN.includes(m[2]))) throw new Error('not a set of puzzles: ' + file);
  return { family: m[1], volume: m[2] ? ROMAN.indexOf(m[2]) : 0 };
}

let cached = null;

function loadPuzzles(dir = SETS_DIR) {
  if (cached && cached.dir === dir) return cached.puzzles;
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.txt')).map((file) => ({ file, ...setOfFile(file) }));
  files.sort((a, b) => (a.family < b.family ? -1 : a.family > b.family ? 1 : a.volume - b.volume));
  const puzzles = [];
  for (const f of files) puzzles.push(...parseSet(f.family + ' ' + ROMAN[f.volume], fs.readFileSync(path.join(dir, f.file), 'utf8')));
  cached = { dir, puzzles };
  return puzzles;
}

// The puzzles the Skinner of the Day is picked from: all but those so big that the bot's frame can
// only draw them at 5 px a cell (a sprite at its own size), which is too small to play from.
function dailyPuzzles(dir = SETS_DIR) {
  return loadPuzzles(dir).filter((p) => {
    const viewport = { w: Math.max(...p.rows.map((r) => r.length)), h: p.rows.length };
    return levelLayout({ viewport }).scale > 1;
  });
}

function levelText(puzzle) {
  const width = Math.max(...puzzle.rows.map((r) => r.length));
  return puzzle.rows.map((r) => r.padEnd(width, ' ').replace(/./g, (c) => GLYPHS[c])).join('\n');
}

let template = null;

function gameSource(puzzle) {
  if (template === null) template = fs.readFileSync(path.join(__dirname, 'skinner', 'game.txt'), 'utf8');
  return [
    'title ' + puzzle.id,
    'author ' + AUTHOR,
    'homepage ' + CREDITS_PAGE,
    '',
    '(Puzzle ' + puzzle.number + ' of the set ' + puzzle.set + ', by ' + AUTHOR + '.' + (puzzle.name ? ' He called it "' + puzzle.name + '".' : ''),
    '',
    'His sets "may be freely distributed provided they remain properly credited".',
    'They are at ' + HIS_PAGE,
    '',
    "The game around the puzzle is increpare's PuzzleScript Microban demo.)",
    '',
    template + '=======\nLEVELS\n=======\n',
    levelText(puzzle),
    '',
  ].join('\n');
}

// What the bot says above the day's game. The links are in <> so that Discord draws no preview of them.
function announcement(puzzle, gistId) {
  const name = puzzle.id + (puzzle.name ? ', "' + puzzle.name + '"' : '');
  return '**Skinner of the Day: ' + name + '**\n'
    + 'A Sokoban puzzle by [' + AUTHOR + '](<' + HIS_PAGE + '>). Play it here, or [in a browser](<https://www.puzzlescript.net/play.html?p=' + gistId + '>).';
}

module.exports = { parseSet, loadPuzzles, dailyPuzzles, levelText, gameSource, announcement, HIS_PAGE, CREDITS_PAGE };
