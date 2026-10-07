'use strict';
const fs = require('node:fs');
const path = require('node:path');

function shuffled(items, random) {
  const a = items.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    const t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a;
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return null; }
}

function writeJson(file, value) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value));
  fs.renameSync(tmp, file);
}

// Which gallery game is next, and how far chat got in each one.
function createRotation({ gallery, dataDir, random = Math.random }) {
  if (!gallery.length) throw new Error('the gallery is empty');
  fs.mkdirSync(dataDir, { recursive: true });
  const stateFile = path.join(dataDir, 'state.json');
  const progressFile = path.join(dataDir, 'progress.json');
  const byId = new Map(gallery.map((g) => [g.gistId, g]));
  const fresh = () => ({ order: shuffled([...byId.keys()], random), pos: 0 });

  let state = readJson(stateFile);
  const usable = state && Array.isArray(state.order) && state.order.length === byId.size
    && new Set(state.order).size === byId.size && state.order.every((id) => byId.has(id))
    && Number.isInteger(state.pos) && state.pos >= 0 && state.pos < state.order.length;
  if (!usable) { state = fresh(); writeJson(stateFile, state); }

  const loaded = readJson(progressFile);
  const progress = loaded && typeof loaded === 'object' && !Array.isArray(loaded) ? loaded : {};

  return {
    current: () => byId.get(state.order[state.pos]),
    advance() {
      state.pos++;
      if (state.pos >= state.order.length) state = fresh();
      writeJson(stateFile, state);
      return byId.get(state.order[state.pos]);
    },
    savedLevel: (gistId) => (Number.isInteger(progress[gistId]) && progress[gistId] > 0 ? progress[gistId] : 0),
    saveLevel(gistId, levelIndex) { progress[gistId] = levelIndex; writeJson(progressFile, progress); },
    clearLevel(gistId) {
      if (!(gistId in progress)) return;
      delete progress[gistId];
      writeJson(progressFile, progress);
    },
  };
}

module.exports = { createRotation, shuffled };
