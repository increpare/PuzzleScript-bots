'use strict';
const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

// One store for all game source text, one file per distinct source, named by its hash.
// Both the gist fetcher and the game registry read and write here, so nothing is stored twice.
// Over the cap, the least recently used sources are deleted.
function createSourceStore({ dataDir, maxBytes = 99_000_000, now = Date.now }) {
  const dir = path.join(dataDir, 'sources');
  fs.mkdirSync(dir, { recursive: true });
  const fileFor = (hash) => path.join(dir, hash + '.txt');

  function enforceCap(keepHash) {
    const files = [];
    let total = 0;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.txt')) continue;
      try {
        const st = fs.statSync(path.join(dir, f));
        files.push({ f, size: st.size, mtime: st.mtimeMs });
        total += st.size;
      } catch (e) { /* raced with a delete */ }
    }
    files.sort((a, b) => a.mtime - b.mtime);
    for (const x of files) {
      if (total <= maxBytes) break;
      if (x.f === keepHash + '.txt') continue;
      try { fs.unlinkSync(path.join(dir, x.f)); total -= x.size; } catch (e) { /* already gone */ }
    }
  }

  function touch(hash) {
    const t = new Date(now());
    try { fs.utimesSync(fileFor(hash), t, t); } catch (e) { /* recency is best effort */ }
  }

  return {
    save(source) {
      const hash = sha256(source);
      if (fs.existsSync(fileFor(hash))) { touch(hash); return hash; }
      const tmp = fileFor(hash) + '.tmp';
      fs.writeFileSync(tmp, source);
      fs.renameSync(tmp, fileFor(hash));
      enforceCap(hash);
      return hash;
    },
    load(hash) {
      if (!/^[0-9a-f]{64}$/.test(String(hash))) return null;
      try {
        const source = fs.readFileSync(fileFor(hash), 'utf8');
        touch(hash);
        return source;
      } catch (e) { return null; }
    },
  };
}

module.exports = { createSourceStore, sha256 };
