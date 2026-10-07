'use strict';
const { loadConfig } = require('./config');
const { createChat } = require('./chat');
const { createRotation } = require('./rotation');
const { createSession } = require('./session');
const { composeFrame } = require('./frame');
const { createMusic, loadIndex } = require('./music');
const { createEncoder } = require('./encoder');
const { createPool } = require('../discord-bot/pool');
const { createSourceStore } = require('../discord-bot/sources');
const { createGistStore } = require('../discord-bot/gists');
const { loadGallery } = require('../discord-bot/gallery');

const SESSION_TICK_MS = 500;

// Everything except chat and GitHub, which the end-to-end test replaces.
function createApp({ cfg, gallery, getSource, log = console.log }) {
  const pool = createPool({ size: 1 });
  const rotation = createRotation({ gallery, dataDir: cfg.dataDir });
  const index = loadIndex(cfg.dataDir);
  if (!index) log('no music index (run: node index-music.js); the stream will be silent');
  let session = null, encoder = null, music = null, ticker = null;

  // The picture changes only when the game, the votes or the music change, so that is when it is redrawn.
  const refresh = () => {
    if (!session || !encoder || !music) return;
    try {
      encoder.setFrame(composeFrame(Object.assign(session.view(), { music: music.current() })).rgba);
    } catch (e) { log('could not draw the frame', e); }
  };

  music = createMusic({ index, onTrack: refresh, log });
  encoder = createEncoder({ output: cfg.output, secrets: [cfg.streamKey].filter(Boolean), minFps: cfg.minFps, readAudio: music.read, log });
  session = createSession({ pool, getSource, rotation, onChange: refresh, log });

  return {
    session,
    async start() {
      music.start();
      refresh(); // "back soon" until the first game has loaded
      encoder.start();
      ticker = setInterval(() => session.tick(), SESSION_TICK_MS);
      await session.start();
    },
    async stop() {
      if (ticker) { clearInterval(ticker); ticker = null; }
      music.stop();
      await encoder.stop();
      await pool.close();
    },
  };
}

async function main() {
  const cfg = loadConfig();
  const sources = createSourceStore({ dataDir: cfg.dataDir });
  const gists = createGistStore({ dataDir: cfg.dataDir, token: cfg.githubToken, sources });
  const app = createApp({ cfg, gallery: loadGallery(), getSource: gists.getSource });
  const chat = createChat({ channel: cfg.channel, onMessage: (m) => app.session.handleChat(m) });
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    chat.close();
    await app.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  await app.start();
  chat.start();
  console.log('streaming; reading chat in #' + cfg.channel); // never log cfg.output: it contains the stream key
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });

module.exports = { createApp };
