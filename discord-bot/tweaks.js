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

// What each user is about to edit. Discord tells a launched Activity who is using it and in which
// channel, but nothing about the button that launched it, so the bot remembers the press here and
// the page asks for it after signing in. Kept in memory: after a restart the pencil is pressed again.
function createPending({ ttlMs = 15 * 60 * 1000, now = Date.now, max = 1000 } = {}) {
  const entries = new Map(); // userId -> { entry, at }; a Map keeps the order things were set in

  return {
    // the newest press wins
    set(userId, entry) {
      entries.delete(userId);
      entries.set(userId, { entry, at: now() });
      while (entries.size > max) entries.delete(entries.keys().next().value);
    },
    get(userId) {
      const found = entries.get(userId);
      if (!found) return null;
      if (now() - found.at >= ttlMs) { entries.delete(userId); return null; }
      return found.entry;
    },
  };
}

module.exports = { parseTweakChannels, tweakAllowed, createPending };
