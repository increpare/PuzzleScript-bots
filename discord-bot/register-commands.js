'use strict';
const { REST, Routes, SlashCommandBuilder, ApplicationCommandType, EntryPointCommandHandlerType } = require('discord.js');
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
  // Shown to server administrators only while the workshop is being tested. Who else sees it, and
  // where, can be changed in the server's Integrations settings.
  const workshop = new SlashCommandBuilder().setName('workshop').setDescription('Open the shared PuzzleScript editor').setDefaultMemberPermissions(0);
  const rest = new REST({ version: '10' }).setToken(cfg.discordToken);
  await rest.put(Routes.applicationGuildCommands(cfg.appId, cfg.guildId), { body: [play.toJSON(), rank.toJSON(), role.toJSON(), workshop.toJSON()] });
  console.log('registered /play, /rank, /role and /workshop for guild', cfg.guildId);

  // Once Activities are enabled, Discord adds a global Entry Point command that launches the
  // Activity for anyone who picks the app in the launcher. Hand it to the bot, which answers with a
  // hint instead (see bot.js).
  const globals = await rest.get(Routes.applicationCommands(cfg.appId));
  const entry = globals.find((c) => c.type === ApplicationCommandType.PrimaryEntryPoint);
  if (!entry) console.log('no entry point command (Activities are not enabled)');
  else if (entry.handler === EntryPointCommandHandlerType.AppHandler) console.log('entry point command already handled by the bot');
  else {
    await rest.patch(Routes.applicationCommand(cfg.appId, entry.id), { body: { handler: EntryPointCommandHandlerType.AppHandler } });
    console.log('entry point command handed to the bot');
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
