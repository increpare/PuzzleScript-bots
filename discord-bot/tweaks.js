'use strict';

// Where the Tweak (level editor) button may appear, from TWEAK_CHANNEL_IDS.
// Unset: nowhere, so that an unfinished editor never shows by accident.
// A comma-separated list of channel ids: those channels, and threads under them.
// "*": everywhere.
function parseTweakChannels(value) {
  const s = String(value || '').trim();
  if (!s) return [];
  if (s === '*') return '*';
  return s.split(',').map((x) => x.trim()).filter(Boolean);
}

// parentId is the channel a thread belongs to, or null for an ordinary channel.
function tweakAllowed(channels, channelId, parentId) {
  if (channels === '*') return true;
  return channels.includes(channelId) || (!!parentId && channels.includes(parentId));
}

module.exports = { parseTweakChannels, tweakAllowed };
