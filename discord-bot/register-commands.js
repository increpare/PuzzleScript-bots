'use strict';
const { REST, Routes, SlashCommandBuilder } = require('discord.js');
const { loadConfig } = require('./config');

async function main() {
  const cfg = loadConfig();
  const play = new SlashCommandBuilder()
    .setName('play')
    .setDescription('Play a PuzzleScript game in this channel')
    .addStringOption((o) => o.setName('game').setDescription('Gist id, play.html link, or gist link').setRequired(true))
    .addIntegerOption((o) => o.setName('level').setDescription('Level to start at (1 = first)').setMinValue(1));
  const rest = new REST({ version: '10' }).setToken(cfg.discordToken);
  await rest.put(Routes.applicationGuildCommands(cfg.appId, cfg.guildId), { body: [play.toJSON()] });
  console.log('registered /play for guild', cfg.guildId);
}

main().catch((e) => { console.error(e); process.exit(1); });
