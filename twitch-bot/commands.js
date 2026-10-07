'use strict';

const INPUTS = new Map([
  ['up', 'up'], ['u', 'up'],
  ['down', 'down'], ['d', 'down'],
  ['left', 'left'], ['l', 'left'],
  ['right', 'right'], ['r', 'right'],
  ['action', 'action'], ['a', 'action'], ['x', 'action'],
  ['undo', 'undo'], ['z', 'undo'],
  ['restart', 'restart'], // no single letter: it wipes the level
  ['go', 'continue'], // gets past a message screen, and does nothing anywhere else
]);

// Third-party chat clients append invisible characters (zero-width and other format characters, and
// the tag characters at U+E0000) so that a viewer can send the same message twice in a row.
const INVISIBLE = /[\p{Cf}\u{E0000}-\u{E007F}]/gu;

// The whole message must be a command, so ordinary chat never moves the player.
function parseCommand(text) {
  const t = String(text === undefined || text === null ? '' : text).replace(INVISIBLE, '').trim().toLowerCase();
  if (t === '!skip') return { type: 'skip' };
  const word = t.startsWith('!') ? t.slice(1) : t;
  return INPUTS.has(word) ? { type: 'input', action: INPUTS.get(word) } : null;
}

module.exports = { parseCommand };
