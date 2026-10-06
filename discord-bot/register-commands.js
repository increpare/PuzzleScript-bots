'use strict';
const { REST, Routes, SlashCommandBuilder } = require('discord.js');
const { loadConfig } = require('./config');

async function main() {
  const cfg = loadConfig();
  const play = new SlashCommandBuilder()
    .setName('play')
    .setDescription('Play a PuzzleScript game in this channel')
    .addStringOption((o) => o.setName('game').setDescription('Gist id, play.html link, or gist link').setRequired(true).setAutocomplete(true))
    .addIntegerOption((o) => o.setName('level').setDescription('Level to start at (1 = first)').setMinValue(1));
  const rank = new SlashCommandBuilder().setName('rank').setDescription('Show how many levels you have solved and your rank');
  const rest = new REST({ version: '10' }).setToken(cfg.discordToken);
  await rest.put(Routes.applicationGuildCommands(cfg.appId, cfg.guildId), { body: [play.toJSON(), rank.toJSON()] });
  console.log('registered /play and /rank for guild', cfg.guildId);
}

main().catch((e) => { console.error(e); process.exit(1); });
