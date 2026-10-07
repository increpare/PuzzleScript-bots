'use strict';

const INPUTS = new Map([
  ['up', 'up'], ['u', 'up'],
  ['down', 'down'], ['d', 'down'],
  ['left', 'left'], ['l', 'left'],
  ['right', 'right'], ['r', 'right'],
  ['action', 'action'], ['a', 'action'], ['x', 'action'],
  ['undo', 'undo'], ['z', 'undo'],
  ['restart', 'restart'], // no single letter: it wipes the level
]);

// The whole message must be a command, so ordinary chat never moves the player.
function parseCommand(text) {
  const t = String(text === undefined || text === null ? '' : text).trim().toLowerCase();
  if (t === '!skip') return { type: 'skip' };
  const word = t.startsWith('!') ? t.slice(1) : t;
  return INPUTS.has(word) ? { type: 'input', action: INPUTS.get(word) } : null;
}

module.exports = { parseCommand };
