'use strict';
const { Client, GatewayIntentBits, AttachmentBuilder, MessageFlags } = require('discord.js');
const { loadConfig } = require('./config');
const { createPool } = require('./pool');
const { createGistStore, parseGistId, GistError } = require('./gists');
const { createRegistry } = require('./games');
const { renderSnapshot } = require('./renderer');
const { loadGallery, suggest } = require('./gallery');
const { createScores } = require('./scores');
const { buildComponents, buildEmbed, parseCustomId } = require('./presentation');


function frame(record, snapshot) {
  const { png } = renderSnapshot(snapshot);
  const name = 'frame.png';
  return {
    content: '',
    embeds: [buildEmbed({ record, snapshot, attachmentName: name })],
    files: [new AttachmentBuilder(png, { name })],
    components: record.status === 'playing' ? buildComponents(snapshot, record.meta) : [],
  };
}

function userMessageRaw(err) {
  if (err instanceof GistError) return err.message;
  const name = err && err.name;
  if (name === 'NoGameError') return 'this game is no longer available';
  if (name === 'CompileError') return 'that game does not compile: ' + err.message;
  if (name === 'TimeoutError') return 'that game took too long and was stopped';
  if (name === 'EngineError') return 'the game stopped: ' + err.message;
  if (name === 'EvictedError') return 'the game was paused by the server, press again';
  if (name === 'RegistryClosedError' || name === 'PoolClosedError') return 'the bot is restarting, try again in a moment';
  console.error(err);
  return 'something went wrong';
}

function userMessage(err) {
  return String(userMessageRaw(err)).slice(0, 1900);
}

async function main() {
  const cfg = loadConfig();
  const pool = createPool({ size: 2 });
  const gists = createGistStore({ dataDir: cfg.dataDir, token: cfg.githubToken });
  const registry = createRegistry({ dataDir: cfg.dataDir, pool, getSource: gists.getSource });
  console.log('loaded', registry.loadAll(), 'games', registry.storage());

  const scores = createScores({ dataDir: cfg.dataDir });
  const gallery = loadGallery();
  const client = new Client({ intents: [GatewayIntentBits.Guilds], allowedMentions: { parse: [] } });

  // Per-game chain so button edits land in press order.
  const editChains = new Map();
  function enqueueEdit(gameId, fn) {
    const prev = editChains.get(gameId) || Promise.resolve();
    const tail = prev.then(fn).catch((e) => console.error('edit failed', 'code', e && e.code, 'status', e && e.status, e));
    editChains.set(gameId, tail);
    tail.then(() => { if (editChains.get(gameId) === tail) editChains.delete(gameId); });
    return tail;
  }

  client.on('interactionCreate', async (interaction) => {
    if (interaction.isAutocomplete() && interaction.commandName === 'play') {
      try {
        const focused = interaction.options.getFocused();
        await interaction.respond(suggest(gallery, focused));
      } catch (err) {
        console.error('autocomplete failed', err);
      }
      return;
    }
    try {
      if (interaction.isChatInputCommand() && interaction.commandName === 'play') {
        const gistId = parseGistId(interaction.options.getString('game', true));
        const level = (interaction.options.getInteger('level') || 1) - 1;
        if (!gistId) {
          await interaction.reply({ content: 'that does not look like a gist id or a play link', flags: MessageFlags.Ephemeral });
          return;
        }
        const t0 = Date.now();
        await interaction.deferReply();
        console.log('play deferred', Date.now() - t0, 'ms');
        const reply = await interaction.fetchReply();
        try {
          const { record, snapshot } = await registry.start({ gameId: reply.id, channelId: interaction.channelId, gistId, startLevel: level });
          console.log('play started', Date.now() - t0, 'ms');
          if (record.meta.flags.realtime) {
            registry.markDead(record.gameId, 'realtime game');
            await interaction.editReply({ content: 'realtime games cannot be played here (this one sets realtime_interval)' });
            return;
          }
          if (record.meta.levelCount < level + 1) {
            registry.markDead(record.gameId, 'level out of range');
            await interaction.editReply({ content: 'that game only has ' + record.meta.levelCount + (record.meta.levelCount === 1 ? ' level' : ' levels') });
            return;
          }
          await interaction.editReply(frame(record, snapshot));
          console.log('play edited', Date.now() - t0, 'ms');
        } catch (err) {
          await interaction.editReply({ content: userMessage(err) });
        }
        return;
      }
      if (interaction.isChatInputCommand() && interaction.commandName === 'rank') {
        const s = scores.get(interaction.user.id);
        const levels = s.count === 1 ? '1 level' : s.count + ' levels';
        const next = s.next === null ? 'That is the top rank.' : 'Next rank at ' + s.next + '.';
        await interaction.reply({ content: 'You have solved ' + levels + ' (rank ' + s.rank + '). ' + next, flags: MessageFlags.Ephemeral });
        return;
      }
      if (interaction.isButton()) {
        const action = parseCustomId(interaction.customId);
        if (!action) return;
        const gameId = interaction.message.id;
        const t0 = Date.now();
        console.log('press', action, gameId, 'gateway-lag', t0 - interaction.createdTimestamp, 'ms');
        if (!registry.get(gameId)) {
          await interaction.reply({ content: 'this game is no longer available', flags: MessageFlags.Ephemeral });
          return;
        }
        await interaction.deferUpdate();
        console.log('ack', Date.now() - t0, 'ms');
        try {
          const { record, snapshot, applied, solvedLevel } = await registry.press(gameId, action, (interaction.member && interaction.member.displayName) || interaction.user.globalName || interaction.user.username);
          console.log('applied', applied, Date.now() - t0, 'ms');
          await enqueueEdit(gameId, () => interaction.editReply(frame(record, snapshot)));
          console.log('edited', Date.now() - t0, 'ms');
          if (solvedLevel !== null && solvedLevel !== undefined) {
            const s = scores.credit(interaction.user.id, record.gistId, solvedLevel);
            // Rank-ups are announced only in the score channel (or wherever the game is, if none is configured).
            const here = !cfg.scoreChannelId || cfg.scoreChannelId === interaction.channelId;
            if (s.rankedUp && here) {
              const levels = s.count === 1 ? '1 level' : s.count + ' levels';
              await interaction.followUp({ content: '<@' + interaction.user.id + '> has solved ' + levels + ' and reached rank ' + s.rank + '.' })
                .catch((e) => console.error('rank announcement failed', e && e.code));
            }
          }
        } catch (err) {
          // Keep the existing embed and image; keep buttons while the game is still playable.
          const rec = registry.get(gameId);
          const playable = rec && rec.status === 'playing';
          await enqueueEdit(gameId, () => interaction.editReply({ content: userMessage(err), ...(playable ? {} : { components: [] }) }));
        }
      }
    } catch (err) {
      console.error('interaction failed', err);
    }
  });

  client.once('ready', () => console.log('logged in as', client.user.tag));
  client.on('error', (e) => console.error('client error', e));
  const shutdown = async () => { await registry.close(); await pool.close(); client.destroy(); process.exit(0); };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  await client.login(cfg.discordToken);
}

main().catch((e) => { console.error(e); process.exit(1); });
