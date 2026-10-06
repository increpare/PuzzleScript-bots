'use strict';
const { parentPort } = require('node:worker_threads');
const { createHost } = require('./engine-host');

const hosts = new Map();

function handle(msg) {
  const { op, gameId, args } = msg;
  switch (op) {
    case 'load': {
      const host = hosts.get(gameId) || createHost();
      const meta = host.load(args.source, args.seed, args.levelIndex);
      hosts.set(gameId, host);
      return meta;
    }
    case 'apply': {
      const host = hosts.get(gameId);
      if (!host) throw Object.assign(new Error('no such game'), { name: 'NoGameError' });
      host.replay(args.actions);
      return null;
    }
    case 'input': {
      const host = hosts.get(gameId);
      if (!host) throw Object.assign(new Error('no such game'), { name: 'NoGameError' });
      return host.input(args.action);
    }
    case 'snapshot': {
      const host = hosts.get(gameId);
      if (!host) throw Object.assign(new Error('no such game'), { name: 'NoGameError' });
      return host.snapshot();
    }
    case 'drop': {
      const host = hosts.get(gameId);
      if (host) host.dispose();
      hosts.delete(gameId);
      return null;
    }
    case '__spin': {
      const end = Date.now() + args.ms;
      while (Date.now() < end) { /* busy wait, test only */ }
      return null;
    }
    default:
      throw new Error('unknown op ' + op);
  }
}

parentPort.on('message', (msg) => {
  try {
    const result = handle(msg);
    parentPort.postMessage({ id: msg.id, ok: true, result });
  } catch (e) {
    parentPort.postMessage({ id: msg.id, ok: false, error: { name: e && e.name || 'Error', message: String(e && e.message || e) } });
  }
});
