'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const MAX_CHARS = 10_000;
const MAX_ROWS = 100;
const MAX_COLS = 100;

const refuse = (error) => ({ ok: false, error });

// A level as a player sends it has to be one rectangular block of rows, and nothing the engine's
// parser would read as something other than a row. Returns the tidied text, or why it was refused.
function checkLevelText(input) {
  if (typeof input !== 'string') return refuse('there is no level there');
  if (input.length > MAX_CHARS) return refuse('that level is too long');
  const rows = input.replace(/\r\n?/g, '\n').split('\n').map((r) => r.trim());
  while (rows.length && rows[0] === '') rows.shift();
  while (rows.length && rows[rows.length - 1] === '') rows.pop();
  if (rows.length === 0) return refuse('there is no level there');
  if (rows.some((r) => r === '')) return refuse('send one level at a time (there is a blank line in the middle)');
  // the parser starts a comment at a bracket, which would swallow the rest of the level
  if (rows.some((r) => /[()]/.test(r))) return refuse('a level cannot contain brackets');
  if (rows.some((r) => /^message/i.test(r))) return refuse('a level cannot contain a message');
  // the parser skips a row of nothing but = as decoration
  if (rows.some((r) => /^=+$/.test(r))) return refuse('a row made only of = signs would be read as a divider, not as part of the level');
  if (rows.length > MAX_ROWS || rows.some((r) => r.length > MAX_COLS)) return refuse('that level is too big (' + MAX_COLS + ' by ' + MAX_ROWS + ' at most)');
  if (rows.some((r) => r.length !== rows[0].length)) return refuse('every row of a level has to be the same length');
  return { ok: true, text: rows.join('\n') };
}

// The same level sent twice for the same game is one level. Legend glyphs do not care about case.
function levelId(gistId, text) {
  return crypto.createHash('sha256').update(String(gistId) + '\n' + String(text).toLowerCase()).digest('hex').slice(0, 10);
}

// The index of the line that is the LEVELS section header, or -1.
// The parser's rules that matter here: comments are ( ... ), nest, and run across lines; whatever
// follows the word "message" on a line is text, so a bracket there opens nothing; and the first
// line that is just a section name is that section's header.
function levelsHeaderLine(lines) {
  let depth = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let code = '';
    for (let j = 0; j < line.length; j++) {
      const ch = line[j];
      if (ch === '(') { depth++; continue; }
      if (ch === ')') { if (depth > 0) depth--; continue; }
      if (depth > 0) continue;
      code += ch;
      const endOfWord = j + 1 === line.length || /\s/.test(line[j + 1]);
      if (endOfWord && /(^|[\s\]])message$/i.test(code)) break;
    }
    if (code.trim().toLowerCase() === 'levels') return i;
  }
  return -1;
}

// A whole game whose LEVELS section is the one level given: the source up to and including the
// section header (and a row of = under it), then the level.
function splice(source, levelText) {
  const lines = String(source).split(/\r?\n/);
  const header = levelsHeaderLine(lines);
  if (header === -1) throw Object.assign(new Error('game has no LEVELS section'), { name: 'CompileError' });
  let end = header + 1;
  if (end < lines.length && /^\s*=+\s*$/.test(lines[end])) end++;
  return lines.slice(0, end).join('\n') + '\n\n' + levelText + '\n';
}

const MAX_SOLVERS = 50;

// Levels that players have sent: one file each. They are people's work, so nothing is ever deleted
// to make room; when the store is full, new levels are refused.
function createLevelStore({ dataDir, maxBytes = 5_000_000, now = Date.now }) {
  const dir = path.join(dataDir, 'levels');
  fs.mkdirSync(dir, { recursive: true });
  const fileFor = (id) => path.join(dir, id + '.json');
  const validId = (id) => /^[0-9a-f]{10}$/.test(String(id));

  let total = 0;
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    try { total += fs.statSync(path.join(dir, f)).size; } catch (e) { /* raced with nothing we do */ }
  }

  function get(id) {
    if (!validId(id)) return null;
    try { return JSON.parse(fs.readFileSync(fileFor(id), 'utf8')); } catch (e) { return null; }
  }

  // before: the size on disk of the record being replaced, 0 for a new one
  function write(rec, before) {
    const json = JSON.stringify(rec);
    const tmp = fileFor(rec.id) + '.tmp';
    fs.writeFileSync(tmp, json);
    fs.renameSync(tmp, fileFor(rec.id));
    total += Buffer.byteLength(json) - before;
    return rec;
  }

  function change(id, fn) {
    const rec = get(id);
    if (!rec) return null;
    const before = Buffer.byteLength(JSON.stringify(rec));
    fn(rec);
    return write(rec, before);
  }

  return {
    get,
    // The stored record: the one given, or the one already there under that id.
    add({ id, gistId, baseSourceHash, text, authorId, authorName }) {
      if (!validId(id)) throw new Error('bad level id');
      const existing = get(id);
      if (existing) return existing;
      const rec = {
        id, gistId, baseSourceHash, text,
        authorId: String(authorId), authorName: String(authorName || '').slice(0, 80),
        createdAt: now(), channelId: null, threadId: null, messageId: null, solvedBy: [],
      };
      if (total + Buffer.byteLength(JSON.stringify(rec)) > maxBytes) {
        throw Object.assign(new Error('the level store is full'), { name: 'LevelStoreFullError' });
      }
      return write(rec, 0);
    },
    setPost(id, { channelId, threadId, messageId }) {
      return change(id, (rec) => Object.assign(rec, { channelId, threadId, messageId }));
    },
    // A solver is listed once, however often they solve it.
    addSolver(id, { id: userId, name }) {
      return change(id, (rec) => {
        if (rec.solvedBy.length >= MAX_SOLVERS || rec.solvedBy.some((s) => s.id === String(userId))) return;
        rec.solvedBy.push({ id: String(userId), name: String(name || '').slice(0, 80) });
      });
    },
  };
}

module.exports = { checkLevelText, levelId, splice, createLevelStore };
