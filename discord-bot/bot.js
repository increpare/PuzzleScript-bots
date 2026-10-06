'use strict';
const { Client, GatewayIntentBits, AttachmentBuilder, MessageFlags } = require('discord.js');
const { loadConfig } = require('./config');
const { createPool } = require('./pool');
const { createGistStore, parseGistId, GistError } = require('./gists');
const { createRegistry } = require('./games');
const { renderSnapshot } = require('./renderer');
const { buildComponents, buildEmbed, parseCustomId } = require('./presentation');

const PRUNE_MS = 14 * 24 * 3600 * 1000;

function frame(record, snapshot) {
  const { png } = renderSnapshot(snapshot);
  const name = 'frame.png';
  return {
    embeds: [buildEmbed({ record, snapshot, attachmentName: name })],
    files: [new AttachmentBuilder(png, { name })],
    components: record.status === 'playing' ? buildComponents(snapshot, record.meta) : [],
  };
}

function userMessage(err) {
  if (err instanceof GistError) return err.message;
  const name = err && err.name;
  if (name === 'CompileError') return 'that game does not compile: ' + err.message;
  if (name === 'TimeoutError') return 'that game took too long and was stopped';
  if (name === 'EngineError') return 'the game stopped: ' + err.message;
  if (name === 'EvictedError') return 'the game was paused by the server, press again';
  if (name === 'RegistryClosedError' || name === 'PoolClosedError') return 'the bot is restarting, try again in a moment';
  console.error(err);
  return 'something went wrong';
}

async function main() {
  const cfg = loadConfig();
  const pool = createPool({ size: 2 });
  const gists = createGistStore({ dataDir: cfg.dataDir, token: cfg.githubToken });
  const registry = createRegistry({ dataDir: cfg.dataDir, pool, getSource: gists.getSource });
  console.log('loaded', registry.loadAll(), 'games;', 'pruned', registry.prune(PRUNE_MS));
  setInterval(() => console.log('pruned', registry.prune(PRUNE_MS)), 24 * 3600 * 1000).unref();

  const client = new Client({ intents: [GatewayIntentBits.Guilds] });

  client.on('interactionCreate', async (interaction) => {
    try {
      if (interaction.isChatInputCommand() && interaction.commandName === 'play') {
        const gistId = parseGistId(interaction.options.getString('game', true));
        const level = (interaction.options.getInteger('level') || 1) - 1;
        if (!gistId) return interaction.reply({ content: 'that does not look like a gist id or a play link', flags: MessageFlags.Ephemeral });
        await interaction.deferReply();
        const reply = await interaction.fetchReply();
        try {
          const { record, snapshot } = await registry.start({ gameId: reply.id, channelId: interaction.channelId, gistId, startLevel: level });
          if (record.meta.flags.realtime) {
            await interaction.editReply({ content: 'realtime games cannot be played here (this one sets realtime_interval)' });
            return;
          }
          if (record.meta.levelCount < level + 1) {
            await interaction.editReply({ content: 'that game only has ' + record.meta.levelCount + ' levels' });
            return;
          }
          await interaction.editReply(frame(record, snapshot));
        } catch (err) {
          await interaction.editReply({ content: userMessage(err) });
        }
        return;
      }
      if (interaction.isButton()) {
        const action = parseCustomId(interaction.customId);
        if (!action) return;
        const gameId = interaction.message.id;
        if (!registry.get(gameId)) {
          return interaction.reply({ content: 'this game is no longer available', flags: MessageFlags.Ephemeral });
        }
        await interaction.deferUpdate();
        try {
          const { record, snapshot } = await registry.press(gameId, action);
          await interaction.editReply(frame(record, snapshot));
        } catch (err) {
          // Leave the existing embed and image untouched; just drop the buttons and explain.
          await interaction.editReply({ content: userMessage(err), components: [] });
        }
      }
    } catch (err) {
      console.error('interaction failed', err);
    }
  });

  client.once('ready', () => console.log('logged in as', client.user.tag));
  process.on('SIGTERM', async () => { await registry.close(); await pool.close(); client.destroy(); process.exit(0); });
  await client.login(cfg.discordToken);
}

main().catch((e) => { console.error(e); process.exit(1); });
