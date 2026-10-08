'use strict';
const crypto = require('node:crypto');
const { WorkshopError } = require('./workshop-doc');
const { createPresence } = require('./workshop-presence');
const { ChangeSet } = require('./vendor/codemirror-state.cjs');

// Ephemeral pointers into the current document. User ids stay on the server; the browser gets a
// fresh signal id and a relative lifetime so its clock need not agree with the bot's.
function createSignals({ now = Date.now, ttlMs = 5000, max = 64, colorOf = createPresence().colorOf } = {}) {
  const entries = new Map();
  const recent = new Map();
  function publicSignal({ id, name, color, pos, created, clientId }, time) {
    return { id, name, color, pos, remainingMs: ttlMs - (time - created), ...(clientId === undefined ? {} : { clientId }) };
  }
  function sweep(time) {
    for (const [uid, signal] of entries) if (time - signal.created >= ttlMs) entries.delete(uid);
    for (const [uid, emitted] of recent) if (time - emitted >= 500) recent.delete(uid);
  }
  return {
    add({ uid, name, pos, clientId }) {
      if (typeof uid !== 'string' || !uid || uid.length > 100) throw new WorkshopError('bad signal user');
      if (typeof name !== 'string') throw new WorkshopError('bad signal name');
      if (!Number.isInteger(pos) || pos < 0) throw new WorkshopError('bad signal position');
      if (clientId !== undefined && (typeof clientId !== 'string' || !/^[a-f0-9-]{36}$/.test(clientId))) throw new WorkshopError('bad signal request id');
      const time = now();
      sweep(time);
      if (recent.has(uid)) {
        const error = new WorkshopError('wait a moment before signalling again');
        error.status = 429;
        throw error;
      }
      if (!entries.has(uid) && entries.size >= max) throw new WorkshopError('too many workshop signals');
      const signal = { id: crypto.randomBytes(16).toString('base64url'), name: name.slice(0, 80) || 'someone', color: colorOf(uid), pos, created: time, clientId };
      entries.set(uid, signal);
      recent.set(uid, time);
      return publicSignal(signal, time);
    },
    list() {
      const time = now();
      sweep(time);
      return [...entries.values()].map((signal) => publicSignal(signal, time));
    },
    map(changes) {
      const change = changes instanceof ChangeSet ? changes : ChangeSet.fromJSON(changes);
      sweep(now());
      for (const signal of entries.values()) signal.pos = change.mapPos(signal.pos, 1);
    },
  };
}

module.exports = { createSignals };
