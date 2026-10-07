'use strict';
const { REST, Routes, SlashCommandBuilder } = require('discord.js');
const { loadConfig } = require('./config');
const { KEYWORDS, NONE } = require('./roles');

async function main() {
  const cfg = loadConfig();
  const play = new SlashCommandBuilder()
    .setName('play')
    .setDescription('Play a PuzzleScript game in this channel')
    .addStringOption((o) => o.setName('game').setDescription('Gist id, play.html link, or gist link').setRequired(true).setAutocomplete(true))
    .addIntegerOption((o) => o.setName('level').setDescription('Level to start at (1 = first; message screens are not counted)').setMinValue(1));
  const rank = new SlashCommandBuilder().setName('rank').setDescription('Show how many levels you have solved and your rank');
  const role = new SlashCommandBuilder()
    .setName('role')
    .setDescription('Give yourself a PuzzleScript keyword role')
    .addStringOption((o) => o.setName('keyword').setDescription('The keyword to take, or none to drop the one you have').setRequired(true)
      .addChoices(...KEYWORDS.map((k) => ({ name: k, value: k })), { name: NONE, value: NONE }));
  const rest = new REST({ version: '10' }).setToken(cfg.discordToken);
  await rest.put(Routes.applicationGuildCommands(cfg.appId, cfg.guildId), { body: [play.toJSON(), rank.toJSON(), role.toJSON()] });
  console.log('registered /play, /rank and /role for guild', cfg.guildId);
}

main().catch((e) => { console.error(e); process.exit(1); });
