'use strict';
const crypto = require('node:crypto');
const { WorkshopError } = require('./workshop-doc');

// Colours that read on the editor's dark and light themes alike.
const COLORS = ['#e6194b', '#3cb44b', '#4363d8', '#f58231', '#911eb4', '#008080', '#c2185b', '#9a6324', '#00897b', '#5c6bc0', '#d81b60', '#6d8b00'];

// Who has the workshop open, and where each one's cursor is. This is kept in memory only: it is
// about the moment, and nobody is there after a restart.
//
// An entry is one open editor (a person with two windows has two), and is forgotten if that editor
// has not been heard from for ttlMs. Editors say where they are every few seconds, changed or not.
function createPresence({ now = Date.now, ttlMs = 15000, max = 64 } = {}) {
  const entries = new Map(); // editor id -> { uid, name, anchor, head, seen }; a Map keeps arrival order
  let rev = 0;

  // A person has one colour, worked out from their id, so it is the same every time they come in.
  const colorOf = (uid) => COLORS[crypto.createHash('sha256').update(String(uid)).digest()[0] % COLORS.length];
  const position = (v) => v === null || (Number.isInteger(v) && v >= 0);

  return {
    colorOf,
    rev: () => rev,
    // anchor and head are positions in the document: where the selection starts and where the
    // cursor is. Both null means the editor is open but the cursor is not in the code.
    set(id, { uid, name, anchor, head }) {
      if (typeof id !== 'string' || id === '' || id.length > 100) throw new WorkshopError('bad editor id');
      if (!position(anchor) || !position(head) || (anchor === null) !== (head === null)) throw new WorkshopError('bad cursor');
      const was = entries.get(id);
      if (!was && entries.size >= max) throw new WorkshopError('the workshop is full');
      const shown = String(name || '').slice(0, 80) || 'someone';
      entries.set(id, { uid: String(uid), name: shown, anchor, head, seen: now() });
      if (!was || was.name !== shown || was.anchor !== anchor || was.head !== head) rev++;
    },
    // An editor saying it is closing. Only its own user can take it out. True if it was there.
    remove(id, uid) {
      const e = entries.get(id);
      if (!e || e.uid !== String(uid)) return false;
      entries.delete(id);
      rev++;
      return true;
    },
    // Forgets editors that have gone quiet. True if any had.
    sweep() {
      let gone = false;
      for (const [id, e] of entries) {
        if (now() - e.seen >= ttlMs) { entries.delete(id); gone = true; }
      }
      if (gone) rev++;
      return gone;
    },
    // What the pages are given: no user ids, only what is shown.
    list: () => [...entries].map(([id, e]) => ({ id, name: e.name, color: colorOf(e.uid), anchor: e.anchor, head: e.head })),
  };
}

module.exports = { createPresence };
