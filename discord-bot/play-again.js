'use strict';
const { MessageFlags } = require('discord.js');
const { userMessage } = require('./presentation');

// A fresh public reply leaves the completed post intact.
async function playAgain(interaction, { registry, frame }) {
  const old = registry.get(interaction.message.id);
  if (!old || old.status !== 'finished' || old.levelId) {
    await interaction.reply({
      content: old ? 'this game cannot be played again here' : 'this game is no longer available',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  await interaction.deferReply();
  try {
    const reply = await interaction.fetchReply();
    const { record, snapshot } = await registry.start({ gameId: reply.id, channelId: interaction.channelId, gistId: old.gistId });
    if (record.meta.flags.realtime) {
      registry.markDead(record.gameId, 'realtime game');
      await interaction.editReply({ content: 'realtime games cannot be played here (this one sets realtime_interval)' });
      return;
    }
    await interaction.editReply(frame(record, snapshot));
  } catch (err) {
    await interaction.editReply({ content: userMessage(err, 'start') });
    return;
  }
}

module.exports = { playAgain };
