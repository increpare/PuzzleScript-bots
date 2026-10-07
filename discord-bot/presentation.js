'use strict';
const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, escapeMarkdown } = require('discord.js');
const { GistError } = require('./gists');

// tweak and again are not moves. tweak opens the level editor and again starts a solved sent level
// afresh (see bot.js); neither reaches the game registry as an input.
const ACTIONS = ['up', 'left', 'down', 'right', 'action', 'undo', 'restart', 'continue', 'tweak', 'again'];
const ACTION_EMOJI = { left: '⬅️', up: '⬆️', down: '⬇️', right: '➡️', action: '✖️', undo: '↩️', restart: '🔄', continue: '▶️', tweak: '✏️', again: '🔁' };

function button(action, style = ButtonStyle.Secondary) {
  return new ButtonBuilder().setCustomId('ps:' + action).setEmoji(ACTION_EMOJI[action]).setStyle(style);
}

// tweak: the level editor is offered here. again: this is a sent level, which can be played again once solved.
function buildComponents(snapshot, meta, { tweak = false, again = false } = {}) {
  if (snapshot.kind === 'message') return [new ActionRowBuilder().addComponents(button('continue', ButtonStyle.Primary))];
  if (snapshot.kind === 'finished' && again) {
    const row = [button('again', ButtonStyle.Primary)];
    if (tweak) row.push(button('tweak'));
    return [new ActionRowBuilder().addComponents(...row)];
  }
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

// "Solved by Ada, Bob and Cy": at most ten names, then a count of the rest.
function solvedByText(solvedBy) {
  const names = (solvedBy || []).map((s) => s.name);
  if (names.length === 0) return 'Solved';
  if (names.length === 1) return 'Solved by ' + names[0];
  if (names.length <= 10) return 'Solved by ' + names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1];
  return 'Solved by ' + names.slice(0, 10).join(', ') + ' and ' + (names.length - 10) + ' more';
}

// sent: the sent level the game is running on (a record from the level store), if it is one
function footerText(record, snapshot, sent) {
  if (record.status === 'dead') return 'stopped: ' + (record.deadReason || 'error');
  if (snapshot.kind === 'finished' || record.status === 'finished') return sent ? solvedByText(sent.solvedBy) : 'finished';
  // levelNumber/realLevelCount leave out message screens; older snapshots only have the raw entry index
  const n = snapshot.levelNumber !== undefined ? snapshot.levelNumber : (snapshot.levelIndex | 0) + 1;
  const m = snapshot.realLevelCount !== undefined ? snapshot.realLevelCount : snapshot.levelCount;
  const level = sent ? 'Custom level' : 'Level ' + n + ' of ' + m;
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

// A level's text goes in the embed as a code block when it is short enough to read there and has
// nothing in it that would end the block early. Otherwise it is attached as a file (levelFile).
const fitsInEmbed = (text) => text.length <= 900 && !text.includes('```');

function levelFile(level) {
  return fitsInEmbed(level.text) ? null : { name: 'level.txt', data: Buffer.from(level.text + '\n') };
}

// level: the sent level the game is running on (a record from the level store), if it is one
function buildEmbed({ record, snapshot, attachmentName, level = null }) {
  const meta = record.meta || {};
  let title = String(meta.title || 'PuzzleScript game');
  if (level) title += ' — level by ' + escapeMarkdown(String(level.authorName || 'someone'));
  const e = new EmbedBuilder()
    .setTitle(title.slice(0, 256))
    .setFooter({ text: footerText(record, snapshot, level).slice(0, 2048) });
  if (level) e.setDescription(fitsInEmbed(level.text) ? '```\n' + level.text + '\n```' : 'Level text attached.');
  else if (meta.author) e.setDescription(('by ' + meta.author).slice(0, 1000));
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

// The message that stands in the workshop channel, to be pinned: one press opens the shared editor.
// Discord never opens an Activity for anyone by itself, so everyone comes in through a button.
const WORKSHOP_BUTTON = 'ps:workshop';
function workshopDoor() {
  return {
    content: '**PuzzleScript workshop**\nOne PuzzleScript editor that everyone here shares: whatever you type, the others see. Press the button to step in. It needs Discord on a computer.',
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(WORKSHOP_BUTTON).setLabel('Open the workshop').setStyle(ButtonStyle.Primary))],
  };
}

module.exports = { buildComponents, buildEmbed, levelFile, parseCustomId, userMessage, workshopDoor, WORKSHOP_BUTTON, ACTION_EMOJI };
