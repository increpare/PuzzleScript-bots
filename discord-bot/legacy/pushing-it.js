'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { sha256 } = require('../sources');

const GIST_ID = '2fe3172d2b9fe684977d184f1b6226d5';
const SOURCE_HASH = 'c7c54bd07ead0d24de38bda35d093e3daf1cb9d50ba724e997d3efdc719db3a0';
let source;

function getSource() {
  if (source === undefined) {
    const text = fs.readFileSync(path.join(__dirname, 'pushing-it/script.txt'), 'utf8');
    if (!matchesSource(text)) throw new Error('the preserved Pushing It source has changed');
    source = text;
  }
  return source;
}

function matchesSource(text) {
  return typeof text === 'string' && sha256(text) === SOURCE_HASH;
}

// This metadata belongs to the fingerprinted source, and also upgrades saved records made
// before the custom host existed. A fresh object keeps per-game metadata independent.
function getMetadata() {
  return {
    title: 'Pushing It', author: 'Jack Lance', levelCount: 12,
    realLevels: Array.from({ length: 12 }, (_, i) => i),
    flags: { noaction: false, noundo: false, norestart: false, realtime: false, uneditable: true },
  };
}

// play.html executes this via the homepage's onerror handler. Only decode the verified,
// bundled source: this is deliberately not an HTML/JavaScript loader for other games.
function getPayload() {
  const body = getSource().match(/a\.innerHTML = `([\s\S]*?)`;document\.body/)[1];
  const entities = { lpar: '(', rpar: ')', amp: '&', lt: '<', gt: '>', quot: '"' };
  return body.replace(/&(lpar|rpar|amp|lt|gt|quot);/g, (_, name) => entities[name]);
}

module.exports = { GIST_ID, SOURCE_HASH, getSource, matchesSource, getMetadata, getPayload };
