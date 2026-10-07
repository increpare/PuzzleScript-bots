'use strict';
const fs = require('node:fs');
const path = require('node:path');

// Which thread holds the sent levels of which game, in which channel. One small file.
function createThreadIndex({ dataDir }) {
  const file = path.join(dataDir, 'threads.json');
  fs.mkdirSync(dataDir, { recursive: true });
  let index = {};
  try {
    const read = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (read && typeof read === 'object' && !Array.isArray(read)) index = read;
  } catch (e) { index = {}; }
  const key = (channelId, gistId) => channelId + ':' + gistId;

  return {
    get(channelId, gistId) {
      const id = index[key(channelId, gistId)];
      return typeof id === 'string' ? id : null;
    },
    set(channelId, gistId, threadId) {
      index[key(channelId, gistId)] = String(threadId);
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(index));
      fs.renameSync(tmp, file);
    },
  };
}

module.exports = { createThreadIndex };
