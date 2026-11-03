'use strict';
const { MessageFlags } = require('discord.js');
const { scoreboardMessage } = require('./presentation');

async function showScoreboard(interaction, { scores, users }) {
  await interaction.deferReply();
  const board = scores.leaderboard(interaction.user.id);
  async function withName(entry) {
    if (!entry) return null;
    let name;
    if (entry.userId === interaction.user.id) {
      name = interaction.member && (interaction.member.displayName || interaction.member.nick);
      name = name || interaction.user.globalName || interaction.user.username;
    } else {
      const member = interaction.guild ? await interaction.guild.members.fetch({ user: entry.userId, force: true }).catch(() => null) : null;
      name = member && member.displayName;
      if (!name) {
        const user = await users.fetch(entry.userId, { force: true }).catch(() => null);
        name = user && (user.globalName || user.username);
      }
    }
    return { ...entry, name: name || 'User ' + entry.userId };
  }
  const [top, player] = await Promise.all([Promise.all(board.top.map(withName)), withName(board.player)]);
  await interaction.editReply({
    content: scoreboardMessage({ top, player }, interaction.user.id),
    allowedMentions: { parse: [] },
    flags: MessageFlags.SuppressEmbeds,
  });
}

module.exports = { showScoreboard };
