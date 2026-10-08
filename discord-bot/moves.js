'use strict';

// Moves typed as letters, the way the Twitch stream's chat types them. Restart has no letter: it
// wipes the level.
const LETTERS = { u: 'up', d: 'down', l: 'left', r: 'right', x: 'action', z: 'undo' };
// The most moves one line may hold. They are shown as one animation, a move every 150 ms at the
// usual pace, and Discord cuts an animation short past a length it does not publish: fifty moves
// keep it to some eight seconds.
const MAX_MOVES = 50;

const refuse = (error) => ({ ok: false, error });

// flags: the game's own (see engine-host load). A letter the game has no button for is refused
// before anything is played, so that a line is never half made for that reason.
function parseMoves(text, flags) {
  const letters = String(text === undefined || text === null ? '' : text).toLowerCase().replace(/[\s,]/g, '');
  if (letters === '') return refuse('type some moves: u d l r, x for action, z for undo');
  const actions = [];
  for (const ch of letters) {
    const action = Object.prototype.hasOwnProperty.call(LETTERS, ch) ? LETTERS[ch] : null;
    if (action === null) return refuse('"' + ch + '" is not a move. The moves are u d l r, x for action and z for undo');
    if (action === 'action' && flags && flags.noaction) return refuse('this game has no action button, so x cannot be played');
    if (action === 'undo' && flags && flags.noundo) return refuse('this game has no undo, so z cannot be played');
    actions.push(action);
  }
  if (actions.length > MAX_MOVES) return refuse('that is ' + actions.length + ' moves; ' + MAX_MOVES + ' is the most at once');
  return { ok: true, actions };
}

module.exports = { parseMoves, MAX_MOVES };
