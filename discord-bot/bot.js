'use strict';
const { Client, GatewayIntentBits, AttachmentBuilder, MessageFlags } = require('discord.js');
const { loadConfig } = require('./config');
const { createPool } = require('./pool');
const { createGistStore, parseGistId } = require('./gists');
const { createRegistry } = require('./games');
const { renderSnapshot } = require('./renderer');
const { loadGallery, suggest } = require('./gallery');
const { createScores } = require('./scores');
const { createSourceStore } = require('./sources');
const { buildComponents, buildEmbed, levelFile, parseCustomId, userMessage } = require('./presentation');
const { planRoleChange, applyRoleChange } = require('./roles');
const fs = require('node:fs');
const path = require('node:path');
const { workshopPage } = require('./workshop-page');
const { createWorkshopDoc } = require('./workshop-doc');
const { tweakAllowed, createPending } = require('./tweaks');
const { createOAuth } = require('./discord-oauth');
const { createHttpServer } = require('./http-server');
const { createLevelStore } = require('./levels');
const { createThreadIndex } = require('./threads');
const { createSigner, signingKey } = require('./signing');
const { createLevelPoster } = require('./level-posts');

const TICKET_MS = 24 * 60 * 60 * 1000;

// gif: the animation of the move that led here, when there is one; otherwise a still is drawn.
// tweak: whether the level editor is offered in the channel the game is in.
// level: the sent level the game runs on (a record from the level store), if it is one.
function frame(record, snapshot, gif, tweak, level) {
  const name = gif ? 'frame.gif' : 'frame.png';
  const data = gif ? Buffer.from(gif) : renderSnapshot(snapshot).png;
  const files = [new AttachmentBuilder(data, { name })];
  const text = level ? levelFile(level) : null;
  if (text) files.push(new AttachmentBuilder(text.data, { name: text.name }));
  let components = [];
  if (record.status === 'playing') components = buildComponents(snapshot, record.meta, { tweak });
  // a solved sent level can be played again, and tweaked
  else if (record.status === 'finished' && level) components = buildComponents(snapshot, record.meta, { tweak, again: true });
  return { content: '', embeds: [buildEmbed({ record, snapshot, attachmentName: name, level })], files, components };
}

// The name a member goes by in the server.
const displayName = (interaction) => (interaction.member && interaction.member.displayName) || interaction.user.globalName || interaction.user.username;

