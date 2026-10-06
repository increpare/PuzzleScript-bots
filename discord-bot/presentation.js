'use strict';
const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } = require('discord.js');

const ACTIONS = ['up', 'left', 'down', 'right', 'action', 'undo', 'restart', 'continue'];
const ACTION_EMOJI = { left: '⬅️', up: '⬆️', down: '⬇️', right: '➡️', action: '✖️', undo: '↩️', restart: '🔄', continue: '▶️' };

function button(action, style = ButtonStyle.Secondary) {
  return new ButtonBuilder().setCustomId('ps:' + action).setEmoji(ACTION_EMOJI[action]).setStyle(style);
}

function buildComponents(snapshot, meta) {
  if (snapshot.kind === 'message') return [new ActionRowBuilder().addComponents(button('continue', ButtonStyle.Primary))];
  if (snapshot.kind !== 'level') return [];
  const flags = (meta && meta.flags) || {};
  const row1 = [button('left'), button('up'), button('down'), button('right')];
  if (!flags.noaction) row1.push(button('action', ButtonStyle.Primary));
  const row2 = [];
  if (!flags.noundo) row2.push(button('undo'));
  if (!flags.norestart) row2.push(button('restart', ButtonStyle.Danger));
  const rows = [new ActionRowBuilder().addComponents(...row1)];
  if (row2.length) rows.push(new ActionRowBuilder().addComponents(...row2));
  return rows;
}

function footerText(record, snapshot) {
  if (record.status === 'dead') return 'stopped: ' + (record.deadReason || 'error');
  if (snapshot.kind === 'finished' || record.status === 'finished') return 'finished';
  return 'Level ' + ((snapshot.levelIndex | 0) + 1) + ' of ' + snapshot.levelCount;
}

function buildEmbed({ record, snapshot, attachmentName }) {
  const meta = record.meta || {};
  const e = new EmbedBuilder()
    .setTitle(String(meta.title || 'PuzzleScript game').slice(0, 256))
    .setFooter({ text: footerText(record, snapshot).slice(0, 2048) });
  if (meta.author) e.setDescription(('by ' + meta.author).slice(0, 1000));
  if (attachmentName) e.setImage('attachment://' + attachmentName);
  return e;
}

function parseCustomId(id) {
  const m = /^ps:([a-z]+)$/.exec(String(id || ''));
  return m && ACTIONS.includes(m[1]) ? m[1] : null;
}

module.exports = { buildComponents, buildEmbed, parseCustomId, ACTION_EMOJI };
