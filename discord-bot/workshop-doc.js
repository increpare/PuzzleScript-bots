'use strict';
const fs = require('node:fs');
const path = require('node:path');
// The editor's own @codemirror/state, built for node (see scripts/build-workshop-runtime.sh), so
// that the bot applies a change exactly as every editor does.
const { ChangeSet, Text } = require('./vendor/codemirror-state.cjs');

class WorkshopError extends Error {}
WorkshopError.prototype.name = 'WorkshopError';

// The workshop's one document, and the bot's part in editing it together.
//
// This is the "central authority" of @codemirror/collab. Each editor sends its changes with the
// version they were made against. If that is the version the bot is at, they are applied and
// numbered; if not, the editor is turned away, fetches what it missed, rebases, and tries again.
// So there is one agreed order of changes, and every editor that has applied the same number of
// them has the same document.
//
// keep: how many recent changes are remembered. An editor further behind than that (or from before
//   a restart, since the list is kept in memory) is told to start again from the document.
// pollMs: how long a pull waits for news before answering with none.
function createWorkshopDoc({
  dataDir, maxLength = 1_000_000, keep = 5000, pollMs = 25_000, saveDelayMs = 2000,
  setTimer = setTimeout, clearTimer = clearTimeout, log = console.error,
}) {
  const dir = path.join(dataDir, 'workshop');
  const file = path.join(dir, 'doc.json');
  fs.mkdirSync(dir, { recursive: true });

  let doc = Text.empty;
  let version = 0;       // how many changes have ever been applied
  let updates = [];      // the most recent of them: updates[i] is change number firstKept + i
  let firstKept = 0;
  const waiters = new Set();
  let saveTimer = null;
  let closed = false;

  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (typeof saved.doc !== 'string' || !Number.isInteger(saved.version) || saved.version < 0) throw new Error('not a saved document');
    doc = Text.of(saved.doc.split('\n'));
    version = firstKept = saved.version;
  } catch (e) {
    if (e.code !== 'ENOENT') {
      // People's work may be in there. Keep it for a person to look at, and start empty.
      const aside = file + '.corrupt-' + Date.now();
      try { fs.renameSync(file, aside); } catch (e2) { /* nothing more can be done */ }
      log('the saved workshop document could not be read and was set aside as', aside, e.message);
    }
  }

  function save() {
    if (saveTimer !== null) { clearTimer(saveTimer); saveTimer = null; }
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ doc: doc.toString(), version }));
    fs.renameSync(tmp, file);
  }
  function saveSoon() {
    if (saveTimer === null) saveTimer = setTimer(() => { saveTimer = null; save(); }, saveDelayMs);
  }

  const since = (clientVersion) => updates.slice(clientVersion - firstKept);

  // clientVersion: the version the changes were made against.
  // list: [{ clientID, changes }], changes being a CodeMirror ChangeSet as JSON.
  function push(clientVersion, list) {
    if (!Number.isInteger(clientVersion)) throw new WorkshopError('bad version');
    if (!Array.isArray(list) || list.length === 0 || list.length > 500) throw new WorkshopError('bad updates');
    if (clientVersion !== version) return { accepted: false };
    // all or nothing: nothing is kept unless every change applies
    let next = doc;
    const accepted = [];
    for (const u of list) {
      if (!u || typeof u.clientID !== 'string' || u.clientID.length > 100) throw new WorkshopError('bad update');
      try {
        next = ChangeSet.fromJSON(u.changes).apply(next);
      } catch (e) {
        throw new WorkshopError('a change does not fit the document');
      }
      accepted.push({ clientID: u.clientID, changes: u.changes });
    }
    if (next.length > maxLength) throw new WorkshopError('the document would be too long');
    doc = next;
    version += accepted.length;
    updates = updates.concat(accepted);
    if (updates.length > keep) {
      firstKept += updates.length - keep;
      updates = updates.slice(-keep);
    }
    saveSoon();
    for (const w of [...waiters]) w.answer({ updates: since(w.version) });
    return { accepted: true };
  }

  // { promise, cancel }: the changes after clientVersion, waiting for some if there are none yet.
  // cancel is for when whoever asked has gone.
  function pull(clientVersion) {
    if (!Number.isInteger(clientVersion) || clientVersion > version || clientVersion < firstKept) {
      return { promise: Promise.resolve({ reset: true }), cancel() {} };
    }
    if (clientVersion < version || closed) return { promise: Promise.resolve({ updates: since(clientVersion) }), cancel() {} };
    let waiter;
    const promise = new Promise((resolve) => {
      waiter = {
        version: clientVersion,
        timer: setTimer(() => waiter.answer({ updates: [] }), pollMs),
        answer(result) {
          waiters.delete(waiter);
          clearTimer(waiter.timer);
          resolve(result);
        },
      };
      waiters.add(waiter);
    });
    return { promise, cancel: () => waiter.answer({ updates: [] }) };
  }

  return {
    state: () => ({ doc: doc.toString(), version }),
    push,
    pull,
    waiting: () => waiters.size,
    close() {
      closed = true;
      for (const w of [...waiters]) w.answer({ updates: [] });
      if (saveTimer !== null) save();
    },
  };
}

module.exports = { createWorkshopDoc, WorkshopError };
