'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { OAuthError } = require('./discord-oauth');

// Only these are served. Anything else in the page directory is not for the browser.
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
};
const MAX_BODY = 64 * 1024;

// no-cache: Discord's proxy and its clients hold on to files, and a deploy has to show at once.
function json(res, status, obj) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-cache' });
  res.end(JSON.stringify(obj));
}

// Reads a JSON object from the request. Rejects with {status} for a body that is too large or is not one.
// An oversize body is read to its end and thrown away, so that the client gets its answer.
function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size <= MAX_BODY) chunks.push(c);
    });
    req.on('error', () => reject({ status: 400 }));
    req.on('end', () => {
      if (size > MAX_BODY) return reject({ status: 413 });
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
function createHttpServer({ staticDir, oauth, onReport = () => {}, log = console.error }) {
  const root = path.resolve(staticDir);

  function serveStatic(pathname, res, headOnly) {
    let rel;
    try { rel = decodeURIComponent(pathname); } catch (e) { return json(res, 404, { error: 'not found' }); }
    if (rel.endsWith('/')) rel += 'index.html';
    const file = path.resolve(root, '.' + rel);
    const type = TYPES[path.extname(file)];
    if (rel.includes('\0') || !file.startsWith(root + path.sep) || !type) return json(res, 404, { error: 'not found' });
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) return json(res, 404, { error: 'not found' });
      res.writeHead(200, { 'content-type': type, 'content-length': st.size, 'cache-control': 'no-cache' });
      if (headOnly) return res.end();
      fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
    });
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    // A request that came through Discord's proxy as /.proxy/api/... is the same request as /api/...
    const p = url.pathname.replace(/^\/\.proxy(?=\/)/, '');
    if (p === '/api/ping' && req.method === 'GET') return json(res, 200, { ok: true, path: url.pathname });
    if (p === '/api/token' && req.method === 'POST') {
      const body = await readJson(req);
      try {
        const { accessToken } = await oauth.exchange(body.code);
        return json(res, 200, { access_token: accessToken });
      } catch (e) {
        if (!(e instanceof OAuthError)) throw e;
        return json(res, 401, { error: e.message });
      }
    }
    if (p === '/api/spike-report' && req.method === 'POST') {
      onReport(await readJson(req));
      return json(res, 200, { ok: true });
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
    close: () => new Promise((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }),
  };
}

module.exports = { createHttpServer };
