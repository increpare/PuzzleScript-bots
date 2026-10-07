'use strict';
const { createHost } = require('./engine-host');
const { buildAnimation } = require('./animation');

function spin(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) { /* busy wait, test only */ }
}

// What a worker does with each job. It is kept apart from the thread plumbing in worker.js so that
// it can be tested directly.
// totalMs: the budget for one move's whole chain of again turns (see engine-host).
// ping:    called while a job is getting somewhere, so that the pool knows it is not stuck.
function createOps({ totalMs = Infinity, ping = () => {}, now = Date.now, animate = buildAnimation, log = console.error } = {}) {
  const hosts = new Map();
  const newHost = () => createHost({ totalMs, onStep: ping, now });

  function need(gameId) {
    const host = hosts.get(gameId);
    if (!host) throw Object.assign(new Error('no such game'), { name: 'NoGameError' });
    return host;
  }

  return function handle({ op, gameId, args }) {
    switch (op) {
      case 'load': {
        const host = hosts.get(gameId) || newHost();
        const meta = host.load(args.source, args.seed, args.levelIndex, { rebuild: !!args.rebuild });
        hosts.set(gameId, host);
        return meta;
      }
      case 'apply': {
        need(gameId).replay(args.actions);
        return null;
      }
      case 'input': {
        return need(gameId).input(args.action);
      }
      // One move, the picture it leaves, and (when asked) an animation of the turns it took.
      case 'play': {
        const host = need(gameId);
        let applied;
        try {
          applied = host.input(args.action, { capture: !!args.animate });
        } catch (e) {
          // the game is part-way through a move: it cannot be used again, only rebuilt
          host.dispose();
          hosts.delete(gameId);
          throw e;
        }
        const snapshot = host.snapshot();
        const frames = host.takeFrames();
        let gif = null;
        if (applied && frames) {
          // the move has been made whatever happens here: without an animation the still is shown
          try { gif = animate({ base: snapshot, frames, onProgress: ping }); } catch (e) { log('animation failed:', e && e.stack || e); }
        }
        return { applied, snapshot, gif };
      }
      case 'snapshot': {
        return need(gameId).snapshot();
      }
      case 'tiles': {
        return need(gameId).frameTiles();
      }
      case 'levelText': {
        return need(gameId).levelText();
      }
      case 'drop': {
        const host = hosts.get(gameId);
        if (host) host.dispose();
        hosts.delete(gameId);
        return null;
      }
      case '__spin': {
        spin(args.ms);
        return null;
      }
      case '__steps': { // test only: work that keeps reporting progress, then (if asked) stops reporting
        for (let i = 0; i < args.count; i++) { spin(args.ms); ping(); }
        if (args.thenSilentMs) spin(args.thenSilentMs);
        return null;
      }
      default:
        throw new Error('unknown op ' + op);
    }
  };
}

module.exports = { createOps };
