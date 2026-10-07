'use strict';
const { checkLevelText, levelId, splice } = require('./levels');

const HOUR = 60 * 60 * 1000;
const refuse = (error) => ({ ok: false, error });

// What happens when a player presses Send in the level editor: the level is checked, compiled,
// stored, and posted to the game's thread as a new game.
//
// discord is the only way this touches Discord: { guildId, channel(id) }, where a channel is what
// discord.js gives (isThread, threads.fetch/create, messages.fetch, send) — so tests pass fakes.
// frame(record, snapshot, where) builds the message for a game; where is { channelId, parentId }.
function createLevelPoster({ registry, levels, pool, sources, getSource, threads, discord, frame, now = Date.now, perHour = 10, log = console.error }) {
  const posted = new Map();  // user id -> when each of their levels in the last hour was posted
  const posting = new Map(); // level id -> the post in progress, so one level is never posted twice
  let scratchCount = 0;

  function recentPosts(uid) {
    const recent = (posted.get(uid) || []).filter((at) => now() - at < HOUR);
    if (recent.length) posted.set(uid, recent); else posted.delete(uid);
    return recent;
  }

  // The game a level is made for: the copy it was made against if the bot still has it, otherwise
  // the gist as it is now.
  async function baseSource(gistId, hash) {
    const stored = hash ? sources.load(hash) : null;
    return stored !== null ? stored : getSource(gistId);
  }

  // Loads a game under an id of its own, for a question about it, and forgets it again.
  async function withScratch(source, fn) {
    const id = 'scratch-' + scratchCount++;
    try {
      return await fn(id, await pool.load(id, source, 'seed', 0));
    } finally {
      await pool.drop(id).catch(() => {});
    }
  }

  // What the editor starts from, for a pencil press (see tweaks.js): a sent level as it was sent,
  // or a game's level as its author wrote it. null if a sent level has gone.
  async function textFor(pending) {
    if (pending.levelId) {
      const level = levels.get(pending.levelId);
      return level ? { title: pending.title, levelText: level.text } : null;
    }
    const source = await baseSource(pending.gistId, pending.baseSourceHash);
    const levelText = await withScratch(source, (id) => pool.levelText(id, { levelIndex: pending.levelIndex }));
    return { title: pending.title, levelText };
  }

  const linkTo = (threadId, messageId) => 'https://discord.com/channels/' + discord.guildId + '/' + threadId + '/' + messageId;

  // One thread per game per channel. A level made from a game that is already in a thread stays there.
  async function threadFor(ticket) {
    const channel = await discord.channel(ticket.channelId);
    if (channel.isThread()) return channel;
    const known = threads.get(channel.id, ticket.gistId);
    if (known) {
      const thread = await channel.threads.fetch(known).catch(() => null);
      if (thread) return thread;
    }
    const name = ('Levels: ' + (ticket.title || 'PuzzleScript game')).slice(0, 100);
    let thread = null;
    try {
      const message = await channel.messages.fetch(ticket.gameId);
      thread = await message.startThread({ name });
    } catch (e) { /* the game's message has gone, or already has a thread: start one on its own */ }
    if (!thread) thread = await channel.threads.create({ name });
    threads.set(channel.id, ticket.gistId, thread.id);
    return thread;
  }

  async function post(level, ticket) {
    const thread = await threadFor(ticket);
    // A game is known by the id of its message, so the message has to exist before the game does.
    const message = await thread.send({ content: 'A new level is on its way…' });
    try {
      const { record, snapshot } = await registry.start({ gameId: message.id, channelId: thread.id, gistId: level.gistId, level });
      await message.edit(frame(record, snapshot, { channelId: thread.id, parentId: thread.parentId || null }));
    } catch (e) {
      await message.edit({ content: 'This level could not be started.' }).catch(() => {});
      throw e;
    }
    levels.setPost(level.id, { channelId: thread.parentId || thread.id, threadId: thread.id, messageId: message.id });
    posted.set(ticket.uid, recentPosts(ticket.uid).concat(now()));
    return { ok: true, url: linkTo(thread.id, message.id) };
  }

  // ticket: what is being edited and by whom (uid, gistId, baseSourceHash, channelId, gameId,
  // authorName, title), already verified by the caller. text: the level as the page sent it.
  async function submit({ ticket, text }) {
    if (recentPosts(ticket.uid).length >= perHour) return refuse('you have sent ' + perHour + ' levels in the last hour; try again later');
    const checked = checkLevelText(text);
    if (!checked.ok) return refuse(checked.error);

    let base;
    try { base = await baseSource(ticket.gistId, ticket.baseSourceHash); }
    catch (e) { return refuse('the game this level is for could not be loaded'); }
    try {
      const levelCount = await withScratch(splice(base, checked.text), (id, meta) => meta.levelCount);
      if (levelCount !== 1) return refuse('send one level at a time');
    } catch (e) {
      if (e.name === 'CompileError') return refuse('that level does not compile: ' + e.message);
      if (e.name === 'TimeoutError' || e.name === 'MoveTooLongError') return refuse('that level took too long to start');
      throw e;
    }

    let level;
    try {
      level = levels.add({
        id: levelId(ticket.gistId, checked.text), gistId: ticket.gistId,
        // keeping the game the level was made against means the level can always be rebuilt as sent
        baseSourceHash: sources.save(base),
        text: checked.text, authorId: ticket.uid, authorName: ticket.authorName,
      });
    } catch (e) {
      if (e.name === 'LevelStoreFullError') return refuse('no more levels can be stored at the moment');
      throw e;
    }
    if (level.messageId) return { ok: true, url: linkTo(level.threadId, level.messageId) };
    if (posting.has(level.id)) return posting.get(level.id);

    const inFlight = post(level, ticket).catch((e) => {
      log('posting a level failed', e);
      return refuse('the level could not be posted');
    }).finally(() => posting.delete(level.id));
    posting.set(level.id, inFlight);
    return inFlight;
  }

  return { textFor, submit };
}

module.exports = { createLevelPoster };
