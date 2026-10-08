'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { OAuthError } = require('./discord-oauth');

// Only these are served. Anything else in the page directories is not for the browser.
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.txt': 'text/plain; charset=utf-8', // the editor's example games
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
};
const MAX_BODY = 64 * 1024;
// Loading a game into the workshop replaces the whole document in one change, so a change can be
// as big as a game, and JSON makes it a little bigger.
const MAX_PUSH_BODY = 2.5 * 1024 * 1024;
const SESSION_MS = 24 * 60 * 60 * 1000;

// no-cache: Discord's proxy and its clients hold on to files, and a deploy has to show at once.
function json(res, status, obj) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-cache' });
  res.end(JSON.stringify(obj));
}

// Reads a JSON object from the request. Rejects with {status} for a body that is too large or is not one.
// An oversize body is read to its end and thrown away, so that the client gets its answer.
function readJson(req, max = MAX_BODY) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size <= max) chunks.push(c);
    });
    req.on('error', () => reject({ status: 400 }));
    req.on('end', () => {
      if (size > max) return reject({ status: 413 });
      try {
        const v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!v || typeof v !== 'object' || Array.isArray(v)) return reject({ status: 400 });
        resolve(v);
      } catch (e) { reject({ status: 400 }); }
    });
  });
}

// The page of the level editor Activity and the api it talks to. It listens on localhost only;
// Caddy forwards one public path to it, and Discord's proxy reaches that path.
//
// staticDirs: where the page's files are. A file is looked for in each in turn.
// indexHtml: the front page as text, when it is put together by the bot (see workshop-page.js)
//   and is not a file.
// signer: signs and checks sessions (see signing.js).
// api: what the page can ask for once signed in.
//   tweak(uid)        → what that user is about to edit, or null
//   submit(uid, body) → the outcome of sending a level
// workshop: the shared document (see workshop-doc.js), when there is a workshop.
// workshopSaves: the room's save list (see workshop-saves.js).
// workshopShare(uid): shares the room's game and answers with the outcome, when sharing is set up.
// workshopPresence: who is in the room and where their cursors are (see workshop-presence.js).
// devSession: hand a session to anyone who asks, without Discord. This is for working on the page
//   on one's own machine and must never be on where the server can be reached by others.
function createHttpServer({ staticDirs, indexHtml = null, oauth, signer, api, workshop = null, workshopSaves = null, workshopShare = null, workshopPresence = null, devSession = false, log = console.error }) {
  const roots = staticDirs.map((d) => path.resolve(d));

  // Who is signed in ({ uid, name }), from the session the token exchange handed the page; null
  // without one. The name is the one Discord gave for them when they signed in.
  function sessionOf(req) {
    const m = /^Bearer (\S+)$/.exec(req.headers.authorization || '');
    const session = m ? signer.verify(m[1]) : null;
    return session && typeof session.uid === 'string' ? session : null;
  }
  const sessionUser = (req) => { const s = sessionOf(req); return s ? s.uid : null; };

  // Cursors move many times a second. Everyone waiting is told at most a few times a second.
  let presenceTimer = null;
  function tellOfPresenceSoon() {
    if (presenceTimer === null) presenceTimer = setTimeout(() => { presenceTimer = null; workshop.nudge(); }, 200);
  }

  function serveStatic(pathname, res, headOnly) {
    let rel;
    try { rel = decodeURIComponent(pathname); } catch (e) { return json(res, 404, { error: 'not found' }); }
    if (rel === '/' && indexHtml !== null) {
      const body = Buffer.from(indexHtml);
      res.writeHead(200, { 'content-type': TYPES['.html'], 'content-length': body.length, 'cache-control': 'no-cache' });
      return res.end(headOnly ? undefined : body);
    }
    if (rel.endsWith('/')) rel += 'index.html';
    const type = TYPES[path.extname(rel)];
    if (rel.includes('\0') || !type) return json(res, 404, { error: 'not found' });
    // the first directory that has the file serves it
    const tryRoot = (i) => {
      if (i === roots.length) return json(res, 404, { error: 'not found' });
      const file = path.resolve(roots[i], '.' + rel);
      if (!file.startsWith(roots[i] + path.sep)) return json(res, 404, { error: 'not found' });
      fs.stat(file, (err, st) => {
        if (err || !st.isFile()) return tryRoot(i + 1);
        res.writeHead(200, { 'content-type': type, 'content-length': st.size, 'cache-control': 'no-cache' });
        if (headOnly) return res.end();
        fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
      });
    };
    tryRoot(0);
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;
    if (devSession && p === '/api/dev-session' && req.method === 'GET') {
      const made = 'dev-' + crypto.randomBytes(4).toString('hex');
      return json(res, 200, { session: signer.sign({ uid: made, name: made }, SESSION_MS) });
    }
    if (workshop && (p === '/api/workshop' || p.startsWith('/api/workshop/'))) {
      const who = sessionOf(req);
      if (who === null) return json(res, 401, { error: 'sign in again' });
      const uid = who.uid;
      if (workshopPresence && p === '/api/workshop/presence' && req.method === 'POST') {
        const body = await readJson(req);
        try {
          const before = workshopPresence.rev();
          workshopPresence.set(body.id, { uid, name: who.name, anchor: body.anchor, head: body.head });
          if (workshopPresence.rev() !== before) tellOfPresenceSoon();
          return json(res, 200, { ok: true });
        } catch (e) {
          if (e.name !== 'WorkshopError') throw e;
          return json(res, 400, { error: e.message });
        }
      }
      if (workshopPresence && p === '/api/workshop/leave' && req.method === 'POST') {
        // sent as the page closes, so that the others do not see a cursor with nobody behind it
        const body = await readJson(req);
        if (workshopPresence.remove(body.id, uid)) tellOfPresenceSoon();
        return json(res, 200, { ok: true });
      }
      // canShare tells the page whether to offer its Share button
      if (p === '/api/workshop' && req.method === 'GET') return json(res, 200, Object.assign({ canShare: workshopShare !== null }, workshop.state()));
      if (workshopShare && p === '/api/workshop/share' && req.method === 'POST') return json(res, 200, await workshopShare(uid));
      if (p === '/api/workshop/push' && req.method === 'POST') {
        const body = await readJson(req, MAX_PUSH_BODY);
        try {
          return json(res, 200, workshop.push(body.version, body.updates));
        } catch (e) {
          if (e.name !== 'WorkshopError') throw e;
          return json(res, 400, { error: e.message });
        }
      }
      if (p === '/api/workshop/pull' && req.method === 'GET') {
        // Held open until there is news (or a while has passed): this is how changes reach an editor.
        const waiting = workshop.pull(Number(url.searchParams.get('version')));
        res.on('close', () => { if (!res.writableEnded) waiting.cancel(); });
        const result = await waiting.promise;
        // Beside the changes: savesRev, by which an editor sees that the save list has changed since
        // it last fetched it, and who is in the room with their cursors.
        const extra = {};
        if (workshopSaves) extra.savesRev = workshopSaves.rev();
        if (workshopPresence) extra.presence = workshopPresence.list();
        if (!res.writableEnded && !res.destroyed) json(res, 200, Object.assign(extra, result));
        return;
      }
      if (workshopSaves && p === '/api/workshop/saves' && req.method === 'GET') return json(res, 200, workshopSaves.get());
      if (workshopSaves && p === '/api/workshop/saves' && req.method === 'POST') {
        // a save holds a whole game, like a push that loads one
        const body = await readJson(req, MAX_PUSH_BODY);
        try {
          const before = workshopSaves.rev();
          const after = workshopSaves.add(body.group, body.entry);
          if (after.rev !== before) workshop.nudge();
          return json(res, 200, after);
        } catch (e) {
          if (e.name !== 'WorkshopError') throw e;
          return json(res, 400, { error: e.message });
        }
      }
      return json(res, 404, { error: 'not found' });
    }
    if (p === '/api/token' && req.method === 'POST') {
      const body = await readJson(req);
      try {
        // The page needs the access token to finish signing in with the Discord client. The session
        // is what it shows the bot from then on: the bot's own word for who Discord said this is.
        const { accessToken, user } = await oauth.exchange(body.code);
        return json(res, 200, { access_token: accessToken, session: signer.sign({ uid: user.id, name: user.name }, SESSION_MS) });
      } catch (e) {
        if (!(e instanceof OAuthError)) throw e;
        return json(res, 401, { error: e.message });
      }
    }
    if ((p === '/api/tweak' && req.method === 'GET') || (p === '/api/levels' && req.method === 'POST')) {
      const uid = sessionUser(req);
      if (uid === null) return json(res, 401, { error: 'sign in again' });
      if (p === '/api/tweak') {
        const tweak = await api.tweak(uid);
        return tweak ? json(res, 200, tweak) : json(res, 404, { error: 'nothing to edit' });
      }
      return json(res, 200, await api.submit(uid, await readJson(req)));
    }
    if (p.startsWith('/api/')) return json(res, 404, { error: 'not found' });
    if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'method not allowed' });
    return serveStatic(p, res, req.method === 'HEAD');
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      if (e && e.status) return json(res, e.status, { error: e.status === 413 ? 'too large' : 'bad request' });
      log('http request failed', e);
      if (res.headersSent) res.destroy();
      else json(res, 500, { error: 'server error' });
    });
  });

  return {
    listen: (port, host = '127.0.0.1') => new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => { server.off('error', reject); resolve(server.address().port); });
    }),
    close: () => new Promise((resolve) => {
      if (presenceTimer !== null) clearTimeout(presenceTimer);
      server.close(() => resolve());
      server.closeAllConnections();
    }),
  };
}

module.exports = { createHttpServer };
