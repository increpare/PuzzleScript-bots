'use strict';
const crypto = require('node:crypto');
const { WorkshopError } = require('./workshop-doc');

const MAX_EXPORT_BYTES = 8 * 1024 * 1024;
// A byte limit alone would permit millions of very small entries and unbounded map overhead.
const MAX_EXPORT_ENTRIES = 128;
const DEFAULT_PUBLIC_URL = 'https://games.increpare.com/puzzlescriptbot/app/';

function normalizePublicUrl(value = DEFAULT_PUBLIC_URL) {
  let url;
  try { url = new URL(value); } catch (e) { throw new Error('WORKSHOP_PUBLIC_URL must be an HTTPS or local HTTP URL'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (!/^https?:\/\//i.test(value) || (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) || url.username || url.password || url.search || url.hash) {
    throw new Error('WORKSHOP_PUBLIC_URL must be an HTTPS or local HTTP URL without credentials, query or fragment');
  }
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  return url.href;
}

function exportFilename(filename) {
  if (typeof filename !== 'string' || !filename.trim()) throw new WorkshopError('bad export filename');
  // Reject unpaired surrogates, which cannot be represented in a UTF-8 filename parameter.
  try { encodeURIComponent(filename); } catch (e) { throw new WorkshopError('bad export filename'); }
  const clean = filename.replace(/[\/\\\x00-\x1f\x7f-\x9f:"<>|?*]/g, '_').replace(/^\.+/, '').trim();
  return Array.from(clean.replace(/\.(?:html?|txt)$/i, '')).slice(0, 160).join('') || 'game';
}

// Each pair is an immutable snapshot. Possession of its random download token grants access;
// sessions and source documents are never embedded in a URL. A pair expires or is evicted whole.
function createExports({ now = Date.now, ttlMs = 15 * 60 * 1000, maxBytes = 32 * 1024 * 1024 } = {}) {
  const entries = new Map();
  const attachments = new Map();
  let bytes = 0;

  function remove(entry) {
    entries.delete(entry.htmlToken);
    attachments.delete(entry.htmlToken);
    attachments.delete(entry.sourceToken);
    bytes -= entry.bytes;
  }

  function expire(time) {
    for (const entry of entries.values()) if (entry.expiresAt <= time) remove(entry);
  }

  function add(input) {
    const time = now();
    expire(time);
    if (!input || typeof input.html !== 'string' || !input.html.trim() || typeof input.source !== 'string' || !input.source.trim()) {
      throw new WorkshopError('bad export');
    }
    const filename = exportFilename(input.filename);
    const size = Buffer.byteLength(input.html) + Buffer.byteLength(input.source);
    if (size > MAX_EXPORT_BYTES || size > maxBytes) {
      const error = new WorkshopError('that game is too big to export here');
      error.status = 413;
      throw error;
    }
    while (bytes + size > maxBytes || entries.size >= MAX_EXPORT_ENTRIES) remove(entries.values().next().value);
    const htmlToken = crypto.randomBytes(24).toString('base64url');
    const sourceToken = crypto.randomBytes(24).toString('base64url');
    entries.set(htmlToken, { htmlToken, sourceToken, bytes: size, expiresAt: time + ttlMs });
    attachments.set(htmlToken, Object.freeze({ body: input.html, filename: filename + '.html', contentType: 'text/html; charset=utf-8' }));
    attachments.set(sourceToken, Object.freeze({ body: input.source, filename: filename + '.txt', contentType: 'text/plain; charset=utf-8' }));
    bytes += size;
    return { htmlToken, sourceToken };
  }

  function get(token) {
    expire(now());
    return attachments.get(token) || null;
  }

  return { add, get };
}

module.exports = { createExports, DEFAULT_PUBLIC_URL, normalizePublicUrl };
