'use strict';
const crypto = require('node:crypto');

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

module.exports = { checkLevelText, levelId, splice };