async function main() {
  const cfg = loadConfig();
  const pool = createPool({ size: 2 });
  // All game source text lives in one store (99 MB cap); the gist index (1 MB) only points into it.
  const sources = createSourceStore({ dataDir: cfg.dataDir });
  const gists = createGistStore({ dataDir: cfg.dataDir, token: cfg.githubToken, sources });
  // Levels that players have sent with the level editor, and the games made from them.
  const levelStore = createLevelStore({ dataDir: cfg.dataDir });
  const levelOf = (record) => (record.levelId ? levelStore.get(record.levelId) : null);
  const registry = createRegistry({ dataDir: cfg.dataDir, pool, getSource: gists.getSource, sources, levels: levelStore });
  console.log('loaded', registry.loadAll(), 'games', registry.storage());

  const scores = createScores({ dataDir: cfg.dataDir });
  const gallery = loadGallery();
  const client = new Client({ intents: [GatewayIntentBits.Guilds], allowedMentions: { parse: [] } });

  // A thread counts as the channel it belongs to.
  const canTweak = (interaction) => tweakAllowed(cfg.tweakChannels, interaction.channelId, (interaction.channel && interaction.channel.parentId) || null);

  // The level editor. A pencil press is remembered here until the page, once signed in, asks what
  // it is to edit; the page gets that back as a signed ticket and returns it with the level.
  const pending = createPending();
  const signer = createSigner(signingKey(cfg.discordToken));
  const poster = createLevelPoster({
    registry, levels: levelStore, pool, sources, getSource: gists.getSource,
    threads: createThreadIndex({ dataDir: cfg.dataDir }),
    discord: { guildId: cfg.guildId, channel: (id) => client.channels.fetch(id) },
    frame: (record, snapshot, where) => frame(record, snapshot, null, tweakAllowed(cfg.tweakChannels, where.channelId, where.parentId), levelOf(record)),
  });
  const editorApi = {
    async tweak(uid) {
      const press = pending.get(uid);
      const start = press ? await poster.textFor(press) : null;
      if (!start) return null;
      const { gistId, baseSourceHash, channelId, gameId, authorName, title } = press;
      return { title: start.title, levelText: start.levelText, ticket: signer.sign({ kind: 'ticket', uid, gistId, baseSourceHash, channelId, gameId, authorName, title }, TICKET_MS) };
    },
    async submit(uid, body) {
      const ticket = signer.verify(body.ticket);
      if (!ticket || ticket.kind !== 'ticket' || ticket.uid !== uid) return { ok: false, error: 'this editing session has run out; close it and press the pencil again' };
      return poster.submit({ ticket, text: body.text });
    },
  };

  // The workshop's page is the PuzzleScript-labs editor with the workshop's scripts added. Labs is
  // copied beside the bot when it is deployed; without it the Activity is the level editor's page.
  const labsSrc = path.join(cfg.labsDir, 'src');
  let workshopHtml = null;
  try {
    workshopHtml = workshopPage(fs.readFileSync(path.join(labsSrc, 'editor.html'), 'utf8'));
  } catch (e) {
    console.log('no workshop editor:', e.code === 'ENOENT' ? 'there is no labs editor in ' + labsSrc : e.message);
  }

  // The document everyone in the workshop edits together. The bot holds it, so it is there
  // whenever anyone opens the room.
  const workshopDoc = workshopHtml ? createWorkshopDoc({ dataDir: cfg.dataDir }) : null;

  // The Activity's page. Without the client secret it cannot sign anyone in, so it is not served.
  let httpServer = null;
  if (cfg.clientSecret) {
    httpServer = createHttpServer({
      staticDirs: workshopHtml ? [path.join(__dirname, 'activity'), labsSrc] : [path.join(__dirname, 'activity')],
      indexHtml: workshopHtml,
      workshop: workshopDoc,
      // for working on the page on one's own machine; never set on the server
      devSession: process.env.WORKSHOP_DEV === '1',
      oauth: createOAuth({ clientId: cfg.appId, clientSecret: cfg.clientSecret }),
      signer,
      api: editorApi,
    });
    console.log('http on 127.0.0.1:' + await httpServer.listen(cfg.httpPort));
  }

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
      // The app launcher entry Discord adds once Activities are enabled. In the workshop channel it
      // opens the shared editor; anywhere else there is nothing for it to open.
      if (interaction.isPrimaryEntryPointCommand()) {
        if (workshopHtml && cfg.workshopChannelId && interaction.channelId === cfg.workshopChannelId) {
          await interaction.launchActivity();
          return;
        }
        await interaction.reply({ content: 'The shared PuzzleScript editor is still being tested and is not open yet.', flags: MessageFlags.Ephemeral });
        return;
      }
      if (interaction.isChatInputCommand() && interaction.commandName === 'play') {
        const gistId = parseGistId(interaction.options.getString('game', true));
        const levelNumber = interaction.options.getInteger('level') || 1;
        if (!gistId) {
          await interaction.reply({ content: 'that does not look like a gist id or a play link', flags: MessageFlags.Ephemeral });
          return;
        }
        const t0 = Date.now();
        await interaction.deferReply();
        console.log('play deferred', Date.now() - t0, 'ms');
        const reply = await interaction.fetchReply();
        try {
          const { record, snapshot } = await registry.start({ gameId: reply.id, channelId: interaction.channelId, gistId, startLevelNumber: levelNumber });
          console.log('play started', Date.now() - t0, 'ms');
          if (record.meta.flags.realtime) {
            registry.markDead(record.gameId, 'realtime game');
            await interaction.editReply({ content: 'realtime games cannot be played here (this one sets realtime_interval)' });
            return;
          }
          await interaction.editReply(frame(record, snapshot, null, canTweak(interaction), null));
          console.log('play edited', Date.now() - t0, 'ms');
        } catch (err) {
          await interaction.editReply({ content: userMessage(err, 'start') });
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
      if (interaction.isChatInputCommand() && interaction.commandName === 'role') {
        const choice = interaction.options.getString('keyword', true);
        if (!interaction.inCachedGuild()) {
          await interaction.reply({ content: 'roles can only be set inside the server', flags: MessageFlags.Ephemeral });
          return;
        }
        const plan = planRoleChange(choice, [...interaction.guild.roles.cache.values()], [...interaction.member.roles.cache.keys()]);
        if (!plan.ok) {
          const why = plan.reason === 'missing' ? 'there is no role named ' + choice + ' on this server' : 'that is not one of the keyword roles';
          await interaction.reply({ content: why, flags: MessageFlags.Ephemeral });
          return;
        }
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        try {
          await applyRoleChange(interaction.member.roles, plan);
          let done;
          if (plan.keyword === null) done = plan.remove.length ? 'Your keyword role has been removed.' : 'You have no keyword role to remove.';
          else done = plan.add.length ? 'Your keyword role is now ' + plan.keyword + '.' : 'You already have ' + plan.keyword + '.';
          await interaction.editReply({ content: done });
        } catch (err) {
          console.error('role change failed', 'code', err && err.code, err);
          // 50013 is Discord's Missing Permissions: no Manage Roles, or the role sits above the bot's own.
          const why = err && err.code === 50013 ? 'I am not allowed to manage that role (it has to sit below my own role, and I need Manage Roles)' : 'something went wrong';
          await interaction.editReply({ content: why });
        }
        return;
      }
      if (interaction.isButton()) {
        const action = parseCustomId(interaction.customId);
        if (!action) return;
        const gameId = interaction.message.id;
        if (action === 'tweak') {
          const rec = registry.get(gameId);
          if (!canTweak(interaction) || !rec) {
            await interaction.reply({ content: rec ? 'the level editor is not available here' : 'this game is no longer available', flags: MessageFlags.Ephemeral });
            return;
          }
          // What is to be edited: a sent level as it was sent, or the level this game is on as its
          // author wrote it. Either way the new level is made for the same game.
          const sent = levelOf(rec);
          pending.set(interaction.user.id, Object.assign({
            gistId: rec.gistId,
            title: (rec.meta && rec.meta.title) || 'PuzzleScript game',
            channelId: interaction.channelId,
            gameId,
            authorName: displayName(interaction),
          }, sent
            ? { levelId: sent.id, baseSourceHash: sent.baseSourceHash }
            : { levelIndex: rec.cur ? rec.cur.levelIndex : rec.startLevel, baseSourceHash: rec.sourceHash }));
          // The only answer: Discord allows three seconds, and a launch cannot be deferred.
          await interaction.launchActivity();
          return;
        }
        const t0 = Date.now();
        console.log('press', action, gameId, 'gateway-lag', t0 - interaction.createdTimestamp, 'ms');
        if (!registry.get(gameId)) {
          await interaction.reply({ content: 'this game is no longer available', flags: MessageFlags.Ephemeral });
          return;
        }
        await interaction.deferUpdate();
        console.log('ack', Date.now() - t0, 'ms');
        try {
          const { record, snapshot, applied, solvedLevel, gif } = action === 'again'
            ? await registry.again(gameId)
            : await registry.press(gameId, action, displayName(interaction));
          console.log('applied', applied, gif ? 'gif ' + gif.length + ' bytes' : 'still', Date.now() - t0, 'ms');
          const solved = solvedLevel !== null && solvedLevel !== undefined;
          // A sent level lists its solvers on its own message, so they are noted before it is drawn.
          if (solved && record.levelId) levelStore.addSolver(record.levelId, { id: interaction.user.id, name: displayName(interaction) });
          await enqueueEdit(gameId, () => interaction.editReply(frame(record, snapshot, gif, canTweak(interaction), levelOf(record))));
          console.log('edited', Date.now() - t0, 'ms');
          // Ranks are for the games' own levels: a sent level could be made trivial to gain rank.
          if (solved && !record.levelId) {
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
  const shutdown = async () => { await registry.close(); await pool.close(); if (workshopDoc) workshopDoc.close(); if (httpServer) await httpServer.close(); client.destroy(); process.exit(0); };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  await client.login(cfg.discordToken);
}

main().catch((e) => { console.error(e); process.exit(1); });
