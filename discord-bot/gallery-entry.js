'use strict';
const vm = require('node:vm');

// Something about a gallery submission, or the list it is to join, that is not as it should be.
// Its message is fit to show to whoever is submitting.
class GalleryError extends Error {
  constructor(message) { super(message); this.name = 'GalleryError'; }
}

const MAX_GIF_BYTES = 2 * 1024 * 1024;
const MAX_NAME = 100;
const MAX_HOMEPAGE = 200;
const CONTROL = /[\u0000-\u001f\u007f]/;
// A web address, with or without its http(s)://. The gallery page writes a homepage into a link
// as it is, and it comes from the game's own prelude, so nothing that could end the link is let in.
const HOMEPAGE = /^(https?:\/\/)?[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:\d{1,5})?([/?#][a-z0-9\-._~:/?#[\]@!$&()*+,;=%]*)?$/i;
// How long a link to the submission page is good for.
const GALLERY_LINK_MS = 6 * 60 * 60 * 1000;

// The submission page, opened for one game. The token is in the fragment, which a browser keeps
// to itself: it is in no request, and so in no server's log.
const galleryLink = (publicUrl, token) => publicUrl + 'gallery/#t=' + token;

// The records of a games_dat.js, which is a script that declares one list. It is run, as the
// gallery page runs it, and the list is copied out as plain data.
function readRecords(text) {
  let list;
  try {
    const sandbox = {};
    vm.runInNewContext(String(text) + '\n;this.__g = JSON.stringify(games_gallery);', sandbox, { timeout: 1000 });
    list = JSON.parse(sandbox.__g);
  } catch (e) { throw new GalleryError('the gallery list could not be read'); }
  if (!Array.isArray(list)) throw new GalleryError('the gallery list could not be read');
  return list;
}

// The gist a record's play link points at, or null.
function gistOf(record) {
  const m = /[?&]p=([0-9a-f]+)/i.exec(String((record && record.url) || ''));
  return m ? m[1].toLowerCase() : null;
}

function hasGist(text, gistId) {
  const id = String(gistId).toLowerCase();
  return readRecords(text).some((r) => gistOf(r) === id);
}

// What the submission page sends, checked and tidied: the GIF as bytes, the fields trimmed.
function checkSubmission(body) {
  const { gif, title, author } = body || {};
  const homepage = body && body.homepage !== undefined ? body.homepage : '';
  const bytes = typeof gif === 'string' ? Buffer.from(gif, 'base64') : Buffer.alloc(0);
  const signature = bytes.subarray(0, 6).toString('latin1');
  if (signature !== 'GIF89a' && signature !== 'GIF87a') throw new GalleryError('that is not a GIF');
  if (bytes.length > MAX_GIF_BYTES) throw new GalleryError('the GIF is too big (' + (bytes.length / 1024 / 1024).toFixed(1) + ' MB; the most is 2 MB)');
  const name = (value, what) => {
    const s = typeof value === 'string' ? value.trim() : '';
    if (!s || s.length > MAX_NAME || CONTROL.test(s)) throw new GalleryError('the ' + what + ' must be 1 to ' + MAX_NAME + ' characters on one line');
    return s;
  };
  const tidy = { gif: bytes, title: name(title, 'title'), author: name(author, 'author') };
  const home = typeof homepage === 'string' ? homepage.trim() : null;
  if (home === null || home.length > MAX_HOMEPAGE || (home !== '' && !HOMEPAGE.test(home))) throw new GalleryError('the homepage must be a web address of at most ' + MAX_HOMEPAGE + ' characters, or left empty');
  tidy.homepage = home;
  return tidy;
}

// A game's record in the list. The picture is named after the gist, as the gallery's first ones were.
function galleryRecord({ gistId, title, author, homepage }) {
  const id = String(gistId).toLowerCase();
  const record = { url: 'https://www.puzzlescript.net/play.html?p=' + id, thumb: id + '.gif', title, author };
  // without a homepage the gallery page links the game itself
  if (homepage) record.homepage = homepage;
  return record;
}

// The text of a games_dat.js with one record more, at the end of its list and in its own layout.
// Nothing that was there is changed, beyond a comma after the last record if it had none. A text
// that is not laid out as expected is refused rather than guessed at.
function appendRecord(text, record) {
  text = String(text);
  const close = text.lastIndexOf(']');
  if (close === -1 || !/^\s*;?\s*$/.test(text.slice(close + 1))) throw new GalleryError('the gallery list is not laid out as expected');
  const before = readRecords(text);
  const id = gistOf(record);
  if (id === null) throw new GalleryError('the record has no game');
  if (before.some((r) => gistOf(r) === id)) throw new GalleryError('that game is already in the gallery');

  let head = text.slice(0, close);
  const last = head.trimEnd();
  if (last.endsWith('}')) head = last + ',' + head.slice(last.length);
  else if (!last.endsWith(',') && !last.endsWith('[')) throw new GalleryError('the gallery list is not laid out as expected');
  if (!head.endsWith('\n')) head += '\n';
  // JSON's own layout, moved in by the two spaces every record of the list starts at
  const lines = JSON.stringify(record, null, 4).split('\n');
  lines[0] = '  ' + lines[0];
  lines[lines.length - 1] = '  ' + lines[lines.length - 1] + ',';
  const out = head + lines.join('\n') + '\n' + text.slice(close);

  const after = readRecords(out);
  if (after.length !== before.length + 1 || JSON.stringify(after[after.length - 1]) !== JSON.stringify(record)) throw new GalleryError('the gallery list is not laid out as expected');
  return out;
}

module.exports = { GalleryError, readRecords, gistOf, hasGist, checkSubmission, galleryRecord, appendRecord, galleryLink, MAX_GIF_BYTES, GALLERY_LINK_MS };
