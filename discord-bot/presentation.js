'use strict';
const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } = require('discord.js');
const { GistError } = require('./gists');

// tweak is not a move: it opens the level editor (see bot.js) and never reaches the game registry.
const ACTIONS = ['up', 'left', 'down', 'right', 'action', 'undo', 'restart', 'continue', 'tweak'];
const ACTION_EMOJI = { left: '⬅️', up: '⬆️', down: '⬇️', right: '➡️', action: '✖️', undo: '↩️', restart: '🔄', continue: '▶️', tweak: '✏️' };

function button(action, style = ButtonStyle.Secondary) {
  return new ButtonBuilder().setCustomId('ps:' + action).setEmoji(ACTION_EMOJI[action]).setStyle(style);
}

function buildComponents(snapshot, meta, { tweak = false } = {}) {
  if (snapshot.kind === 'message') return [new ActionRowBuilder().addComponents(button('continue', ButtonStyle.Primary))];
  if (snapshot.kind !== 'level') return [];
  const flags = (meta && meta.flags) || {};
  if (snapshot.animating) {
    // An again chain is still running, and the engine ignores moves until it is undone or restarted
    // (or, for one that was only paused, carried on).
    const row = [];
    if (snapshot.animating === 'more') row.push(button('continue', ButtonStyle.Primary));
    if (!flags.noundo) row.push(button('undo'));
    if (!flags.norestart) row.push(button('restart'));
    return row.length ? [new ActionRowBuilder().addComponents(...row)] : [];
  }
  const row1 = [button('left'), button('up'), button('down'), button('right')];
  if (!flags.noaction) row1.push(button('action', ButtonStyle.Primary));
  const row2 = [];
  if (!flags.noundo) row2.push(button('undo'));
  if (!flags.norestart) row2.push(button('restart'));
  if (tweak) row2.push(button('tweak'));
  const rows = [new ActionRowBuilder().addComponents(...row1)];
  if (row2.length) rows.push(new ActionRowBuilder().addComponents(...row2));
  return rows;
}

function footerText(record, snapshot) {
  if (record.status === 'dead') return 'stopped: ' + (record.deadReason || 'error');
  if (snapshot.kind === 'finished' || record.status === 'finished') return 'finished';
  // levelNumber/realLevelCount leave out message screens; older snapshots only have the raw entry index
  const n = snapshot.levelNumber !== undefined ? snapshot.levelNumber : (snapshot.levelIndex | 0) + 1;
  const m = snapshot.realLevelCount !== undefined ? snapshot.realLevelCount : snapshot.levelCount;
  const level = 'Level ' + n + ' of ' + m;
  const text = record.lastMover ? level + ' (Last move: ' + record.lastMover + ')' : level;
  // An again chain is still running: say which buttons get out of it. On a message the only button
  // is continue, which dismisses the message, so there is nothing to explain yet.
  if (!snapshot.animating || snapshot.kind !== 'level') return text;
  const flags = (record.meta && record.meta.flags) || {};
  const ways = [];
  if (snapshot.animating === 'more') ways.push('continue');
  if (!flags.noundo) ways.push('undo');
  if (!flags.norestart) ways.push('restart');
  if (ways.length === 0) return text + ' · looping, and this game has no undo or restart';
  const list = ways.length === 1 ? ways[0] : ways.slice(0, -1).join(', ') + ' or ' + ways[ways.length - 1];
  return text + (snapshot.animating === 'more' ? ' · still animating: ' : ' · looping: ') + list;
}

function buildEmbed({ record, snapshot, attachmentName }) {
  const meta = record.meta || {};
  const e = new EmbedBuilder()
    .setTitle(String(meta.title || 'PuzzleScript game').slice(0, 256))
    .setFooter({ text: footerText(record, snapshot).slice(0, 2048) });
  if (meta.author) e.setDescription(('by ' + meta.author).slice(0, 1000));
  if (record.gistId) e.setURL('https://www.puzzlescript.net/play.html?p=' + record.gistId);
  if (attachmentName) e.setImage('attachment://' + attachmentName);
  return e;
}

// What to tell the player when something fails. context is 'start' while a game is being started.
function userMessageRaw(err, context) {
  if (err instanceof GistError) return err.message;
  const name = err && err.name;
  if (name === 'LevelRangeError') return err.message;
  if (name === 'NoGameError') return 'this game is no longer available';
  if (name === 'CompileError') return 'that game does not compile: ' + err.message;
  if (name === 'MoveTooLongError' || name === 'TimeoutError') {
    return context === 'start' ? 'that game took too long to start' : 'that move took too long, so it was not made';
  }
  if (name === 'EngineError') return 'the game stopped: ' + err.message;
  if (name === 'ResourceError') return 'the game used too much memory and was stopped';
  if (name === 'EvictedError') return 'the game was paused by the server, press again';
  if (name === 'RegistryClosedError' || name === 'PoolClosedError') return 'the bot is restarting, try again in a moment';
  console.error(err);
  return 'something went wrong';
}

function userMessage(err, context) {
  return String(userMessageRaw(err, context)).slice(0, 1900);
}

function parseCustomId(id) {
  const m = /^ps:([a-z]+)$/.exec(String(id || ''));
  return m && ACTIONS.includes(m[1]) ? m[1] : null;
}

module.exports = { buildComponents, buildEmbed, parseCustomId, userMessage, ACTION_EMOJI };
