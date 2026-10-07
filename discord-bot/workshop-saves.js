'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { WorkshopError } = require('./workshop-doc');

const GROUPS = ['saves', 'autosaves'];

// The workshop's save list: what the editor's SAVE button and Load dropdown show. The editor keeps
// two lists, the saves people make and the autosaves it makes itself every ten minutes; here both
// belong to the room, not to anyone's browser.
//
// Limits: each list keeps its newest maxEntries (the editor's own limit is about twenty), and the
// two together stay under maxBytes. Over that, the oldest autosaves go first, then the oldest saves.
function createWorkshopSaves({ dataDir, maxEntries = 20, maxBytes = 5_000_000, now = Date.now, log = console.error }) {
  const dir = path.join(dataDir, 'workshop');
  const file = path.join(dir, 'saves.json');
  fs.mkdirSync(dir, { recursive: true });

  let lists = { saves: [], autosaves: [] };
  // Counts changes since the bot started, so that an open editor can tell its copy is out of date.
  let rev = 0;

  const isEntry = (e) => e && typeof e.title === 'string' && typeof e.text === 'string' && typeof e.date === 'string';
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const g of GROUPS) {
      if (!Array.isArray(saved[g]) || !saved[g].every(isEntry)) throw new Error('not a save list');
    }
    lists = { saves: saved.saves, autosaves: saved.autosaves };
  } catch (e) {
    if (e.code !== 'ENOENT') {
      // People's work may be in there. Keep it for a person to look at, and start empty.
      const aside = file + '.corrupt-' + Date.now();
      try { fs.renameSync(file, aside); } catch (e2) { /* nothing more can be done */ }
      log('the workshop save list could not be read and was set aside as', aside, e.message);
    }
  }

  const size = (l) => Buffer.byteLength(JSON.stringify(l));
  const get = () => ({ saves: lists.saves, autosaves: lists.autosaves, rev });

  // group: 'saves' or 'autosaves'. entry: { title, text } as the editor made it.
  function add(group, entry) {
    if (!GROUPS.includes(group)) throw new WorkshopError('bad save group');
    if (!entry || typeof entry.title !== 'string' || typeof entry.text !== 'string' || entry.text === '' || entry.text.length > 1_000_000) {
      throw new WorkshopError('bad save');
    }
    const list = lists[group];
    // as in the editor: saving what was saved last is not a new save
    if (list.length && list[list.length - 1].text === entry.text) return get();
    // The bot's clock dates it, so that the list is in one order whatever the browsers' clocks say.
    const made = { title: entry.title.slice(0, 200), text: entry.text, date: new Date(now()).toISOString() };
    const next = { saves: lists.saves.slice(), autosaves: lists.autosaves.slice() };
    next[group] = next[group].concat(made).slice(-maxEntries);
    while (size(next) > maxBytes) {
      const from = next.autosaves.find((e) => e !== made) ? 'autosaves' : 'saves';
      const oldest = next[from].findIndex((e) => e !== made);
      if (oldest === -1) throw new WorkshopError('that game is too big to save here');
      next[from].splice(oldest, 1);
    }
    lists = next;
    rev++;
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(lists));
    fs.renameSync(tmp, file);
    return get();
  }

  return { get, add, rev: () => rev };
}

module.exports = { createWorkshopSaves };
