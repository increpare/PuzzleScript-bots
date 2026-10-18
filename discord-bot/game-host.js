'use strict';
const { createHost } = require('./engine-host');
const { matchesSource } = require('./legacy/pushing-it');

function createGameHost(source, options) {
  // Keep native Canvas loading out of the normal engine path (including the Twitch bot).
  return matchesSource(source)
    ? require('./pushing-it-host').createPushingItHost(options)
    : createHost(options);
}

module.exports = { createGameHost };
